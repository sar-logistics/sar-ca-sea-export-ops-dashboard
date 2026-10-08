import { MongoClient } from 'mongodb';

// Canada Sea Ops — dashboard data route (same contract as the USA / Thailand mongo-batch.js)
//   GET                                                     → { records, users, builtAt }
//   POST (x-batch-secret) { action:'wipe', direction }      → clears ca_ops_export / ca_ops_import
//   POST (x-batch-secret) { action:'push', direction, records } → inserts a chunk (CanadaOpsPush.gs)
//   POST (x-batch-secret) { action:'wipe'|'push', collection:'estimatedvsactual', records }
//        → charge-level ETD/ETA tab (CanadaEstVsActPush.gs); only whitelisted collections allowed

const uri    = process.env.MONGO_URI;
const SECRET = process.env.BATCH_SECRET;
const DB     = process.env.MONGO_DB || undefined;   // undefined → database in the URI (sar-ca-ops)
const COLS   = { Export: 'ca_ops_export', Import: 'ca_ops_import' };
const EXTRA_COLLECTIONS = new Set(['estimatedvsactual']);   // writable by name via POST
const TTL_MS = 15 * 60 * 1000;                       // 15 min (Refresh button bypasses it)

// Empty cells are dropped from each record to keep the response well under Vercel's 4.5 MB limit.
// These keys are always kept because the dashboard checks for their presence.
const ALWAYS_KEEP = new Set(['shipmentId', 'direction', 'lob', 'jobDate', 'periodDate', 'isOpen', 'jobStatus', 'jobOwner']);
function compact(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    if (!ALWAYS_KEEP.has(k) && (v === '' || v === null || v === undefined)) continue;
    out[k] = v;
  }
  return out;
}

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
  const expDocs  = await db.collection(COLS.Export).find({}).toArray();
  const impDocs  = await db.collection(COLS.Import).find({}).toArray();
  const userDocs = await db.collection('users').find({}).toArray();
  const records  = [...expDocs, ...impDocs].map(compact);
  console.log(`[CA-OPS] Export: ${expDocs.length}, Import: ${impDocs.length}, users: ${userDocs.length}`);
  cache = { payload: { records, users: userDocs }, builtAt: new Date().toISOString() };
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

    const { action, records, direction, collection } = req.body || {};
    const colName = collection
      ? (EXTRA_COLLECTIONS.has(collection) ? collection : null)
      : COLS[direction];
    if (!colName) return res.status(400).json({ error: collection ? 'Collection not allowed: ' + collection : 'Invalid direction' });

    try {
      const db = (await getClient()).db(DB);
      if (action === 'wipe') {
        const result = await db.collection(colName).deleteMany({});
        cache = { payload: null, builtAt: null };
        return res.status(200).json({ deleted: result.deletedCount, collection: colName });
      }
      if (action === 'push') {
        if (!records || !records.length) return res.status(400).json({ error: 'No records' });
        const result = await db.collection(colName).insertMany(records, { ordered: false });
        cache = { payload: null, builtAt: null };
        return res.status(200).json({ inserted: result.insertedCount, collection: colName });
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
