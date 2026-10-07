import { MongoClient } from 'mongodb';

// Canada Sea Ops — dashboard data route (same role as the Thailand mongo-batch.js)
//   GET                                                   → { fields, rows, meta, users, builtAt }
//   POST (x-batch-secret) { action:'wipe', direction }    → clears ca_ops_export / ca_ops_import
//   POST (x-batch-secret) { action:'push', direction, records } → inserts a chunk (optional path;
//        the daily Apps Script push uses /api/mongo bulkWrite instead)

const uri    = process.env.MONGO_URI;
const SECRET = process.env.BATCH_SECRET;
const DB     = process.env.MONGO_DB || undefined;   // undefined → database in the URI (sar-id-ops)
const COLS   = { Export: 'ca_ops_export', Import: 'ca_ops_import' };
const TTL_MS = 15 * 60 * 1000;                       // 15 min (Refresh button bypasses it)

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
  const proj     = { projection: { _id: 0 } };
  const expDocs  = await db.collection(COLS.Export).find({}, proj).toArray();
  const impDocs  = await db.collection(COLS.Import).find({}, proj).toArray();
  const userDocs = await db.collection('users').find({}).toArray();
  const all      = [...expDocs, ...impDocs];
  // Compact rows (no repeated keys) keep the response well under Vercel's 4.5 MB limit
  const rows     = all.map(d => FIELDS.map(f => (d[f] === undefined ? '' : d[f])));
  const syncedAt = all.reduce((m, d) => (d.syncedAt && d.syncedAt > m ? d.syncedAt : m), '');
  console.log(`[CA-OPS] Export: ${expDocs.length}, Import: ${impDocs.length}, users: ${userDocs.length}`);
  cache = {
    payload: {
      fields: FIELDS, rows,
      meta: { jobs: rows.length, export: expDocs.length, import: impDocs.length, generatedAt: syncedAt },
      users: userDocs
    },
    builtAt: new Date().toISOString()
  };
  return cache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-batch-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const secret = req.headers['x-batch-secret'];
    if (!SECRET || secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { action, records, direction } = req.body || {};
    const colName = COLS[direction];
    if (!colName) return res.status(400).json({ error: 'Invalid direction' });

    try {
      const db = (await getClient()).db(DB);
      if (action === 'wipe') {
        const result = await db.collection(colName).deleteMany({});
        cache = { payload: null, builtAt: null };
        return res.status(200).json({ deleted: result.deletedCount, direction });
      }
      if (action === 'push') {
        if (!records || !records.length) return res.status(400).json({ error: 'No records' });
        const result = await db.collection(colName).insertMany(records, { ordered: false });
        cache = { payload: null, builtAt: null };
        return res.status(200).json({ inserted: result.insertedCount, direction });
      }
      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

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
      return res.status(200).json({ ...cache.payload, builtAt: cache.builtAt });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
