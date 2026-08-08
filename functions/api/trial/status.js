import { json, readSession, trialsConfigured } from './_shared.js';

export async function onRequestGet({ request, env }) {
  if (!trialsConfigured(env)) return json({ configured: false, state: 'disabled' });

  const session = await readSession(env, request);
  if (!session) {
    return json({ configured: true, state: 'unregistered', turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  const user = await env.TRIAL_DB.prepare(
    'SELECT id, email, trial_start_at, trial_end_at FROM users WHERE id = ?'
  ).bind(session.sub).first();
  if (!user || !user.trial_start_at || !user.trial_end_at) {
    return json({ configured: true, state: 'unregistered', turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  const now = Date.now();
  const active = user.trial_end_at > now;
  return json({
    configured: true,
    state: active ? 'active' : 'expired',
    trialStartAt: user.trial_start_at,
    trialEndAt: user.trial_end_at,
    remainingSeconds: Math.max(0, Math.floor((user.trial_end_at - now) / 1000)),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null
  });
}

