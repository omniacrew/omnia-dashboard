// Shared Klaviyo API helper for serverless functions
const KLAVIYO_BASE = 'https://a.klaviyo.com';
const REVISION = '2026-04-15';

export function klaviyoHeaders(apiKey) {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };
}

export async function klaviyoFetch(path, apiKey, init = {}) {
  const res = await fetch(`${KLAVIYO_BASE}${path}`, {
    ...init,
    headers: { ...klaviyoHeaders(apiKey), ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch {} }
  return { ok: res.ok, status: res.status, data };
}

// Map omnia_interest values from form to our internal tags
export function interestToTag(interest) {
  if (!interest) return 'general';
  const i = interest.toLowerCase();
  if (i.includes('membership')) return 'membership';
  if (i.includes('personal training') || i.includes('jacked')) return 'pt';
  if (i.includes('nutrition')) return 'nutrition';
  return 'general';
}
