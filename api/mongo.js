import { MongoClient } from 'mongodb';

// Canada Sea Ops — generic Mongo route used by index.html (auth, users, tickets, usage logs)
// and by Apps Script CanadaMongoPush.gs (bulkWrite / deleteMany).
// Database = the one named in MONGO_URI (e.g. sar-id-ops), unless MONGO_DB is set.

const uri    = process.env.MONGO_URI;
const DB     = process.env.MONGO_DB || undefined;     // undefined → database in the URI
const SECRET = process.env.BATCH_SECRET;              // required for bulk actions (Apps Script)

// Bulk actions are only used by the Apps Script push, never by the browser → require the secret
const PROTECTED = new Set(['bulkWrite', 'deleteMany']);

let client;
async function getClient() {
  if (!client) { client = new MongoClient(uri, { maxPoolSize: 5, socketTimeoutMS: 45000 }); await client.connect(); }
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-batch-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, collection, filter = {}, update, document, documents, limit = 2000, skip = 0 } = req.body || {};
    if (!collection) return res.status(400).json({ error: 'collection is required' });

    if (PROTECTED.has(action)) {
      const secret = req.headers['x-batch-secret'];
      if (!SECRET || secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    const c   = await getClient();
    const db  = c.db(DB);
    const col = db.collection(collection);

    if (action === 'find')      { const docs = await col.find(filter).skip(skip).limit(limit).toArray(); return res.status(200).json({ documents: docs }); }
    if (action === 'findOne')   { const doc  = await col.findOne(filter); return res.status(200).json({ document: doc }); }
    if (action === 'insertOne') { const r = await col.insertOne(document); return res.status(200).json({ insertedId: r.insertedId }); }
    if (action === 'updateOne') { const r = await col.updateOne(filter, update, { upsert: true }); return res.status(200).json({ result: r }); }
    if (action === 'deleteOne') { const r = await col.deleteOne(filter); return res.status(200).json({ result: r }); }
    if (action === 'countDocuments') { const n = await col.countDocuments(filter); return res.status(200).json({ count: n }); }

    if (action === 'bulkWrite') {
      if (!Array.isArray(documents) || !documents.length) return res.status(400).json({ error: 'No documents' });
      const ops = documents.map(d => {
        const { _id, ...rest } = d;                     // never try to overwrite _id
        return { updateOne: { filter: { shipmentId: rest.shipmentId }, update: { $set: rest }, upsert: true } };
      });
      const r = await col.bulkWrite(ops, { ordered: false });
      return res.status(200).json({ result: { upsertedCount: r.upsertedCount, modifiedCount: r.modifiedCount, matchedCount: r.matchedCount } });
    }
    if (action === 'deleteMany') {
      if (!filter || !Object.keys(filter).length) return res.status(400).json({ error: 'deleteMany needs a filter' });   // no accidental wipe
      const r = await col.deleteMany(filter);
      return res.status(200).json({ result: { deletedCount: r.deletedCount } });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
