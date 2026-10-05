No ingest path calls `FatigueFitnessService.onSyncComplete` (PLAN §8.4: compute on sync, never on
dashboard load), so `trends` and `readiness_scores` stay empty in the running app. After merging, wire it:
- after a Strava activity is ingested or removed (`apps/api/src/providers/strava/strava-ingest-service.ts`
  or its webhook caller, including `replayStravaEvents`);
- after the Terra webhook stores daily metrics (`apps/api/src/webhooks/terra/router.ts`);
- after an Oura sync or Oura webhook event stores daily metrics (`apps/api/src/providers/oura/`);
- after a disconnect deletes a provider's data, so the dashboard stops showing it (PLAN §10 flow 8).

Build the service once per process (lazily, like `lazyStravaIngest`). A recompute failure must not fail
the ingest or the webhook response: log the error name only and leave the event `processed`. Add tests
that an ingest on each path produces trend rows for the user and none for other users.

Then:
- Run `pnpm test:e2e` against the merged branch. Remove any `test.fail()` that phase 7 added for the
  missing `onSyncComplete` wiring once the flow passes; keep the others and list them in the report.
- If phase 8 asked for a `createApp()` option to mount only the webhook routers, add it and point the
  `webhooks` Lambda entrypoint at it. Apply any small `pool.ts` change phase 8 requested for loading
  the database secret at cold start.
- Update the phase 7 and 8 rows of `docs/OWNERSHIP.md` to match the ownership stated in
  `pipeline/phases/7.md` and `pipeline/phases/8.md`.
- Check that the CDK app still synthesizes and that the root `pnpm typecheck && pnpm lint && pnpm test`
  include `infra/cdk` and the new Lambda entrypoints.
