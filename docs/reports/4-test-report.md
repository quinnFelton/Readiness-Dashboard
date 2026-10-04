# Phase 4 test report (Strava adapter + stream derivation)

Result: typecheck, lint and `pnpm test` all pass (29 files, 282 tests). Migrations were already applied.

## Spec coverage
| Requirement | Test |
|---|---|
| hub.challenge verification (valid, wrong token, wrong mode, no token configured) | strava-webhook.test.ts "subscription challenge" |
| create/update fetch only that activity | "events" create/update |
| delete removes the row, no Strava call, owner-scoped | "delete…" tests |
| Short and non-ride (Run/Swim/EBikeRide) skipped, no streams call | "skips short rides", "skips %s" |
| Skipped after gap collapsing; update that makes a ride ineligible removes the row | same file |
| Refresh before call, rotated tokens stored encrypted, concurrent refresh happens once, revoked token deactivates | "token refresh" |
| Retry/duplicate deliveries give one row | "retries / duplicate deliveries" |
| Rate-limit parse, backoff before ceiling, 429 handling, replay | rate-limit.test.ts, client.test.ts, "rate limits" |
| Training-load formula (TSS and TRIMP) | mapping.test.ts |
| Engine used for derivation, `DERIVATION_VERSION` stored | create test, and the new numeric check |
| Tokens never logged or stored in plaintext (new) | strava-secrets.test.ts |
| Hand-computed values for 200 W / 140 bpm steady 30 min: NP 200, peak20 200, HR 140, EF 1.4286 (new) | strava-secrets.test.ts |
| Forged POSTs: subscription-id pin, unknown athlete, malformed body | "rejects malformed…", "unknown athletes" |

## Failures
None.

## Risks not tested
- Strava webhook POSTs carry no signature, so authenticity depends on the optional `subscription_id` pin. If `STRAVA_SUBSCRIPTION_ID` is unset, any caller can trigger a re-fetch. This is bounded: the event carries no data.
- The 1.5 s response budget racing with in-flight work is not tested under a real timeout.
- Real Strava field names were not checked against the live docs. Tests rely on fixtures.
- Replay concurrency and the multi-process rate-limiter state are untested.
