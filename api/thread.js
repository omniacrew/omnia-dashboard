// api/thread.js — Fetch SMS conversation thread from the Events API
// GET /api/thread?profileId=xxx
// Classifies messages by PHONE NUMBER direction, which is bulletproof:
//   - Our toll-free number = OMNIA_NUMBER
//   - If From = toll-free -> outbound (we sent it)
//   - If To   = toll-free -> inbound  (lead sent it)
// Also captures our "Dashboard SMS" custom events as outbound.
// Works with a standard private API key (no Conversations API needed).

const KLAVIYO_API_VERSION = '2026-04-15';
const OMNIA_NUMBER = '+18667054151';

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

    const messages = [];
    const seenBodies = new Set(); // de-dupe identical body+time

    (data.data || []).forEach(ev => {
      const metricId = ev.relationships?.metric?.data?.id;
      const metricName = (metricNames[metricId] || '');
      const props = ev.attributes?.event_properties || {};
      const extra = props.$extra || {};
      const datetime = ev.attributes?.datetime || '';

      const fromNum = props['From Number'];
      const toNum = props['To Number'];
      // Message body lives in different spots depending on event type
      const body = props['Message Body'] || extra['Message Body'] || props.message || props.message_body || '';

      // 1. Real SMS messages (Sent SMS / Received SMS metrics carry phone numbers)
      if (fromNum && toNum && body) {
        // Skip the auto-responder noise
        if (metricName.toLowerCase().includes('automated response')) return;
        if (metricName.toLowerCase().includes('relayed')) return; // billing dupes

        let direction;
        if (fromNum === OMNIA_NUMBER) direction = 'outbound'; // we sent to lead
        else if (toNum === OMNIA_NUMBER) direction = 'inbound'; // lead sent to us
        else return; // unrelated

        const key = `${direction}|${body}|${datetime}`;
        if (seenBodies.has(key)) return;
        seenBodies.add(key);

        messages.push({ id: ev.id, body, datetime, direction, channel: 'sms' });
      }
      // 2. Our Dashboard SMS custom events (the moment we queued an outbound)
      //    Only include if not already represented by a Sent SMS above — but since
      //    those have phone numbers and these don't, we de-dupe by body within a window.
      else if (metricName === 'Dashboard SMS' && props.message) {
        const key = `outbound|${props.message}`;
        // Skip if an identical outbound body already captured from a real Sent SMS
        const alreadyHave = messages.some(
          m => m.direction === 'outbound' && m.body === props.message
        );
        if (!alreadyHave && !seenBodies.has(key)) {
          seenBodies.add(key);
          messages.push({ id: ev.id, body: props.message, datetime, direction: 'outbound', channel: 'sms' });
        }
      }
    });

    messages.sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0));

    return res.json({ messages, source: 'events' });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
