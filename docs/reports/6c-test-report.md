# Phase 6c test report

Result: **FAILED (coverage gap, not test failures)**. typecheck, lint and `pnpm test` all pass (453 of 453). `pnpm db:migrate` had nothing to apply. The earlier report's two failures are fixed in the current code: the login page now reads `callbackUrl`, and `callback.ts` checks keys on the query object.

## Spec coverage

| Requirement | Test | Status |
|---|---|---|
| Callback forwards exact query (Bearer token is attached inside `apiFetch`) | callback.test.ts | pass (the token is not asserted) |
| `error=access_denied` shows the denied message, no API call | callback.test.ts, extra | pass |
| Other provider errors give an error and no API call | extra | pass |
| API 400 gives a retryable error; other 4xx/5xx and network errors give an error | callback.test.ts, extra | pass |
| Code is not in console output or outcome messages | callback.test.ts | pass |
| Missing code/state and bad provider names rejected without an API call | callback.test.ts, extra | pass |
| Signed-out redirect keeps the query, and the login page honors `callbackUrl` | `signInRedirectFor` tests, extra | pass (login check is a source regex only) |
| Disconnect confirmation says derived data is deleted; Cancel does nothing; errors shown | settings-ui.test.tsx, connections-panel.test.tsx | pass |
| Status text and last-sync display | connections-panel.test.tsx | pass |
| Connect button calls `onConnect` and shows its error | connections-panel.test.tsx | pass |
| Precedence editor reorders and saves | settings-ui.test.tsx | pass |
| Providers listed by role from the API registry (`ConnectionsPanel`) | none | **untested** |
| Precedence editor shown only with more than one daily source | none | **untested** |
| Connect navigates to the OAuth or Terra widget URL (`window.location.assign`) | none | **untested** |
| Terra return at `/settings` shows status | none | **untested** |
| Success notice on `/settings/connections` after `?connected=` | none | **untested** |
| Server actions and `server.ts` (registry fetch, Bearer token) | none | **untested** |

## Blocker for the untested items

`apps/web/vitest.config.ts` defines no `@/` alias, although `tsconfig.json` does. `ConnectionsPanel.tsx` imports `@/app/settings/_lib/actions`. Importing it in a test fails with "Failed to resolve import", even when `vi.mock` is used. I could not fix this because config is not a test file. Adding `resolve.alias` for `@` to the vitest config would let the panel, the pages and the Terra status page be tested.

## Failures

None.

## Risks not tested

- The callback page's `redirect()` on success and its rendering of the denied and error messages are covered only through `completeOAuthCallback`.
- The error page's "Try again" link is not tested.
- `ConnectionsPanel` can send a stale `activeDaily` on rapid toggles, and the activity radio can be saved while that provider has no connection.
- The test that the login page honors `callbackUrl` only checks source text. It does not check that the value is used safely, for example against open redirects to external URLs.
- The Bearer token and `Authorization` header are not verified, because `apiFetch` is mocked.
