const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TRIAL_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 8;
const MAX_VERIFY_ATTEMPTS = 5;
const SESSION_COOKIE = 'codeoflife_trial';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

export function trialsConfigured(env) {
  return env.TRIALS_ENABLED === 'true' && !!env.TRIAL_DB && !!env.SESSION_SECRET;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validEmail(email) {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
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

export async function codeHash(env, email, code) {
  return bytesToHex(await hmac(env.SESSION_SECRET, `${email}:${code}`));
}

export function generateCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, '0');
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

export async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true;
}

export async function sendTrialEmail(env, email, code) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Email service is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Your Code of Life trial code',
      html: `<div style="font-family:Georgia,serif;color:#111827"><h2>Your trial code</h2><p>Enter this code to begin your seven-day Code of Life trial:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes.</p></div>`,
      text: `Your Code of Life trial code is ${code}. It expires in 10 minutes.`
    })
  });
  if (!response.ok) throw new Error(`Email delivery failed (${response.status})`);
}

export {
  CODE_LIFETIME_MS,
  MAX_SENDS_PER_WINDOW,
  MAX_VERIFY_ATTEMPTS,
  SEND_COOLDOWN_MS,
  SEND_WINDOW_MS,
  TRIAL_LENGTH_MS
};
