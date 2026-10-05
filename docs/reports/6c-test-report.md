# Phase 6c test report

Result: **FAILED** (2 failing tests, both added by the tester in `apps/web/src/app/settings/_lib/callback.extra.test.ts`). typecheck and lint pass. 445 of 447 tests pass.

## Spec coverage

| Requirement | Test | Status |
|---|---|---|
| Callback forwards exact query | callback.test.ts | pass |
| `error=access_denied` shows the denied message and does not call the API | callback.test.ts, extra | pass |
| API 400 shows a retryable error | callback.test.ts | pass |
| Code is not in console output or messages | callback.test.ts | pass |
| Signed-out user is sent to sign-in with a return URL that keeps the query | `signInRedirectFor` tests | pass |
| Signed-out user returns to the same URL after sign-in | extra (login page) | **FAIL** |
| Other 4xx/5xx and network errors give an error outcome | extra | pass |
| Other provider errors do not call the API | extra | pass |
| Disconnect confirmation states that derived data is deleted | settings-ui.test.tsx | pass |
| Precedence editor reorders and saves | settings-ui.test.tsx | pass |
| Providers are listed by role from the API registry | none | untested |
| Connect starts the OAuth or Terra widget flow | none | untested |
| Status and last-sync display | none | untested |
| Terra return shows status at `/settings` | none | untested |
| Bearer token attached | none (done inside `apiFetch`) | untested |

## Failures

1. **Return after sign-in is broken.**
   - Location: `callback.extra.test.ts:57`, product code `apps/web/src/app/(auth)/login/page.tsx`.
   - Expected: the login page reads `callbackUrl` and uses it after sign-in.
   - Actual: it hard-codes `redirectTo: '/dashboard'`. The callback page redirects to `/login?callbackUrl=...`, but the code is dropped and the user lands on the dashboard. The OAuth flow is never completed for signed-out users.
   - The login page is probably outside phase 6c's ownership. It should be fixed in the auth phase.

2. **Loose `code=` / `state=` check.**
   - Location: `callback.ts:48`, test in the extra file.
   - Expected: `{xcode, mystate}` is rejected without calling the API.
   - Actual: `qs.includes('code=')` is a substring match. A key like `xcode` or `mystate` passes the check and the API is called.
   - Impact is low, because the API still verifies the state. The fix is to check the keys on the query object.
   - I did not confirm which of the two failing tests is which from the run output. The login-page test is the one shown failing, and the xcode test is assumed to be the other.

## Risks not tested

- The server components and pages (`page.tsx`, the callback page redirect on success) and the server actions have no tests.
- The `window.location.assign` connect flow is untested.
- The `connected=` success notice is not verified to be rendered on `/settings/connections`.
- `ConnectionsPanel` can send a stale `activeDaily` on rapid toggles, and the activity radio can be saved with no connection.
- `describeStatus` token-expiry logic is untested.
