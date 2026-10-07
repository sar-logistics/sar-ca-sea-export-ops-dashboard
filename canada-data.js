import { MongoClient } from 'mongodb';

// Canada Sea Ops — read-only data route for index.html
//   GET → { fields, rows, meta } from ca_ops_export / ca_ops_import
// Data is written by python/ca_sheets_to_mongo.py (direct to MongoDB).

const uri    = process.env.MONGO_URI;
const DB     = process.env.MONGO_DB || undefined;   // undefined → database named in MONGO_URI
const COLS   = { Export: 'ca_ops_export', Import: 'ca_ops_import' };
const TTL_MS = 15 * 60 * 1000; // 15 min

// Field order sent to the browser — must match caExpand() in index.html
const FIELDS = [
  'shipmentId', 'direction', 'jobDate', 'periodDate', 'etd', 'eta',
  'branch', 'zone', 'tradeLane', 'jobOwner', 'salesPerson', 'customer',
  'carrierName', 'vessel', 'origin', 'destination', 'mblNumber', 'houseRef', 'consolId',
  'cargoType', 'containerTeu', 'consigneeName', 'consignorName', 'incoterm',
  'provisionalRevenue', 'billedRevenue', 'unbilledRevenue',
  'provisionalCost', 'postedCost', 'unpostedCost', 'actualProfit',
  'operationLock', 'financialLock', 'jobStatus', 'isOpen'
];

let mongoClient;
async function getClient() {
  if (!mongoClient) {
    mongoClient = new MongoClient(uri, { maxPoolSize: 5, socketTimeoutMS: 45000 });
    await mongoClient.connect();
  }
  return mongoClient;
}

let cache = { payload: null, builtAt: null };

async function buildCache(db) {
  console.log('[CA-OPS] Building cache...');
  const proj    = { projection: { _id: 0 } };
  const expDocs = await db.collection(COLS.Export).find({}, proj).toArray();
  const impDocs = await db.collection(COLS.Import).find({}, proj).toArray();
  const all     = [...expDocs, ...impDocs];
  // Compact rows (no repeated keys) keep the response well under Vercel's 4.5 MB limit
  const rows    = all.map(d => FIELDS.map(f => (d[f] === undefined ? '' : d[f])));
  const syncedAt = all.reduce((m, d) => (d.syncedAt && d.syncedAt > m ? d.syncedAt : m), '');
  console.log(`[CA-OPS] Export: ${expDocs.length}, Import: ${impDocs.length}`);
  cache = {
    payload: { fields: FIELDS, rows, meta: { jobs: rows.length, export: expDocs.length, import: impDocs.length, generatedAt: syncedAt } },
    builtAt: new Date().toISOString()
  };
  return cache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (req.query && req.query.ping) return res.status(200).json({ ok: true });
    try {
      const force = req.query && req.query.forceRefresh === '1';
      if (force || !cache.payload || !cache.builtAt || (Date.now() - new Date(cache.builtAt)) > TTL_MS) {
        await buildCache((await getClient()).db(DB));
        res.setHeader('X-Cache', 'MISS');
      } else {
        res.setHeader('X-Cache', 'HIT');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Cache-Age', Math.floor((Date.now() - new Date(cache.builtAt)) / 1000));
      return res.status(200).json(cache.payload);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
