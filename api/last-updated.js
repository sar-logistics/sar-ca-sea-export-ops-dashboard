import { MongoClient } from 'mongodb';

// GET /api/last-updated → { lastUpdated: ISO string | null }
// When fresh data last arrived in this dashboard's database. Read by the SAR Systems Hub for the
// "Updated …" line on this dashboard's card. Returns a single timestamp, no data, so it needs no
// sign-in.

const uri = process.env.MONGO_URI;
const DB  = process.env.MONGO_DB || undefined;   // undefined → database in the URI, same as api/mongo.js
// Pushes insert fresh documents (api/mongo-batch.js) stamped with syncedAt by the Apps Script, so the
// newest _id in each collection carries that collection's latest push time.
const DATA_COLLECTIONS = ['ca_ops_export', 'ca_ops_import', 'ca_ops_air_export', 'ca_ops_air_import',
                          'ca_ops_road_export', 'ca_ops_general', 'estimatedvsactual'];

let client;
async function getClient() {
  if (!client) { client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 8000 }); await client.connect(); }
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const db = (await getClient()).db(DB);
    const newest = await Promise.all(DATA_COLLECTIONS.map((name) =>
      db.collection(name).find({}, { projection: { _id: 1, syncedAt: 1 } }).sort({ _id: -1 }).limit(1).next()));
    const times = newest.filter(Boolean).map((d) => {
      const synced = new Date(d.syncedAt).getTime();
      if (!isNaN(synced)) return synced;
      return d._id && typeof d._id.getTimestamp === 'function' ? d._id.getTimestamp().getTime() : NaN;
    }).filter((t) => !isNaN(t));
    return res.status(200).json({ lastUpdated: times.length ? new Date(Math.max(...times)).toISOString() : null });
  } catch (err) {
    console.error('last-updated:', err.message);
    return res.status(500).json({ lastUpdated: null });
  }
}
