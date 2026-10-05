# infra/cdk — AWS infrastructure (PLAN §11)

TypeScript CDK app. **Synth only from CI/agents; deployment is a human step** — see
[DEPLOY.md](./DEPLOY.md) for the exact commands, secrets and webhook URLs.

```bash
pnpm --filter @rd/infra-cdk test        # CDK assertion tests (Vitest), no AWS access needed
pnpm --filter @rd/infra-cdk typecheck
cd infra/cdk && npx cdk synth -c stage=dev      # real esbuild bundling of every Lambda
```

## Stacks

Deploy order is `data → web → api → observability` (real references; no cycles).

| Stack (`rd-<stage>-…`) | Contents                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`                 | VPC (public / app-private / isolated-DB subnets, **NAT instance** by default), Aurora Serverless v2 Postgres 16 (min 0 ACU, auto-pause), KMS key for the token data key, every Secrets Manager entry (placeholders or generated)                                |
| `web`                  | Amplify Hosting app + branch for `apps/web` (Next.js SSR, pnpm monorepo build spec), a build role (API-URL parameter only) and an SSR **compute role** (reads `nextauth` + `google-oauth` at runtime)                                                           |
| `api`                  | HTTP API (throttled, per-route throttle on the Strava POST, JSON access logs), 10 Lambdas (+ the optional one-off `first-master`) each with its own role, log group and **Postgres role**, EventBridge Scheduler schedules, `/rd/<stage>/api-url` SSM parameter |
| `observability`        | SNS topic → email (`alarmEmail` context), 6 CloudWatch alarms (inside the 10 free alarms)                                                                                                                                                                       |
| `rd-github-oidc`       | Optional, account-level, deployed once by hand: GitHub OIDC provider + one deploy role per GitHub environment. Exists only with `-c githubRepo=owner/repo`                                                                                                      |

Nothing account-specific lives in code: account/region come from the CLI credentials
(`CDK_DEFAULT_*`), everything else from context.

### Why web and api don't reference each other

The API needs the web URL (OAuth redirect URIs); the web app needs the API URL. A CloudFormation
reference both ways would be a cycle, so the `api` stack consumes the `web` stack, and the Amplify
**build** reads the API URL from SSM (`/rd/<stage>/api-url`) and writes it, with the stage and the _ARNs_
of the runtime secrets, to `apps/web/.env.production` (AWS's documented way to give Next.js SSR env vars).
Trigger the first Amplify build only after the api stack exists (DEPLOY.md).

**No secret is in the build.** Anything in `.env.production` is readable by whoever can read the
deployment artifacts (AWS's own docs say so), so since phase 9 `NEXTAUTH_SECRET` and the Google OAuth client are
**not** written there and the build role cannot read Secrets Manager at all. The running Next.js server reads
them itself at start-up (`apps/web/src/instrumentation.ts` → `lib/auth/runtime-secrets.ts`) using the Amplify
SSR **compute role** (`web-stack.ts`), which can read exactly `nextauth` and `google-oauth`:
<https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html>. Not verifiable without a
deploy: that `register()` runs in Amplify's compute and that its credentials are visible to the AWS SDK
there (the docs say they are "immediately available in the runtime of your SSR function").

## Context (all optional)

`cdk synth -c key=value` or edit `cdk.json`. Every schedule is a context value; `off` disables it.

| Key                                                          | Default                              | Meaning                                                                                 |
| ------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `stage`                                                      | `dev`                                | `dev` or `prod` (prod: retained data, deletion + termination protection, 7-day backups) |
| `natMode`                                                    | `instance`                           | `instance` (small NAT instance) or `gateway` (managed NAT Gateway)                      |
| `alarmEmail`                                                 | –                                    | SNS email recipient (no address in code)                                                |
| `dbMinAcu` / `dbMaxAcu`                                      | `0` / `2`                            | `0` enables auto-pause                                                                  |
| `dbAutoPauseMinutes`                                         | `5`                                  | idle time before pausing (5–1440)                                                       |
| `dbBackupDays`                                               | `1` dev / `7` prod                   |                                                                                         |
| `dbRotationDays`                                             | `30`                                 | master DB password rotation interval; `0` = off (only `migrate` uses the master)        |
| `throttleRate` / `throttleBurst`                             | `20` / `40`                          | API Gateway stage throttling (req/s)                                                    |
| `throttleStravaRate` / `throttleStravaBurst`                 | `5` / `10`                           | tighter per-route limit on the unauthenticated `POST /webhooks/strava`                  |
| `historyRebuildSchedule`                                     | `cron(20 10 * * ? *)`                | works through queued history-rebuild requests (daily, right after the other daily jobs) |
| `historyRebuildMaxDates` / `historyRebuildMaxUsers`          | `120` / `10`                         | per-invocation bounds of the history rebuild                                            |
| `stravaReplayMaxAttempts`                                    | `5`                                  | a failing Strava webhook event is retried this often, then `abandoned`                  |
| `enableFirstMaster`                                          | `false`                              | deploys the one-off `first-master` function (DEPLOY.md); remove it after use            |
| `ouraSyncSchedule`                                           | `cron(0 10 * * ? *)`                 | daily safety net behind Oura webhooks                                                   |
| `ouraSubscriptionsSchedule`                                  | `cron(30 9 * * ? *)`                 | renews Oura webhook subscriptions (no DB)                                               |
| `stravaReplaySchedule`                                       | `rate(6 hours)`                      | fallback only, see below                                                                |
| `webhookTtlSchedule` / `webhookTtlDays`                      | `cron(5 10 * * ? *)` / `30`          | PLAN §13 `webhook_events` TTL                                                           |
| `ouraSandbox`                                                | `false`                              | `OURA_USE_SANDBOX`                                                                      |
| `webRepository` / `webBranch` / `webAutoBuild` / `webDomain` | – / `main`(prod) `dev` / `false` / – | Amplify                                                                                 |
| `logRetentionDays`                                           | `14` dev / `30` prod                 |                                                                                         |
| `githubRepo`, `githubOidcProviderArn`, `bootstrapQualifier`  | – / – / `hnb659fds`                  | OIDC stack                                                                              |

## Lambdas and their roles

Entrypoints are `apps/api/src/lambda/*.ts`, bundled by `NodejsFunction` (esbuild; the `@rd/*` workspace
packages ship TS source and are compiled into the bundle). Secrets are **never** in Lambda env: the
functions get only secret ARNs, and `lambda/bootstrap.ts` loads them at cold start. `PG_POOL_MAX=1`.

| Function             | Secrets read                                          | `kms:Decrypt` | VPC    | Database login             | Triggered by                          |
| -------------------- | ----------------------------------------------------- | ------------- | ------ | -------------------------- | ------------------------------------- |
| `api`                | nextauth, oauth-state, token-key, oura, strava, terra | yes           | yes    | `rd_api` (IAM)             | HTTP API catch-all                    |
| `webhook-terra`      | terra, token-key                                      | yes           | yes    | `rd_hook_terra` (IAM)      | `GET/POST /api/v1/webhooks/terra`     |
| `webhook-strava`     | strava, token-key (+ invoke `strava-replay`)          | yes           | yes    | `rd_hook_strava` (IAM)     | `GET/POST /api/v1/webhooks/strava`    |
| `webhook-oura`       | oura, token-key                                       | yes           | yes    | `rd_hook_oura` (IAM)       | `GET/POST /api/v1/webhooks/oura`      |
| `oura-sync`          | oura, token-key                                       | yes           | yes    | `rd_oura_sync` (IAM)       | Scheduler, daily                      |
| `oura-subscriptions` | oura                                                  | no            | **no** | none                       | Scheduler, daily (+ deploy workflow)  |
| `strava-replay`      | strava, token-key                                     | yes           | yes    | `rd_strava_replay` (IAM)   | webhook kick + Scheduler fallback     |
| `webhook-ttl`        | none                                                  | no            | yes    | `rd_webhook_ttl` (IAM)     | Scheduler, daily                      |
| `history-rebuild`    | none                                                  | no            | yes    | `rd_history_rebuild` (IAM) | Scheduler, daily (+ manual invoke)    |
| `first-master`       | none                                                  | no            | yes    | `rd_first_master` (IAM)    | manual, only with `enableFirstMaster` |
| `migrate`            | db (**the master credential**)                        | no            | yes    | master (Secrets Manager)   | deploy workflow (`aws lambda invoke`) |

Each role also has: log writes scoped to its own log group, and (VPC functions) the three ENI actions Lambda
requires (the only `Resource: "*"`). No wildcard actions; no RDS control-plane/IAM/S3/SQS grants. Tests assert
all of this (`test/api-stack.test.ts`).

### Per-function database access (stage E item)

The Lambdas used to share the Aurora **master** credential. Now only `migrate` (it runs DDL) holds it. Every
other function connects as **its own Postgres role** (created by the phase 9 migration, `*_phase-9_hardening.sql`)
using **IAM database authentication**: the function's IAM role may `rds-db:connect` for exactly that one db
user (`rds-db:connect` on `dbuser:<cluster-resource-id>/<role>`), the "password" is a 15-minute signed token
(`lambda/db-auth.ts`), and the roles have no password at all. Each role has only the table privileges its
handler's SQL needs, pinned exactly by `apps/api/src/lambda/db-roles.test.ts`, which also runs the real
Strava/Terra/Oura/TTL/recompute handler code under each role. Documented limits: the privileges were derived by
reading the handlers (the test fails if a handler needs more); a new table or a new SQL statement in a handler
needs a grant added in a migration.

Every DB function verifies the server's certificate against the **RDS CA bundle** (`PG_SSL_CA_FILE`,
`users/pool.ts`; fails closed without it). The bundle is downloaded from AWS's truststore into each bundle at
`cdk synth/deploy` time (`rdsCaBundleCommands`), so the machine that synthesises needs `curl` and network
access, and a truncated download fails the build. The master password rotates every `dbRotationDays` (30) with
a hosted rotation Lambda; that is safe because only `migrate` reads it, on every run.

**Deviation from PLAN §11 ("webhook Lambdas: RDS write only"):** Strava/Oura/Terra ingest decrypts the
user's stored tokens (Strava refresh, Terra backfill) and the provider's client secret is needed to refresh
or verify, so each webhook role additionally has _its own provider's_ secret + token-key + `kms:Decrypt`. The
database side is now close to "only what it needs" (a webhook role cannot read another user's athlete events,
feedback, or any other function's tables), but it is not literally write-only: the webhook handlers also run the
trend recompute, so they read the metrics tables and write `trends` / `readiness_scores`.

### Token encryption (envelope)

One AES-256 data key is generated once per stage (`aws kms generate-data-key-without-plaintext`, DEPLOY.md
step 3) and stored KMS-encrypted in `rd/<stage>/token-key`. Each container calls `kms:Decrypt` once at cold
start; `LocalAesGcmCipher` then does per-token AES-GCM with the same `context` AAD. No KMS call per token,
and roles need `kms:Decrypt` only, conditioned on `kms:EncryptionContext:purpose=rd-token-data-key`.
Never replace the data key while tokens exist: they would become undecryptable (users would reconnect).

### Strava replay: not a few-minute poll

The Strava webhook answers in ~1.5 s and finishes ingest in the background; Lambda freezes the process after
the response, so slow ingests stay `pending`. `strava-replay` completes them (`replayStravaEvents` +
`lazyStravaIngest()`). A fixed tick every few minutes would keep Aurora from ever pausing, so instead
**`webhook-strava` async-invokes `strava-replay` right after a successful POST** (the DB is already awake)
with `pendingAfterSec: 0`; a slow `rate(6 hours)` schedule catches rate-limited (`failed`) rows. To trade cost
for latency: `-c stravaReplaySchedule='rate(5 minutes)'`. A failing event is retried up to
`stravaReplayMaxAttempts` (default 5) times and then becomes `abandoned` (terminal; the 30-day TTL removes it);
a revoked grant is abandoned at once. The webhook only kicks the replay when an event is still pending after
its response budget, so forged or duplicate POSTs do not each start a Lambda.

### Aurora auto-pause

`serverlessV2MinCapacity: 0` + `serverlessV2AutoPauseDuration` (Aurora PostgreSQL ≥ 16.3; this uses 16.8). The first
connection after a pause resumes the instance in ~15 s (30 s+ after >24 h idle). Why that's acceptable: the
webhook Lambdas have a 60 s timeout, outliving API Gateway's 30 s, so the event row is still written and
replayed even if the provider timed out and retries (handlers are idempotent upserts); the API's first
request after a quiet period may be slow or 503 once. **Do not add RDS Proxy** (open connections prevent
pausing) and don't schedule DB-touching jobs more often than daily (they would keep it awake).

## Networking and cost

Lambdas are in the VPC (to reach Aurora) and still need Oura/Strava/Terra/Secrets Manager/KMS/Lambda APIs.

- **NAT instance by default** (`natMode=instance`: `t4g.nano`, CDK `NatProvider.instanceV2`, Amazon Linux 2023,
  security group admits only TCP 80/443 from the Lambda security group). A managed NAT Gateway has an hourly
  charge plus per-GB processing regardless of use. Trade-off: a single instance in a single AZ is a single point
  of failure (warm containers keep working; cold starts needing Secrets Manager/KMS would fail until it
  recovers), is self-patched only by replacement, and has lower burst bandwidth. Switch with
  `-c natMode=gateway` for availability.
- **No interface VPC endpoints** (Secrets Manager/KMS/Lambda): they bill per AZ-hour, more than the NAT instance.
- `oura-subscriptions` runs outside the VPC (it never touches the DB), so it needs no NAT.

### Resources with a fixed monthly cost (input for phase 9's docs/COST.md)

Everything else (Lambda, API Gateway, EventBridge Scheduler, SNS, Amplify builds/SSR, CloudWatch Logs, Aurora
compute while paused) is usage-based and ~0 at 11 users. **These are not near $0**; per stage:

| Resource                                                                                              | Why fixed                                                                                     | Rough size*                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| NAT instance `t4g.nano` + 8 GiB EBS root volume                                                       | runs 24/7 (or **NAT Gateway** with `natMode=gateway`: hourly charge, the largest single item) | ~$3–4                        |
| Public IPv4 address on the NAT instance (or gateway's EIP)                                            | hourly per-IPv4 charge                                                                        | ~$3.7                        |
| KMS customer-managed key `alias/rd-<stage>-tokens`                                                    | per key-month                                                                                 | $1                           |
| Secrets Manager: 7 secrets (`db`, `nextauth`, `token-key`, `oura`, `strava`, `terra`, `github-token`) | per secret-month                                                                              | ~$2.8                        |
| Aurora storage + backups beyond free retention                                                        | per GB-month, even while paused                                                               | cents at this data size      |
| CloudWatch custom metrics from 2 metric filters; alarms beyond the free 10                            | per metric-month                                                                              | < $1                         |
| **Total (instance mode)**                                                                             |                                                                                               | **≈ $11–12 / stage / month** |

\*Approximate figures from memory. **The AWS pricing pages could not be fetched in the run that wrote this
(WebFetch to `aws.amazon.com` was denied), so verify before quoting them:**
[EC2](https://aws.amazon.com/ec2/pricing/on-demand/) ·
[VPC / NAT Gateway / public IPv4](https://aws.amazon.com/vpc/pricing/) ·
[Aurora](https://aws.amazon.com/rds/aurora/pricing/) ·
[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) ·
[KMS](https://aws.amazon.com/kms/pricing/) ·
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) ·
[Amplify](https://aws.amazon.com/amplify/pricing/).
Running both `dev` and `prod` doubles these; destroy `dev` when idle (`cdk destroy 'rd-dev-*'`).

## Sources consulted (fetched during the build)

- Aurora Serverless v2 auto-pause (min 0 ACU, ≥16.3 PostgreSQL, ~15 s resume, 5 min–24 h interval, RDS Proxy
  prevents pause): <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html>
- NAT instances (source/dest check, iptables masquerade, route table, security group rules):
  <https://docs.aws.amazon.com/vpc/latest/userguide/work-with-nat-instances.html>
- Amplify monorepo build settings (`appRoot`, `AMPLIFY_MONOREPO_APP_ROOT`, pnpm needs `node-linker=hoisted`
  and a `preBuild` pnpm install): <https://docs.aws.amazon.com/amplify/latest/userguide/monorepo-configuration.html>
- Amplify SSR environment variables (write to `<appRoot>/.env.production`; avoid secrets there):
  <https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html>
- Strava webhook subscription API: <https://developers.strava.com/docs/webhooks/>
- Terra webhook docs (dashboard registration steps could not be confirmed from the page fetched):
  <https://docs.tryterra.co/reference/vantage-api/webhooks.md>
