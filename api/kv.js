// api/kv.js — Upstash KV for contact classifications + archive status
// Env vars auto-injected by Vercel/Upstash: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const KV_URL   = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kv(command, ...args) {
  const res = await fetch(`${KV_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const json = await res.json();
  return json.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { profileId } = req.query;

  // GET /api/kv?profileId=xxx — get contact metadata
  if (req.method === 'GET' && profileId) {
    const raw = await kv('get', `contact:${profileId}`);
    return res.json(raw ? JSON.parse(raw) : {});
  }

  // GET /api/kv — get ALL contact metadata (for bulk load on dashboard init)
  if (req.method === 'GET') {
    const keys = await kv('keys', 'contact:*');
    if (!keys || keys.length === 0) return res.json({});
    const result = {};
    for (const key of keys) {
      const raw = await kv('get', key);
      if (raw) {
        const id = key.replace('contact:', '');
        result[id] = JSON.parse(raw);
      }
    }
    return res.json(result);
  }

  // POST /api/kv — set contact metadata
  if (req.method === 'POST') {
    const body = req.body;
    if (!body.profileId) return res.status(400).json({ error: 'profileId required' });
    const existing = await kv('get', `contact:${body.profileId}`);
    const current = existing ? JSON.parse(existing) : {};
    const updated = { ...current, ...body, updatedAt: new Date().toISOString() };
    await kv('set', `contact:${body.profileId}`, JSON.stringify(updated));
    return res.json(updated);
  }

  // DELETE /api/kv?profileId=xxx — remove contact metadata
  if (req.method === 'DELETE' && profileId) {
    await kv('del', `contact:${profileId}`);
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
