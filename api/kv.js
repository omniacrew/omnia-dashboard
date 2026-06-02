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

// api/thread.js — Fetch SMS conversation thread for a profile
// GET /api/thread?profileId=xxx&apiKey=xxx

const KLAVIYO_API_VERSION = '2026-04-15';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { profileId, apiKey } = req.query;
  if (!profileId || !apiKey) {
    return res.status(400).json({ error: 'profileId and apiKey are required' });
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
