import {
  MAX_VERIFY_ATTEMPTS, TRIAL_LENGTH_MS, codeHash, createSession, json,
  normalizeEmail, readJson, sessionCookie, trialsConfigured, validEmail
} from './_shared.js';

export async function onRequestPost({ request, env }) {
  if (!trialsConfigured(env)) return json({ error: 'Trial service is not configured.' }, 503);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code || '').replace(/\D/g, '');
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return json({ error: 'Enter the six-digit code.' }, 400);

  const user = await env.TRIAL_DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const now = Date.now();
  if (!user?.verification_code_hash || Number(user.verification_expires_at || 0) < now) {
    return json({ error: 'This code has expired. Request a new one.' }, 400);
  }
  if (Number(user.verification_attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    return json({ error: 'Too many attempts. Request a new code.' }, 429);
  }

  const suppliedHash = await codeHash(env, email, code);
  if (suppliedHash !== user.verification_code_hash) {
    await env.TRIAL_DB.prepare(
      'UPDATE users SET verification_attempts = verification_attempts + 1, updated_at = ? WHERE id = ?'
    ).bind(now, user.id).run();
    return json({ error: 'That code is not correct.' }, 400);
  }

  const trialStart = Number(user.trial_start_at || now);
  const trialEnd = Number(user.trial_end_at || (trialStart + TRIAL_LENGTH_MS));
  await env.TRIAL_DB.prepare(`
    UPDATE users SET trial_start_at = ?, trial_end_at = ?,
      verification_code_hash = NULL, verification_expires_at = NULL,
      verification_attempts = 0, updated_at = ? WHERE id = ?
  `).bind(trialStart, trialEnd, now, user.id).run();

  const active = trialEnd > now;
  const token = await createSession(env, { id: user.id, trial_end_at: trialEnd });
  return json({
    ok: true,
    state: active ? 'active' : 'expired',
    trialStartAt: trialStart,
    trialEndAt: trialEnd
  }, 200, { 'set-cookie': sessionCookie(request, token, trialEnd) });
}

