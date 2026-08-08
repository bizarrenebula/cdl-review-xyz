import { codeHash, generateTrialCode, identifierHash, json, trialsConfigured } from './_shared.js';

export async function onRequestPost({ request, env }) {
  if (!trialsConfigured(env)) return json({ error: 'Trial service is not configured.' }, 503);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  const limiterKey = await identifierHash(env, ip);
  const emailPrefix = `trial-${limiterKey}-`;
  const limit = await env.TRIAL_DB.prepare(
    'SELECT COUNT(*) AS generation_count FROM users WHERE verification_window_started_at >= ? AND email LIKE ?'
  ).bind(now - dayMs, `${emailPrefix}%`).first();
  const generationCount = Number(limit?.generation_count || 0);
  if (generationCount >= 5) {
    return json({ error: 'Too many trial codes generated. Please try again later.' }, 429);
  }

  const id = crypto.randomUUID();
  const code = generateTrialCode();
  const hash = await codeHash(env, code);
  const compact = code.replace(/-/g, '');
  const prefix = compact.slice(0, 4);
  const internalEmail = `${emailPrefix}${id}@codeoflife.invalid`;

  await env.TRIAL_DB.prepare(`
    INSERT INTO users (
      id, email, username, verification_code_hash, verification_attempts,
      verification_window_started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).bind(id, internalEmail, `Trial ${prefix}`, hash, now, now, now).run();

  return json({ ok: true, code });
}
