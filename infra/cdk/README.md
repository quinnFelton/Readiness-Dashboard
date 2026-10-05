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

| Stack (`rd-<stage>-…`) | Contents                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`                 | VPC (public / app-private / isolated-DB subnets, **NAT instance** by default), Aurora Serverless v2 Postgres 16 (min 0 ACU, auto-pause), KMS key for the token data key, every Secrets Manager entry (placeholders or generated) |
| `web`                  | Amplify Hosting app + branch for `apps/web` (Next.js SSR, pnpm monorepo build spec), build role                                                                                                                                  |
| `api`                  | HTTP API (throttled, JSON access logs), 9 Lambdas each with its own role + log group, EventBridge Scheduler schedules, `/rd/<stage>/api-url` SSM parameter                                                                       |
| `observability`        | SNS topic → email (`alarmEmail` context), 6 CloudWatch alarms (inside the 10 free alarms)                                                                                                                                        |
| `rd-github-oidc`       | Optional, account-level, deployed once by hand: GitHub OIDC provider + one deploy role per GitHub environment. Exists only with `-c githubRepo=owner/repo`                                                                       |

Nothing account-specific lives in code: account/region come from the CLI credentials
(`CDK_DEFAULT_*`), everything else from context.

### Why web and api don't reference each other

The API needs the web URL (OAuth redirect URIs); the web app needs the API URL. A CloudFormation
reference both ways would be a cycle, so the `api` stack consumes the `web` stack, and the Amplify
**build** reads the API URL from SSM (`/rd/<stage>/api-url`) and `NEXTAUTH_SECRET` from Secrets Manager,
writing them to `apps/web/.env.production` (AWS's documented way to give Next.js SSR env vars). Trigger
the first Amplify build only after the api stack exists (DEPLOY.md). Caveat from AWS's docs: anything
in that file is readable by anyone with access to the deployment artifacts — see "Needs" in the phase
report (the web app should read the secret at runtime through an Amplify compute role).

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
| `throttleRate` / `throttleBurst`                             | `20` / `40`                          | API Gateway stage throttling (req/s)                                                    |
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
functions get only secret ARNs, and `lambda/bootstrap.ts` loads them at cold start (the DB secret becomes
`DATABASE_URL` before the first `getPool()`, so `users/pool.ts` needs no change). `PG_POOL_MAX=1`.

| Function             | Secrets read                                     | `kms:Decrypt` | VPC    | Triggered by                          |
| -------------------- | ------------------------------------------------ | ------------- | ------ | ------------------------------------- |
| `api`                | db, nextauth, token-key, oura, strava, terra     | yes           | yes    | HTTP API catch-all                    |
| `webhook-terra`      | db, terra, token-key                             | yes           | yes    | `GET/POST /api/v1/webhooks/terra`     |
| `webhook-strava`     | db, strava, token-key (+ invoke `strava-replay`) | yes           | yes    | `GET/POST /api/v1/webhooks/strava`    |
| `webhook-oura`       | db, oura, token-key                              | yes           | yes    | `GET/POST /api/v1/webhooks/oura`      |
| `oura-sync`          | db, oura, token-key                              | yes           | yes    | Scheduler, daily                      |
| `oura-subscriptions` | oura                                             | no            | **no** | Scheduler, daily (+ deploy workflow)  |
| `strava-replay`      | db, strava, token-key                            | yes           | yes    | webhook kick + Scheduler fallback     |
| `webhook-ttl`        | db                                               | no            | yes    | Scheduler, daily                      |
| `migrate`            | db                                               | no            | yes    | deploy workflow (`aws lambda invoke`) |

Each role also has: log writes scoped to its own log group, and (VPC functions) the three ENI actions Lambda
requires (the only `Resource: "*"`). No wildcard actions; no RDS/IAM/S3/SQS grants. Tests assert all of this
(`test/api-stack.test.ts`).

**Deviation from PLAN §11 ("webhook Lambdas: RDS write only"):** Strava/Oura/Terra ingest decrypts the
user's stored tokens (Strava refresh, Terra backfill) and the provider's client secret is needed to refresh
or verify, so each webhook role additionally has _its own provider's_ secret + token-key + `kms:Decrypt`.
There is no IAM-level "RDS write only": database access is network (security group) plus the DB secret, and
all functions use the one Aurora master credential. Per-function Postgres roles would be a follow-up
(needs migrations + one secret per role).

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
for latency: `-c stravaReplaySchedule='rate(5 minutes)'`. Known gap: `replayStravaEvents` has no retry cap,
so a permanently failing event is retried on every run until the 30-day TTL removes it.

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
