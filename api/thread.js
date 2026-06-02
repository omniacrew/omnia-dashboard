// api/thread.js — Fetch SMS conversation thread from the Events API
// GET /api/thread?profileId=xxx
// Reads "Received SMS" (inbound) and "Sent SMS" (outbound) events for the profile.
// Works with a standard private API key (no Conversations API enablement needed).

const KLAVIYO_API_VERSION = '2026-04-15';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { profileId } = req.query;
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  if (!profileId) {
    return res.status(400).json({ error: 'profileId is required' });
  }
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing Klaviyo configuration.' });
  }

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_API_VERSION,
    Accept: 'application/json',
  };

  try {
    // Fetch recent events for this profile, newest first, with the metric included
    // so we can tell which events are SMS (and inbound vs outbound).
    const filter = encodeURIComponent(`equals(profile_id,"${profileId}")`);
    const url = `https://a.klaviyo.com/api/events/?filter=${filter}&include=metric&sort=-datetime&page[size]=50`;

    const eventsRes = await fetch(url, { headers });

    if (!eventsRes.ok) {
      const err = await eventsRes.json();
      return res.status(eventsRes.status).json({ error: 'Failed to fetch events', detail: err });
    }

    const data = await eventsRes.json();

    // Build a map of metric id -> metric name from the included metrics
    const metricNames = {};
    (data.included || []).forEach(inc => {
      if (inc.type === 'metric') {
        metricNames[inc.id] = inc.attributes?.name || '';
      }
    });

    // SMS-related metric names we care about
    // Inbound (from lead): "Received Inbound SMS" / "Consented to Receive SMS" varies;
    // the reliable inbound metric for replies is "Received Inbound SMS" or "Received SMS"
    // depending on account. We classify by name heuristics below.
    const messages = [];

    (data.data || []).forEach(ev => {
      const metricId = ev.relationships?.metric?.data?.id;
      const metricName = (metricNames[metricId] || '').toLowerCase();
      const props = ev.attributes?.event_properties || {};
      const datetime = ev.attributes?.datetime || ev.attributes?.timestamp || '';

      // Outbound: messages we sent (our "Dashboard SMS" event, or Klaviyo "Sent SMS")
      if (metricName.includes('dashboard sms')) {
        messages.push({
          id: ev.id,
          body: props.message || '',
          datetime,
          direction: 'outbound',
          channel: 'sms',
        });
      }
      // Inbound: replies from the lead
      else if (
        metricName.includes('received inbound sms') ||
        metricName.includes('inbound sms') ||
        (metricName.includes('received') && metricName.includes('sms') && !metricName.includes('automated'))
      ) {
        // Inbound SMS body is usually in event properties — field name varies
        const body =
          props.text || props.message || props.body || props['Message Body'] || props['message_body'] || '';
        messages.push({
          id: ev.id,
          body: body || '(inbound message)',
          datetime,
          direction: 'inbound',
          channel: 'sms',
        });
      }
    });

    // chronological order (oldest first)
    messages.sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0));

    return res.json({ messages, source: 'events' });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
