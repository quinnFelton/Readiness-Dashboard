# Security review — phase 9 hardening

Audit of `main` @ `4ee4764` (branch `phase-9/hardening`) against PLAN §5.3, §6, §11, §12 and
CLAUDE.md rules 3–7. Read-only audit: no product code was changed. Paths are repo-relative;
`file:line` refers to the audited commit.

Scope covered: RBAC on every route, cross-user access, token encryption and refresh storage,
logging of tokens/secrets/health data, Terra HMAC, Strava verify token, Oura HMAC, SQL injection,
OAuth scope/state/PKCE, CORS, secrets in code and git history, data export/delete, `pnpm audit`.

## Summary

| Severity | Count | Headline |
|---|---|---|
| Critical | 0 | — |
| High | 4 | Forgeable OAuth `state` in prod · unauthenticated Strava delete/deauth events · no production login (only a shared-password dev login gated by `NODE_ENV`) · no per-user export / account delete |
| Medium | 4 | Disconnect doesn't revoke at provider · no uniqueness on `(provider, external_user_id)` · DB TLS not verified · unauthenticated Strava POSTs write rows and invoke the replay Lambda |
| Low | 10 | See table below |

---

## High

### H1. OAuth `state` is HMAC'd with an empty key in production (CSRF protection off)
- **Where:** `apps/api/src/connections/routes.ts:33-34`; `apps/api/src/crypto/oauth-state.ts:9-10`;
  prod env in `infra/cdk/lib/api-stack.ts:86-96` and `infra/cdk/lib/data-stack.ts:156-160`.
- **What:** `stateSecret()` falls back to `Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64')`.
  In production, token encryption uses `KmsTokenCipher` (`KMS_ENCRYPTED_DATA_KEY`). No stack,
  secret or DEPLOY.md step ever sets `TOKEN_ENCRYPTION_KEY`, so the secret is a **zero-length
  buffer**. HMAC-SHA256 with an empty key works without error, so anyone can compute a valid
  `state` for any `(userId, provider)`.
- **Why it matters:** `state` is the only CSRF control on the connect flow (PLAN §12). The web
  callback page (`apps/web/src/app/settings/connections/[provider]/callback/page.tsx:22-30`)
  completes on a plain GET. An attacker who knows a victim's user UUID (UUIDs appear in
  `/admin/athletes/<id>` URLs and API paths) can get their own Strava/Oura `code`, forge `state` for the
  victim, and send the victim the callback link. The victim's account is then bound to the attacker's
  provider account (account-linking CSRF): poisoned EF/HRV data, and the attacker's webhook events
  route to the victim (see M2). There is also key reuse: in dev the AES token key doubles as the HMAC key.
- **Fix:**
  1. Add a dedicated `OAUTH_STATE_SECRET` (≥32 random bytes, generated) to Secrets Manager in
     `data-stack.ts`. Grant it only to the `api` function. Read it in `connections/routes.ts`.
  2. Fail closed: make `signOAuthState`/`verifyOAuthState` throw if `secret.length < 32`. Add a
     unit test asserting that an empty key throws.
  3. Optional: also bind `state` to the browser with a short-lived `__Host-` cookie set by the
     `startConnection` server action and checked on the callback page.

### H2. Strava webhook acts on unauthenticated `delete` and deauthorization events
- **Where:** `apps/api/src/webhooks/strava/routes.ts:59-69` (`applyStravaEvent`), `:100-112`;
  `apps/api/src/providers/strava/strava-ingest-service.ts:148-154` (`removeActivity`),
  `:175-182` (`markDeauthorized`).
- **What:** Strava POSTs carry no signature. The comment at `strava-ingest-service.ts:35-36` says
  "a forged event can at worst trigger a re-fetch", but that is wrong for two event types:
  - `aspect_type: "delete"` → `removeActivity` deletes the user's `activity_efforts` rows and
    recomputes trends **without asking Strava**.
  - `object_type: "athlete"` with `updates.authorized: "false"` → `markDeauthorized` **nulls both
    tokens** and deactivates the connection.

  The only gate is `owner_id` → local user. Strava athlete IDs are public (profile URLs), and so are
  activity IDs for public rides. The `subscription_id` pin (`routes.ts:106-110`) is **fail-open**:
  it's skipped when `STRAVA_SUBSCRIPTION_ID` is unset, which is the default until DEPLOY.md step 8.
  Even when set, it's a low-entropy integer.
- **Why it matters:** An unauthenticated remote attacker can erase any connected athlete's derived
  activity history and silently disconnect their Strava (they must re-OAuth). Forged `create`/`update`
  events also burn the shared app-wide Strava rate limit (PLAN §5.2) with the victim's token, which is a
  DoS for every user.
- **Fix:**
  1. Treat every event as a hint and confirm it with Strava. For `delete`, route through `ingestActivity`,
     which already deletes only when `getActivity` reports the activity gone. For deauth, deactivate only
     after a real 401 from a token refresh or `GET /athlete`.
  2. Make the subscription pin mandatory in prod: if `NODE_ENV === 'production'` and
     `STRAVA_SUBSCRIPTION_ID` is empty, return 503 (fail closed), as the Terra router does for a missing secret.
  3. Dedupe re-fetches per `(owner_id, object_id, aspect_type)` within N minutes using `webhook_events`,
     so forged floods can't exhaust the Strava quota.
  4. Fix the misleading comments at `routes.ts:13-16` and `strava-ingest-service.ts:35-36`.

### H3. No production authentication; the only login is a shared dev password gated by `NODE_ENV`
- **Where:** `apps/web/src/lib/auth/config.ts:22-41` (sole provider: Credentials);
  `apps/api/src/auth/routes.ts:20-39`; `infra/cdk/lib/api-stack.ts:87`.
- **What:** NextAuth has one provider, which posts to `/api/v1/auth/login`. That route accepts
  **any existing email** plus one shared `AUTH_DEV_PASSWORD`, and returns 404 when
  `NODE_ENV === 'production'`. The CDK sets `NODE_ENV=production` on every stage, so a deployed
  environment has **no working login**. The obvious workaround is to unset `NODE_ENV` or add an env
  override "to make it work". That turns on a login where one shared password impersonates every
  account, master included. It has no rate limit or lockout and no per-user credential.
- **Why it matters:** PLAN §2/§12 multi-user RBAC is only as strong as authentication. Today the
  choices are "no prod auth" or "everyone can be the master".
- **Fix:** Before first deploy, add a real provider to `authConfig.providers`: Email/magic link via
  SES, or OAuth (Google/GitHub) restricted to emails already in `users`. Register the dev Credentials
  provider only when `NODE_ENV !== 'production'` **and** `AUTH_DEV_PASSWORD` is set, in the web config
  as well as the API. Add a CDK assertion test that no Lambda env contains `AUTH_DEV_PASSWORD`. Add a
  route-level throttle on `/api/v1/auth/login` for any internet-reachable non-prod stage.

### H4. No per-user data export or account deletion (PLAN §12 "build from the start")
- **Where:** No route exists. `apps/api/src/users/routes.ts` has only `GET /me` and `GET /`.
  `apps/api/src/connections/routes.ts:125-131` erases one provider's data only.
- **What:** PLAN §12 requires per-user export/delete of sensitive health data. FK `ON DELETE CASCADE`
  is in place (good), but nothing exposes it. There's no way for a user, or the master on their
  behalf, to download their data or delete the account. The per-provider erase
  (`connection-service.ts:136-159`) also leaves `webhook_events` rows for that user/provider (Strava
  athlete/activity IDs, Oura user IDs) until the TTL sweep.
- **Fix:**
  - `GET /api/v1/users/:userId/export` (`requireUser, requireSelfOrMaster('userId')`) returns JSON
    of `users`, `provider_connections` (public columns only, never `*_token_enc`),
    `connection_configs`, `daily_metrics`, `activity_efforts`, `readiness_scores`, `trends`,
    `insight_feedback` (both as subject and as `voted_by`), `athlete_events`, and the user's
    `webhook_events` metadata.
  - `DELETE /api/v1/users/:userId` (self or master). Revoke provider grants (M1), then
    `DELETE FROM users WHERE id = $1` in one transaction (cascades). Write a non-PII audit line.
  - In `ConnectionService.disconnect` with `deleteData`, also
    `DELETE FROM webhook_events WHERE user_id = $1 AND provider = $2`.
  - Tests: after delete, every table that has a `user_id` column has zero rows for that id. Drive
    the table list from `information_schema.columns` so new tables can't be missed.

---

## Medium

### M1. Disconnect deletes tokens locally but never revokes them at the provider
- **Where:** `apps/api/src/connections/connection-service.ts:127-176`.
- **Why:** The DB copy goes, but the grant stays live at Strava/Oura (and Terra keeps pushing). A
  token exfiltrated earlier (backup, DB snapshot) stays usable, and Strava keeps sending webhook
  events for the athlete.
- **Fix:** Add an optional `revoke(grant)` to `ProviderAdapter`. Strava: `POST /oauth/deauthorize`.
  Oura and Terra: their documented revoke/deauthenticate endpoints (fetch current docs, cite URLs
  per rule 8). Decrypt and call it before deleting the row. Make it best-effort with a bounded timeout,
  and never log the token.

### M2. No uniqueness on `(provider, external_user_id)`; webhook routing takes `rows[0]`
- **Where:** `apps/api/db/migrations/20260101000200_phase-2_connections.sql:5-18`;
  `apps/api/src/providers/strava/strava-ingest-service.ts:48-55`;
  `apps/api/src/providers/oura/webhook.ts:280-285`.
- **Why:** Two local users can hold the same Strava athlete or Oura user (via H1, or one person with
  two accounts). Inbound events then go to whichever row Postgres returns first, which mixes one
  person's health data into another's account.
- **Fix:** In a phase migration, add a partial unique index on
  `provider_connections (provider, external_user_id) WHERE external_user_id IS NOT NULL AND is_active`.
  Map the 23505 error in `saveGrant` to a 409 "already linked to another user".

### M3. Database TLS certificate not verified
- **Where:** `apps/api/src/lambda/bootstrap.ts:49-53` (`sslmode=no-verify`).
- **Why:** Traffic is encrypted but the server isn't authenticated. A host or DNS compromise inside the
  VPC could intercept DB credentials and all health data. The code comment acknowledges this as a TODO.
- **Fix:** Bundle the RDS global CA bundle. Pass `ssl: { ca, rejectUnauthorized: true }` from
  `users/pool.ts` and use `sslmode=verify-full`.

### M4. Unauthenticated Strava POSTs write DB rows and fan out to the replay Lambda
- **Where:** `apps/api/src/webhooks/strava/routes.ts:112-119,144`; `apps/api/src/lambda/webhooks.ts:72-73`.
- **Why:** Every well-formed POST, including ones for unknown `owner_id`, inserts a `webhook_events`
  row and returns 200. That 200 triggers an async invoke of `strava-replay`. With the stage-wide
  throttle as the only limit, an attacker can grow the table and run up Lambda/Aurora cost, which
  defeats the scale-to-zero cost model (PLAN §11).
- **Fix:** Don't persist events for unknown owners; count them instead. Kick the replay only when a
  `pending` row was actually inserted. Put a tighter route-level throttle on `/api/v1/webhooks/strava`.
  Fail closed on a missing subscription pin (H2).

---

## Low

| # | Finding | Where | Fix |
|---|---|---|---|
| L1 | **Terra/Oura replay window without dedupe.** Signed deliveries can be replayed within ±300 s. Upserts are idempotent, but a replayed Terra `deauth` or Oura `delete` re-runs. | `apps/api/src/webhooks/terra/signature.ts:47-48`, `apps/api/src/webhooks/terra/router.ts:66-67`; `packages/provider-adapters/src/oura/webhook.ts:70-76` | Store a hash of the signature header in `webhook_events` with a unique index; reject duplicates inside the tolerance window. |
| L2 | **Oura webhook leaks the verification reason / error class.** Responses return `bad_signature` vs `stale_timestamp`, and `err.name` on 500. | `apps/api/src/providers/oura/webhook.ts:262,304` | Return a generic `unauthorized` / `processing failed`, like the Terra router. |
| L3 | **Routers without a safe error handler.** `usersRouter`, `authRouter` and the app root fall through to Express 5's default handler. It prints `err.stack` when `NODE_ENV !== 'test'`, and pg errors can quote row values (emails). | `apps/api/src/app.ts:62-63`; `apps/api/src/users/routes.ts:47-49`; `apps/api/src/auth/routes.ts:40-42` | Add `app.use(safeErrorHandler)` at the end of `createApp`. |
| L4 | **Terra callback trusts the browser-supplied `user_id`.** The redirect's `user_id` is unsigned. A user can bind an arbitrary Terra ID to their own row. This is mostly self-harm, because data webhooks also require the signed `reference_id`. | `packages/provider-adapters/src/terra/adapter.ts:59-63` | Treat the redirect as UX only. Take `external_user_id` from the signed `auth` webhook (`terra/router.ts:184-194`) or verify it via Terra's user-info endpoint. |
| L5 | **OAuth scope minimization.** The Oura default `daily personal` grants age, sex, weight and height, but `personal` is only used to read the user ID. The Strava scope check accepts a callback with no `scope` param. | `packages/provider-adapters/src/oura/config.ts:90`; `packages/provider-adapters/src/strava/adapter.ts:79` | Document why `personal` is needed, or drop it. Treat a missing Strava `scope` as not granted. Keep `activity:read_all` (PLAN §5.2) but note that it includes private activities. |
| L6 | **No PKCE.** A confidential-client code flow with a secret is acceptable, but PKCE is defense-in-depth against code interception. | `packages/provider-adapters/src/oura/adapter.ts:100-103`; `packages/provider-adapters/src/strava/client.ts:72-79` | Add S256 `code_challenge` wherever the provider supports it (check current Oura docs; Strava does not document PKCE). |
| L7 | **`NEXTAUTH_SECRET` serves two purposes.** It encrypts NextAuth session JWEs and signs API HS256 tokens. | `apps/api/src/auth/token.ts:18-24`; `apps/web/src/lib/auth/api-token.ts:8` | Use a separate `API_TOKEN_SECRET`, or HKDF-derive one with a distinct label on both sides. |
| L8 | **No security headers on the web app** (CSP / frame-ancestors, HSTS, Referrer-Policy). OAuth callback URLs carry `code`/`state`. | `apps/web/next.config.ts:3-6` | Add `headers()`: CSP with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (at least on `/settings/connections/*`), `X-Content-Type-Options: nosniff`, HSTS. |
| L9 | **`AUTH_TRUST_HOST=true`** trusts `X-Forwarded-Host` when building NextAuth URLs. | `infra/cdk/lib/web-stack.ts:131` | `AUTH_URL`/`NEXTAUTH_URL` are already explicit, so drop it, or confirm Amplify strips client-supplied forwarded headers. |
| L10 | **`pnpm audit`: 1 High, dev-only.** `braces <=3.0.3` stack-exhaustion DoS (GHSA-vfj7-8cjw-p6xm, CVE-2026-93687) via `@next/eslint-plugin-next > fast-glob > micromatch`. No patched version yet. Not in any runtime bundle. | `pnpm-lock.yaml` | Track the advisory. Add a `pnpm.overrides` entry once a fix ships. Gate CI on `pnpm audit --prod`. |

Also noted, not ranked:
- The Strava `webhook_events` row stores the full event, including `updates`, which can carry a
  renamed activity title (`apps/api/src/webhooks/strava/routes.ts:115-119`). Store only
  `object_type/object_id/aspect_type/owner_id/subscription_id/event_time`, as the Oura and Terra receipts do.
- Web sessions are 8 h JWTs with no revocation (`apps/web/src/lib/auth/config.ts:20`). The `/admin`
  middleware gate uses the role in the JWT. That's acceptable because the API re-reads the role from the
  DB on every request (`apps/api/src/middleware/rbac.ts:40-46`).

---

## Checked and OK

- **RBAC on every route (rule 3).** Every non-webhook route has server-side middleware:
  `/users/me` (`requireUser`); `/users` (`requireUser, requireMaster`); `/connections/*`
  (`r.use(requireUser)`, operating only on `req.user.id`, with no `:userId` param);
  `/scores`, `/trends`, `/feedback`, `/athlete-events` `/:userId` (`requireUser, requireSelfOrMaster('userId')`);
  `/comparison/*` (`router.use(requireUser, requireMaster)`). Unauthenticated routes: `/health`,
  `/auth/login` (404 in prod), and webhooks (signature / verify token). The role is re-read from the DB on
  every request; `requireSelfOrMaster` fails closed on a missing param. Non-default classifiers are
  master-only (`trends/default-classifier.ts:41-42`, `feedback/routes.ts:67-72`). The athlete-event
  delete is scoped `WHERE id = $1 AND user_id = $2`.
- **API token (HS256).** The alg is pinned, signature compare is constant-time, iss/aud/exp are checked, TTL is 300 s, and minting is `server-only`.
- **Token encryption (rule 6).** AES-256-GCM with per-row AAD `userId:provider`. The KMS envelope data key is decrypted
  once per container, and `kms:Decrypt` is scoped by encryption context. Refreshed tokens are always
  re-encrypted (`sync/sync-service.ts:122-138`, `providers/strava/strava-ingest-service.ts:101-111`,
  `providers/oura/webhook.ts:142-147`). The Strava refresh is serialized with `FOR UPDATE`. Token columns are
  never selected into API responses (`PUBLIC_COLS`).
- **Logging (rule 6).** Every `console.*` in runtime code logs only error class names or counts
  (`webhooks/strava/routes.ts:127`, `lambda/webhooks.ts:59`, `fatigue-fitness/recompute.ts:66`,
  `lambda/oura-sync.ts:20`, `lambda/migrate.ts:57`). No tokens, payloads, notes or comments are logged. API
  Gateway access logs leave out query strings, so the Strava verify token isn't logged.
- **Terra HMAC (rule 7, PLAN §5.3).** Raw-body parser mounted before `express.json()`. `t=,v1=` parsing,
  HMAC-SHA256 over timestamp + "." + raw body, `timingSafeEqual` over every v1 candidate (no early exit).
  The timestamp is checked only after the MAC (±tolerance, past and future). Fails closed (500) when the
  secret is unset. Only metadata goes into `webhook_events`. Data events require an active connection whose
  `external_user_id` matches the signed Terra user.
- **Oura HMAC.** Constant-time compare, freshness checked, fails closed without a client secret.
- **Strava verify token.** Hash-then-`timingSafeEqual`, rejects an empty expected token.
- **SQL injection.** Every query reviewed is parameterized. The only template interpolations are constant
  column lists (`COLUMNS`, `PUBLIC_COLS`, `cols`). Inputs are validated (UUID, ISO date, range regex,
  provider regex).
- **CORS.** No CORS middleware and no API Gateway `corsPreflight`, so browsers can't call the API
  cross-origin. All calls are made server-side by Next.js. This is the right posture; keep it.
- **Secrets in code/history.** `git log --all -G` for AWS keys, private keys, GitHub/Slack/Stripe tokens and
  `*_SECRET=` / `*_KEY=` / `*PASSWORD=` / `*VERIFY_TOKEN=` assignments matched only `.env.example`
  placeholders (commit 8240eba) and a regex inside an infra test (commit 6e9f357). `.env` is not tracked.
  CDK keeps secret values out of Lambda env (ARNs only) and has a hygiene test for it.
- **Infra.** Aurora is private-isolated, storage-encrypted and not publicly accessible. There is one
  least-privilege role per Lambda, the HTTP API stage is throttled, and GitHub OIDC (no access keys) is
  scoped per repo/environment.

## Method / tooling notes

I read every router, service, webhook handler, Lambda entrypoint, migration and CDK stack listed
above. Some planned shell commands (pipelines, and greps containing a dollar-brace pattern) were denied
by the non-interactive permission policy. Instead I used single-command `git log -G`, `git ls-files`
and `grep` runs plus direct file reads. `pnpm audit` ran across the full workspace (600 deps).

## Needs from other phases (fix owners)

- **api:** H1, H2, H4, M1, M2 (migration), M4, L1–L3, L7.
- **web:** H3, L7 (web side), L8.
- **infra:** H1 (secret + grant), H3 (assert no `AUTH_DEV_PASSWORD`), M3 (CA bundle), M4 (route throttle), L9.
- **provider-adapters:** L4, L5, L6, M1 (`revoke`).
