import { codeHash, generateTrialCode, identifierHash, json, trialsConfigured } from './_shared.js';

export async function onRequestPost({ request, env }) {
  if (!trialsConfigured(env)) return json({ error: 'Trial service is not configured.' }, 503);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
  const limiterKey = await identifierHash(env, ip);
  const limit = await env.TRIAL_DB.prepare(
    'SELECT window_started_at, generation_count FROM trial_generation_limits WHERE key_hash = ?'
  ).bind(limiterKey).first();
  const sameWindow = limit && now - Number(limit.window_started_at) < dayMs;
  const generationCount = sameWindow ? Number(limit.generation_count) : 0;
  if (generationCount >= 5) {
    return json({ error: 'Too many trial codes generated. Please try again later.' }, 429);
  }
  await env.TRIAL_DB.prepare(`
    INSERT INTO trial_generation_limits (key_hash, window_started_at, generation_count)
    VALUES (?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      generation_count = excluded.generation_count
  `).bind(limiterKey, sameWindow ? Number(limit.window_started_at) : now, generationCount + 1).run();

  const id = crypto.randomUUID();
  const code = generateTrialCode();
  const hash = await codeHash(env, code);
  const compact = code.replace(/-/g, '');
  const prefix = compact.slice(0, 4);

  /* The legacy email column remains populated for compatibility with the
     first migration; no email is collected or sent in this flow. */
  const internalEmail = `trial-${id}@codeoflife.invalid`;
  await env.TRIAL_DB.prepare(`
    INSERT INTO users (
      id, email, username, verification_code_hash, trial_code_prefix,
      trial_ended, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(id, internalEmail, `Trial ${prefix}`, hash, prefix, now, now).run();

  return json({ ok: true, code });
}
