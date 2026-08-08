import {
  TRIAL_LENGTH_MS, codeHash, createSession, json, normalizeTrialCode,
  readJson, sessionCookie, trialsConfigured
} from './_shared.js';

export async function onRequestPost({ request, env }) {
  if (!trialsConfigured(env)) return json({ error: 'Trial service is not configured.' }, 503);
  const body = await readJson(request);
  const code = normalizeTrialCode(body?.code);
  if (!/^[A-Z0-9]{16}$/.test(code)) return json({ error: 'Enter a valid trial code.' }, 400);

  const suppliedHash = await codeHash(env, code);
  const user = await env.TRIAL_DB.prepare(
    `SELECT *, verification_attempts AS trial_ended,
      verification_expires_at AS trial_ended_at
     FROM users WHERE verification_code_hash = ?`
  ).bind(suppliedHash).first();
  const now = Date.now();
  if (!user) return json({ error: 'That trial code is not valid.' }, 400);

  const ended = Number(user.trial_ended || 0) === 1;
  const previousEnd = Number(user.trial_end_at || 0);
  const wasManuallyReset = !ended && !!user.trial_ended_at && previousEnd <= now;
  if (ended) return json({ error: 'This trial code has expired.', state: 'expired' }, 403);
  if (previousEnd && previousEnd <= now && !wasManuallyReset) {
    await env.TRIAL_DB.prepare(
      'UPDATE users SET verification_attempts = 1, verification_expires_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now, now, user.id).run();
    return json({ error: 'This trial code has expired.', state: 'expired' }, 403);
  }

  const trialStart = !user.trial_start_at || wasManuallyReset ? now : Number(user.trial_start_at);
  const trialEnd = !user.trial_end_at || wasManuallyReset ? trialStart + TRIAL_LENGTH_MS : previousEnd;
  await env.TRIAL_DB.prepare(`
    UPDATE users SET trial_start_at = ?, trial_end_at = ?,
      verification_attempts = 0, verification_expires_at = NULL, updated_at = ? WHERE id = ?
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
