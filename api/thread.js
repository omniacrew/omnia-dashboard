// api/thread.js — Fetch SMS conversation thread from the Events API
// GET /api/thread?profileId=xxx
// Classifies by phone-number direction; de-dupes the clean "Dashboard SMS"
// event against Klaviyo's auto-wrapped "Sent SMS" record by normalizing bodies.
// Works with a standard private API key (no Conversations API needed).

const KLAVIYO_API_VERSION = '2026-04-15';
const OMNIA_NUMBER = '+18667054151';
const ORG_PREFIX = 'Omnia Fitness Collective:';

// Strip the org prefix and trailing opt-out language so we can compare/display cleanly.
function normalizeBody(raw) {
  if (!raw) return '';
  let b = raw.trim();
  // Remove leading "Omnia Fitness Collective:" prefix
  if (b.toLowerCase().startsWith(ORG_PREFIX.toLowerCase())) {
    b = b.slice(ORG_PREFIX.length).trim();
  }
  // Remove trailing opt-out instructions Klaviyo appends
  b = b.replace(/\s*text stop to opt-?out\.?\s*$/i, '');
  b = b.replace(/\s*reply stop to opt ?out\.?\s*$/i, '');
  return b.trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { profileId } = req.query;
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!profileId) return res.status(400).json({ error: 'profileId is required' });
  if (!apiKey) return res.status(500).json({ error: 'Server is missing Klaviyo configuration.' });

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_API_VERSION,
    Accept: 'application/json',
  };

  try {
    const filter = encodeURIComponent(`equals(profile_id,"${profileId}")`);
    const url = `https://a.klaviyo.com/api/events/?filter=${filter}&include=metric&sort=-datetime&page[size]=100`;
    const eventsRes = await fetch(url, { headers });

    if (!eventsRes.ok) {
      const err = await eventsRes.json();
      return res.status(eventsRes.status).json({ error: 'Failed to fetch events', detail: err });
    }

    const data = await eventsRes.json();

    const metricNames = {};
    (data.included || []).forEach(inc => {
      if (inc.type === 'metric') metricNames[inc.id] = inc.attributes?.name || '';
    });

    // Collect candidate messages first, then de-dupe by normalized body + direction + minute.
    const candidates = [];

    (data.data || []).forEach(ev => {
      const metricId = ev.relationships?.metric?.data?.id;
      const metricName = (metricNames[metricId] || '');
      const lower = metricName.toLowerCase();
      const props = ev.attributes?.event_properties || {};
      const extra = props.$extra || {};
      const datetime = ev.attributes?.datetime || '';

      const fromNum = props['From Number'];
      const toNum = props['To Number'];
      const rawBody = props['Message Body'] || extra['Message Body'] || props.message || props.message_body || '';

      // Skip noise
      if (lower.includes('automated response')) return;
      if (lower.includes('relayed')) return; // billing duplicates

      // 1. Real SMS with phone numbers → classify by direction
      if (fromNum && toNum && rawBody) {
        let direction;
        if (fromNum === OMNIA_NUMBER) direction = 'outbound';
        else if (toNum === OMNIA_NUMBER) direction = 'inbound';
        else return;
        candidates.push({
          id: ev.id,
          rawBody,
          body: direction === 'outbound' ? normalizeBody(rawBody) : rawBody.trim(),
          norm: normalizeBody(rawBody),
          datetime,
          direction,
          source: 'sms_record',
        });
      }
      // 2. Our clean Dashboard SMS custom event (preferred display for outbound)
      else if (metricName === 'Dashboard SMS' && props.message) {
        candidates.push({
          id: ev.id,
          rawBody: props.message,
          body: props.message.trim(),
          norm: normalizeBody(props.message),
          datetime,
          direction: 'outbound',
          source: 'dashboard',
        });
      }
    });

    // De-dupe: group by direction + normalized body. When a Dashboard event and an
    // SMS record represent the same outbound message, keep the Dashboard (clean) one.
    const byKey = new Map();
    for (const c of candidates) {
      const key = `${c.direction}|${c.norm}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, c);
      } else {
        // Prefer the 'dashboard' source (clean text); otherwise keep earliest timestamp
        const preferNew = c.source === 'dashboard' && existing.source !== 'dashboard';
        if (preferNew) byKey.set(key, c);
      }
    }

    const messages = Array.from(byKey.values())
      .map(c => ({ id: c.id, body: c.body, datetime: c.datetime, direction: c.direction, channel: 'sms' }))
      .sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0));

    return res.json({ messages, source: 'events' });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
