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
SELECT id, username, trial_start_at, trial_end_at,
       verification_attempts AS trial_ended,
       verification_expires_at AS trial_ended_at, created_at
FROM users
ORDER BY created_at DESC;
```

## Session and feature settings

In **Settings → Variables and Secrets**, add:

- `SESSION_SECRET`: at least 32 cryptographically random bytes, stored as an encrypted secret.
- `TRIALS_ENABLED`: keep `false` until D1 and trial-code activation have been tested, then set to `true`.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and run Pages locally with a local D1
binding. Never commit `.dev.vars`.

## Trial rules

- Trial codes contain 16 unambiguous letters and numbers, grouped for readability.
- The full code is shown once and must be copied or saved by the user.
- Only an HMAC of the code and its four-character prefix are stored.
- Code generation is limited to five codes per network address in 24 hours.
- The first successful code verification starts exactly seven 24-hour periods.
- Re-entering the same code never resets its existing trial timestamps.
- Trial status is determined by server timestamps, not browser storage or the browser clock.
- The existing `verification_attempts` column is reused as `trial_ended`; at expiry it is set to `1`.
  The existing `verification_expires_at` column records when expiry was detected.
- To grant a fresh trial, set that user's `verification_attempts` back to `0`. The next
  session check or valid code entry starts a new seven-day window.
