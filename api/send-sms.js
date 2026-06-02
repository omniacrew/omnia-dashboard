// api/send-sms.js — Outbound SMS via Klaviyo custom event → Flow trigger
// POST { profileId, message }
// Fires a "Dashboard SMS" event on the profile. A Klaviyo Flow listens for this
// event and sends an SMS with body = {{ event.message }} from the toll-free number.

const KLAVIYO_API_VERSION = '2026-04-15';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { profileId, message } = req.body;
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;

  if (!profileId || !message) {
    return res.status(400).json({ error: 'profileId and message are required' });
  }
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing Klaviyo configuration.' });
  }
  if (!message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  try {
    // Step 1: Look up the profile's email + phone (Events API identifies by these)
    const profileRes = await fetch(
      `https://a.klaviyo.com/api/profiles/${profileId}/`,
      {
        headers: {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: KLAVIYO_API_VERSION,
          Accept: 'application/json',
        },
      }
    );

    if (!profileRes.ok) {
      const err = await profileRes.json();
      return res.status(profileRes.status).json({ error: 'Failed to fetch profile', detail: err });
    }

    const profileData = await profileRes.json();
    const attrs = profileData.data?.attributes || {};
    const email = attrs.email;
    const phone = attrs.phone_number;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Profile has no email or phone to identify it' });
    }

    // Step 2: Fire the custom event that triggers the flow
    const eventBody = {
      data: {
        type: 'event',
        attributes: {
          properties: {
            message: message.trim(),
            sent_via: 'dashboard',
          },
          metric: {
            data: {
              type: 'metric',
              attributes: { name: 'Dashboard SMS' },
            },
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                ...(email ? { email } : {}),
                ...(phone ? { phone_number: phone } : {}),
              },
              id: profileId,
            },
          },
        },
      },
    };

    const eventRes = await fetch('https://a.klaviyo.com/api/events/', {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: KLAVIYO_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(eventBody),
    });

    if (!eventRes.ok && eventRes.status !== 202) {
      const err = await eventRes.json();
      return res.status(eventRes.status).json({ error: 'Failed to trigger SMS flow', detail: err });
    }

    // Events API returns 202 Accepted with empty body on success
    return res.json({ ok: true, queued: true });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
