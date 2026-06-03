// api/search-profiles.js — Search existing Klaviyo profiles by name, email, or phone
// GET /api/search-profiles?q=...
// - email (contains "@")  -> exact equals filter (fast)
// - phone (digits/+)      -> normalized E.164 equals filter (fast)
// - name (anything else)  -> server-side fetch + case-insensitive substring match
// Returns matches with SMS consent status.

const KLAVIYO_API_VERSION = '2026-04-15';

function normalizePhone(raw) {
  const digits = (raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.trim().startsWith('+')) return `+${digits}`;
  return `+${digits}`;
}

function shapeProfile(p) {
  const a = p.attributes || {};
  const sms = a.subscriptions?.sms || {};
  const smsMarketing = sms.marketing?.consent || null;
  const smsTransactional = sms.transactional?.consent || null;
  const smsReady = smsMarketing === 'SUBSCRIBED' || smsTransactional === 'SUBSCRIBED';
  const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || a.phone_number || 'Unknown';
  return {
    id: p.id,
    name,
    first_name: a.first_name || '',
    last_name: a.last_name || '',
    email: a.email || '',
    phone: a.phone_number || '',
    smsReady,
    smsConsent: smsMarketing,
    smsTransactional,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q } = req.query;
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Search query (q) is required' });
  if (!apiKey) return res.status(500).json({ error: 'Server is missing Klaviyo configuration.' });

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_API_VERSION,
    Accept: 'application/json',
  };

  const query = q.trim();
  const isEmail = query.includes('@');
  const looksLikePhone = /^[\d\s()\-+.]+$/.test(query) && (query.replace(/[^\d]/g, '').length >= 7);

  try {
    // ── EMAIL or PHONE: exact server-side filter (fast) ──
    if (isEmail || looksLikePhone) {
      let filter;
      if (isEmail) {
        filter = `equals(email,"${query.toLowerCase()}")`;
      } else {
        const phone = normalizePhone(query);
        if (!phone) return res.status(400).json({ error: 'Could not parse phone number' });
        filter = `equals(phone_number,"${phone}")`;
      }
      const url = `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&additional-fields[profile]=subscriptions&page[size]=20`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const err = await r.json();
        return res.status(r.status).json({ error: 'Search failed', detail: err });
      }
      const data = await r.json();
      const results = (data.data || []).map(shapeProfile);
      return res.json({ results, query, type: isEmail ? 'email' : 'phone' });
    }

    // ── NAME: fetch pages and match case-insensitively in code ──
    // Klaviyo's profile endpoint doesn't reliably support name `contains` filtering,
    // so we page through profiles and match locally. Capped to keep it fast.
    const needle = query.toLowerCase();
    const matches = [];
    let nextUrl = `https://a.klaviyo.com/api/profiles/?additional-fields[profile]=subscriptions&page[size]=100&sort=-updated`;
    let pages = 0;
    const MAX_PAGES = 5; // up to ~500 most-recently-updated profiles

    while (nextUrl && pages < MAX_PAGES && matches.length < 25) {
      const r = await fetch(nextUrl, { headers });
      if (!r.ok) {
        const err = await r.json();
        return res.status(r.status).json({ error: 'Search failed', detail: err });
      }
      const data = await r.json();
      for (const p of (data.data || [])) {
        const a = p.attributes || {};
        const full = [a.first_name, a.last_name].filter(Boolean).join(' ').toLowerCase();
        if (full.includes(needle) ||
            (a.first_name || '').toLowerCase().includes(needle) ||
            (a.last_name || '').toLowerCase().includes(needle)) {
          matches.push(shapeProfile(p));
        }
      }
      nextUrl = data.links?.next || null;
      pages++;
    }

    return res.json({ results: matches, query, type: 'name', searchedPages: pages });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
