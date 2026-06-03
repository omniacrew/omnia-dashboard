// api/search-profiles.js — Search existing Klaviyo profiles by email or phone
// GET /api/search-profiles?q=...
// Detects email vs phone, normalizes phone to E.164 (+1 default), returns matches
// with SMS consent status so the dashboard can warn before texting un-subscribed profiles.

const KLAVIYO_API_VERSION = '2026-04-15';

// Normalize a phone string to E.164 US format (+1XXXXXXXXXX) when possible.
function normalizePhone(raw) {
  const digits = (raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;          // 9255551234
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // 19255551234
  if (raw.trim().startsWith('+')) return `+${digits}`;     // already had +
  return `+${digits}`; // fallback
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

  // Build the Klaviyo filter
  let filter;
  if (isEmail) {
    filter = `equals(email,"${query.toLowerCase()}")`;
  } else {
    const phone = normalizePhone(query);
    if (!phone) return res.status(400).json({ error: 'Could not parse phone number' });
    filter = `equals(phone_number,"${phone}")`;
  }

  try {
    const url = `https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=20`;
    const r = await fetch(url, { headers });

    if (!r.ok) {
      const err = await r.json();
      return res.status(r.status).json({ error: 'Search failed', detail: err });
    }

    const data = await r.json();

    const results = (data.data || []).map(p => {
      const a = p.attributes || {};
      // SMS consent: check subscriptions.sms.marketing.consent === 'SUBSCRIBED'
      const smsConsent = a.subscriptions?.sms?.marketing?.consent || null;
      const smsTransactional = a.subscriptions?.sms?.transactional?.consent || null;
      const smsReady = smsConsent === 'SUBSCRIBED' || smsTransactional === 'SUBSCRIBED';
      const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || a.phone_number || 'Unknown';
      return {
        id: p.id,
        name,
        first_name: a.first_name || '',
        last_name: a.last_name || '',
        email: a.email || '',
        phone: a.phone_number || '',
        smsReady,
        smsConsent,
      };
    });

    return res.json({ results, query, type: isEmail ? 'email' : 'phone' });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
