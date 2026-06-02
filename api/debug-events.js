// api/debug-events.js — TEMPORARY diagnostic. Shows raw recent events + metric names
// for a profile so we can see the exact inbound-SMS metric name and body field.
// GET /api/debug-events?profileId=xxx   — DELETE THIS FILE after debugging.

const KLAVIYO_API_VERSION = '2026-04-15';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { profileId } = req.query;
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  if (!apiKey) return res.status(500).json({ error: 'missing key' });

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_API_VERSION,
    Accept: 'application/json',
  };

  const filter = encodeURIComponent(`equals(profile_id,"${profileId}")`);
  const url = `https://a.klaviyo.com/api/events/?filter=${filter}&include=metric&sort=-datetime&page[size]=20`;
  const r = await fetch(url, { headers });
  const data = await r.json();

  const metricNames = {};
  (data.included || []).forEach(inc => {
    if (inc.type === 'metric') metricNames[inc.id] = inc.attributes?.name;
  });

  // Simplified view: each event's metric name + its properties
  const simplified = (data.data || []).map(ev => ({
    metric: metricNames[ev.relationships?.metric?.data?.id] || '(unknown)',
    datetime: ev.attributes?.datetime,
    properties: ev.attributes?.event_properties || {},
  }));

  return res.json({ count: simplified.length, events: simplified });
}
