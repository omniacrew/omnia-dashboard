// api/send-sms.js — Outbound SMS via Klaviyo Conversations API
// POST { profileId, message, apiKey }

const KLAVIYO_API_VERSION = '2026-04-15';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { profileId, message, apiKey } = req.body;
  if (!profileId || !message || !apiKey) {
    return res.status(400).json({ error: 'profileId, message, and apiKey are required' });
  }
  if (!message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  try {
    // Step 1: Get or create conversation for this profile
    const convRes = await fetch(
      `https://a.klaviyo.com/api/profiles/${profileId}/?include=conversation`,
      {
        headers: {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: KLAVIYO_API_VERSION,
          Accept: 'application/json',
        },
      }
    );

    if (!convRes.ok) {
      const err = await convRes.json();
      return res.status(convRes.status).json({ error: 'Failed to fetch profile', detail: err });
    }

    const profileData = await convRes.json();

    // Extract conversation ID from included data if present
    let conversationId = null;
    if (profileData.included) {
      const conv = profileData.included.find(i => i.type === 'conversation');
      if (conv) conversationId = conv.id;
    }

    // Step 2: Send the message
    const msgBody = {
      data: {
        type: 'conversation-message',
        attributes: {
          body: message.trim(),
        },
        relationships: {
          profile: {
            data: { type: 'profile', id: profileId }
          }
        }
      }
    };

    // If we have a conversation ID, attach it
    if (conversationId) {
      msgBody.data.relationships.conversation = {
        data: { type: 'conversation', id: conversationId }
      };
    }

    const sendRes = await fetch('https://a.klaviyo.com/api/conversation-messages/', {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: KLAVIYO_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(msgBody),
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      return res.status(sendRes.status).json({ error: 'Failed to send message', detail: err });
    }

    const sent = await sendRes.json();
    return res.json({ ok: true, message: sent.data });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
