`apps/api/src/app.ts` belongs to no phase. After merging, mount the phase 5b routers there:
- `/api/v1/scores` and `/api/v1/trends`;
- `/api/v1/feedback` and `/api/v1/athlete-events`;
- `/api/v1/comparison` (master only).

Mount them after `express.json()` and after the webhook routers, which must stay before it.

Then:
- Add mount tests: each route answers 401 without a token and 403 for a plain user on another user's id, never 404. The `/comparison` routes return 403 for any non-master.
- Wire 6b's athlete drill-down to 6a's `AthleteDashboard` if 6b left a placeholder.
- Check that the `/settings/connections/<provider>/callback` pages from 6c call the mounted `/api/v1/connections/<provider>/callback`, and that the OAuth state round-trip works end to end in a test with mocked providers.
