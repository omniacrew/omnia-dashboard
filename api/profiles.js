// GET /api/profiles
// Returns profiles from the Book Intro list created or updated in the last 30 days
import { klaviyoFetch, interestToTag } from './_klaviyo.js';

export default async function handler(req, res) {
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  const listId = process.env.KLAVIYO_LIST_ID;

  if (!apiKey || !listId) {
    return res.status(503).json({ ok: false, error: 'Server is missing Klaviyo configuration.' });
  }

  // Calculate "last 30 days" cutoff
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString();

  // Fetch profiles in the Book Intro list joined in the last 30 days.
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

  // Transform Klaviyo profile data into our dashboard format.
  // Filter out "soft inquiries" â newsletter signups without omnia_interest.
  // They share the Book Intro list but aren't actual leads.
  const profiles = (data?.data || [])
    .filter(p => {
      const props = p.attributes?.properties || {};
      const interest = (props.omnia_interest || '').trim();
      return interest !== '';
    })
    .map(p => {
    const attrs = p.attributes || {};
    const props = attrs.properties || {};
    const interest = props.omnia_interest || '';
    const notes = props.omnia_life_notes || '';
    const firstName = attrs.first_name || '';
    const lastName = attrs.last_name || '';
    const name = `${firstName} ${lastName}`.trim() || attrs.email || 'Unknown';
    const created = attrs.created || attrs.updated;

    // Build initial "message" from form submission
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
      msgs: [{
        dir: 'in',
        ch: 'form',
        text: formMsg,
        time: formatTime(created),
      }],
    };
  });

  return res.status(200).json({ ok: true, profiles });
}

function formatTime(iso) {
  if (!iso) return '';
  const tz = 'America/Denver';
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

  // Get date strings in Denver time for accurate same-day / yesterday comparison
  const denverDate = d.toLocaleDateString('en-US', { timeZone: tz });
  const todayDenver = now.toLocaleDateString('en-US', { timeZone: tz });
  const yesterdayDenver = yesterday.toLocaleDateString('en-US', { timeZone: tz });

  if (denverDate === todayDenver) {
    return d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  }
  if (denverDate === yesterdayDenver) return 'Yesterday';
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
}
