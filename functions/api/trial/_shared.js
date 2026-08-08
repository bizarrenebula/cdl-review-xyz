const TRIAL_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'codeoflife_trial';
const TRIAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

export function trialsConfigured(env) {
  return env.TRIALS_ENABLED === 'true' && !!env.TRIAL_DB && !!env.SESSION_SECRET;
}

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmac(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
}

export function normalizeTrialCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function codeHash(env, code) {
  return bytesToHex(await hmac(env.SESSION_SECRET, `trial-code:${normalizeTrialCode(code)}`));
}

export async function identifierHash(env, value) {
  return bytesToHex(await hmac(env.SESSION_SECRET, `identifier:${value}`));
}

export function generateTrialCode() {
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  const compact = [...values].map(value => TRIAL_CODE_ALPHABET[value % TRIAL_CODE_ALPHABET.length]).join('');
  return compact.match(/.{1,4}/g).join('-');
}

export async function createSession(env, user) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    sub: user.id,
    exp: user.trial_end_at
  })));
  const signature = bytesToBase64Url(await hmac(env.SESSION_SECRET, payload));
  return `${payload}.${signature}`;
}

export async function readSession(env, request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, signature] = match[1].split('.');
  if (!payload || !signature) return null;
  try {
    const expected = new Uint8Array(await hmac(env.SESSION_SECRET, payload));
    const received = base64UrlToBytes(signature);
    if (expected.length !== received.length) return null;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index++) mismatch |= expected[index] ^ received[index];
    if (mismatch) return null;
    const decoded = new TextDecoder().decode(base64UrlToBytes(payload));
    const session = JSON.parse(decoded);
    if (!session.sub || !Number.isFinite(session.exp)) return null;
    return session;
  } catch {
    return null;
  }
}

export function sessionCookie(request, token, trialEnd) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  /* Keep the identity cookie after the seven-day window so the server can
     continue returning `expired` instead of presenting a fresh signup gate. */
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

export { TRIAL_LENGTH_MS };
