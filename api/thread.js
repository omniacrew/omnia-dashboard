// api/thread.js — Fetch SMS conversation thread for a profile
// GET /api/thread?profileId=xxx&apiKey=xxx

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

  try {
    // Fetch profile with conversation included
    const profileRes = await fetch(
      `https://a.klaviyo.com/api/profiles/${profileId}/?include=conversation`,
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

    // Find conversation in included
    let conversationId = null;
    if (profileData.included) {
      const conv = profileData.included.find(i => i.type === 'conversation');
      if (conv) conversationId = conv.id;
    }

    if (!conversationId) {
      // No conversation yet — return empty thread
      return res.json({ messages: [], conversationId: null });
    }

    // Fetch messages for this conversation
    const messagesRes = await fetch(
      `https://a.klaviyo.com/api/conversations/${conversationId}/conversation-messages/?sort=-datetime`,
      {
        headers: {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: KLAVIYO_API_VERSION,
          Accept: 'application/json',
        },
      }
    );

    if (!messagesRes.ok) {
      const err = await messagesRes.json();
      return res.status(messagesRes.status).json({ error: 'Failed to fetch messages', detail: err });
    }

    const messagesData = await messagesRes.json();

    // Normalize messages into a simple format
    const messages = (messagesData.data || []).map(m => ({
      id: m.id,
      body: m.attributes?.body || '',
      datetime: m.attributes?.datetime || m.attributes?.created_at || '',
      direction: m.attributes?.direction || 'outbound', // 'inbound' | 'outbound'
      status: m.attributes?.status || '',
      channel: m.attributes?.channel || 'sms',
    })).reverse(); // chronological order

    return res.json({ messages, conversationId });

  } catch (e) {
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
