// GET /api/profiles
// Returns profiles from the Book Intro list joined in the last 30 days
import { klaviyoFetch, interestToTag } from './_klaviyo.js';

export default async function handler(req, res) {
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  const listId = process.env.KLAVIYO_LIST_ID;

  if (!apiKey || !listId) {
    return res.status(503).json({ ok: false, error: 'Server is missing Klaviyo configuration.' });
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString();

  // Note: on /api/lists/{id}/profiles, 'updated' is not filterable.
  // Allowed filter fields: _kx, email, joined_group_at, phone_number, push_token.
  const filter = `greater-than(joined_group_at,${cutoff})`;
  const path = `/api/lists/${listId}/profiles?filter=${encodeURIComponent(filter)}&page[size]=100&sort=-joined_group_at`;

  const { ok, status, data } = await klaviyoFetch(path, apiKey);

  if (!ok) {
    return res.status(status).json({
      ok: false,
      error: data?.errors?.[0]?.detail || 'Failed to fetch profiles from Klaviyo.',
    });
  }

  const profiles = (data?.data || []).map(p => {
    const attrs = p.attributes || {};
    const props = attrs.properties || {};
    const interest = props.omnia_interest || '';
    const notes = props.omnia_life_notes || '';
    const firstName = attrs.first_name || '';
    const lastName = attrs.last_name || '';
    const name = `${firstName} ${lastName}`.trim() || attrs.email || 'Unknown';
    const created = attrs.created || attrs.updated;
    const formMsg = notes
      ? `Interested in: ${interest}\n\n"${notes}"`
      : `Interested in: ${interest}`;
    return {
      id: p.id,
      name,
      phone: attrs.phone_number || '',
      email: attrs.email || '',
      tags: [interestToTag(interest)],
      channels: ['sms', 'email'],
      unread: true,
      lastMsg: interest || 'New lead',
      lastTime: formatTime(created),
      created,
      msgs: [{ dir: 'in', ch: 'form', text: formMsg, time: formatTime(created) }],
    };
  });

  return res.status(200).json({ ok: true, profiles });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isYesterday) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
