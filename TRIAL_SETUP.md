# Seven-day trial setup

The trial UI and API are safe to deploy before configuration. Unless
`TRIALS_ENABLED` is exactly `true`, `/api/trial/status` reports that the gate is
disabled and the application opens normally.

## Cloudflare D1

1. In Cloudflare, open **Workers & Pages → D1 SQL Database → Create database**.
2. Name it `codeoflife-trials`.
3. Open its console and execute `migrations/0001_trial.sql`.
4. Open the Code of Life Pages project, then **Settings → Bindings → Add → D1 database**.
5. Set the variable name to `TRIAL_DB` and select `codeoflife-trials`.
6. Redeploy after adding the binding.

The table can be inspected from the D1 console with:

```sql
SELECT id, email, username, trial_start_at, trial_end_at, created_at
FROM users
ORDER BY created_at DESC;
```

## Email delivery (Resend)

1. Create a Resend account and verify the domain used to send trial emails.
2. Create an API key with sending access.
3. In the Pages project, add encrypted secret `RESEND_API_KEY`.
4. Add `EMAIL_FROM`, for example `Code of Life <trial@your-domain.com>`.

## Session and feature settings

In **Settings → Variables and Secrets**, add:

- `SESSION_SECRET`: at least 32 cryptographically random bytes, stored as an encrypted secret.
- `TRIALS_ENABLED`: keep `false` until D1 and email delivery have been tested, then set to `true`.

## Turnstile (recommended before enabling production trials)

1. Create a Turnstile widget restricted to the production hostname.
2. Add its public key as `TURNSTILE_SITE_KEY`.
3. Add its secret as encrypted secret `TURNSTILE_SECRET_KEY`.

If these values are absent, the trial flow works without Turnstile. When a
secret is configured, server-side Turnstile validation is mandatory.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, use Cloudflare's Turnstile test keys,
and run Pages locally with a local D1 binding. Never commit `.dev.vars`.

## Trial rules

- Verification codes are six digits and expire after ten minutes.
- Only an HMAC of the code is stored.
- A code permits five verification attempts.
- Code email requests have a 60-second cooldown and an eight-per-day limit per email.
- The first successful verification starts exactly seven 24-hour periods.
- Re-verifying the same email never resets its existing trial timestamps.
- Trial status is determined by server timestamps, not browser storage or the browser clock.

