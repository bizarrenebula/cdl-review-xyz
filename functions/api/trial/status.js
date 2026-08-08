import { json, readSession, trialsConfigured } from './_shared.js';

export async function onRequestGet({ request, env }) {
  if (!trialsConfigured(env)) return json({ configured: false, state: 'disabled' });

  const session = await readSession(env, request);
  if (!session) {
    return json({ configured: true, state: 'unregistered', turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  const user = await env.TRIAL_DB.prepare(
    'SELECT id, trial_start_at, trial_end_at, trial_ended, trial_ended_at FROM users WHERE id = ?'
  ).bind(session.sub).first();
  if (!user || !user.trial_start_at || !user.trial_end_at) {
    return json({ configured: true, state: 'unregistered', turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  const now = Date.now();
  let trialStart = Number(user.trial_start_at);
  let trialEnd = Number(user.trial_end_at);
  let ended = Number(user.trial_ended || 0) === 1;

  /* An administrator resets a trial by changing trial_ended from 1 to 0.
     trial_ended_at records that transition's history, allowing us to
     distinguish a reset from a trial reaching its end for the first time. */
  if (!ended && user.trial_ended_at && trialEnd <= now) {
    trialStart = now;
    trialEnd = now + 7 * 24 * 60 * 60 * 1000;
    await env.TRIAL_DB.prepare(`
      UPDATE users SET trial_start_at = ?, trial_end_at = ?, trial_ended_at = NULL,
        updated_at = ? WHERE id = ?
    `).bind(trialStart, trialEnd, now, user.id).run();
  } else if (!ended && trialEnd <= now) {
    ended = true;
    await env.TRIAL_DB.prepare(
      'UPDATE users SET trial_ended = 1, trial_ended_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now, now, user.id).run();
  }
  const active = !ended && trialEnd > now;
  return json({
    configured: true,
    state: active ? 'active' : 'expired',
    trialStartAt: trialStart,
    trialEndAt: trialEnd,
    remainingSeconds: Math.max(0, Math.floor((trialEnd - now) / 1000))
  });
}
