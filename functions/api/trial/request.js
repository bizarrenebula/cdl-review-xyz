import {
  CODE_LIFETIME_MS, MAX_SENDS_PER_WINDOW, SEND_COOLDOWN_MS, SEND_WINDOW_MS,
  codeHash, generateCode, json, normalizeEmail, readJson, sendTrialEmail,
  trialsConfigured, validEmail, verifyTurnstile
} from './_shared.js';

export async function onRequestPost({ request, env }) {
  if (!trialsConfigured(env)) return json({ error: 'Trial service is not configured.' }, 503);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (!await verifyTurnstile(env, body?.turnstileToken, request)) {
    return json({ error: 'Verification failed. Please try again.' }, 400);
  }

  const now = Date.now();
  let user = await env.TRIAL_DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const id = user?.id || crypto.randomUUID();
  const sentAt = Number(user?.verification_sent_at || 0);
  if (sentAt && now - sentAt < SEND_COOLDOWN_MS) {
    return json({ error: 'Please wait a moment before requesting another code.' }, 429);
  }

  let windowStart = Number(user?.verification_window_started_at || 0);
  let sendCount = Number(user?.verification_send_count || 0);
  if (!windowStart || now - windowStart >= SEND_WINDOW_MS) {
    windowStart = now;
    sendCount = 0;
  }
  if (sendCount >= MAX_SENDS_PER_WINDOW) {
    return json({ error: 'Too many codes requested. Please try again later.' }, 429);
  }

  const code = generateCode();
  const hash = await codeHash(env, email, code);
  await env.TRIAL_DB.prepare(`
    INSERT INTO users (
      id, email, username, verification_code_hash, verification_expires_at,
      verification_attempts, verification_sent_at, verification_window_started_at,
      verification_send_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      verification_code_hash = excluded.verification_code_hash,
      verification_expires_at = excluded.verification_expires_at,
      verification_attempts = 0,
      verification_sent_at = excluded.verification_sent_at,
      verification_window_started_at = excluded.verification_window_started_at,
      verification_send_count = excluded.verification_send_count,
      updated_at = excluded.updated_at
  `).bind(
    id, email, email, hash, now + CODE_LIFETIME_MS,
    now, windowStart, sendCount + 1, now, now
  ).run();

  try {
    await sendTrialEmail(env, email, code);
  } catch (error) {
    console.error(error);
    await env.TRIAL_DB.prepare(`
      UPDATE users SET verification_code_hash = NULL,
        verification_expires_at = NULL, verification_sent_at = NULL,
        updated_at = ? WHERE id = ?
    `).bind(Date.now(), id).run();
    return json({ error: 'The email could not be sent. Please try again shortly.' }, 502);
  }
  return json({ ok: true, codeExpiresInSeconds: Math.floor(CODE_LIFETIME_MS / 1000) });
}
