# Monthly AWS cost at 11 users (PLAN §11, §13)

Estimated from the resources the CDK app in `infra/cdk` actually creates, as of the phase 9 hardening
branch (2026-10-04).

> ## ⚠️ The unit prices below are NOT verified
>
> The task was to fetch current AWS pricing and cite it. **That could not be done in this run.**
> WebFetch to `aws.amazon.com` (every pricing page) and to `pricing.us-east-1.amazonaws.com` was refused by
> the sandbox ("you haven't granted it yet"), exactly as in the phase 8 run. Only `docs.aws.amazon.com`
> pages could be read, and those carry no prices.
>
> So: **the _structure_ of this document is verified against the CDK code (what exists, what is fixed,
> what scales with usage), the _unit prices_ are my recollection of us-east-1 list prices and may be out of
> date or differ in your region.** Every number is derived from the table in section 1; replace those
> unit prices with the current ones from the pages in section 6 and the totals in sections 2 to 4 follow
> by the shown arithmetic. Do not quote the dollar totals externally before doing that.

## What is verified (sources actually fetched)

- Aurora Serverless v2 bills **ACU-hours**, can scale to **0 ACU** (auto-pause) on PostgreSQL ≥ 16.3 (this stack
  uses 16.8), and "at any specific time, you are only charged for the Aurora serverless capacity that is
  being actively used". Storage is separate and always billed.
  <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.how-it-works.html>
  (fetched 2026-10-04) and
  <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html>
  (fetched in the phase 8 run: ~15 s resume, 5 min to 24 h idle time, RDS Proxy prevents pausing).
- NAT instance requirements: <https://docs.aws.amazon.com/vpc/latest/userguide/work-with-nat-instances.html>.
- Amplify compute role / SSR: <https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html>.
- RDS CA bundle download (global bundle, used by every DB function):
  <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.SSL.html>.

## 1. Unit prices used (UNVERIFIED, us-east-1 list prices, from memory)

| Item                                    | Unit price used                         | Pricing page (verify here)                                          |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| EC2 `t4g.nano` on-demand                | $0.0042 / hour                          | <https://aws.amazon.com/ec2/pricing/on-demand/>                     |
| EBS gp3                                 | $0.08 / GB-month                        | <https://aws.amazon.com/ebs/pricing/>                               |
| Public IPv4 address (in use)            | $0.005 / hour                           | <https://aws.amazon.com/vpc/pricing/>                               |
| NAT Gateway (only with `natMode=gateway`) | $0.045 / hour + $0.045 / GB processed | <https://aws.amazon.com/vpc/pricing/>                               |
| KMS customer managed key                | $1.00 / key-month, $0.03 / 10k requests | <https://aws.amazon.com/kms/pricing/>                               |
| Secrets Manager secret                  | $0.40 / secret-month, $0.05 / 10k calls | <https://aws.amazon.com/secrets-manager/pricing/>                   |
| Aurora Serverless v2 capacity           | $0.12 / ACU-hour                        | <https://aws.amazon.com/rds/aurora/pricing/>                        |
| Aurora storage / I/O                    | $0.10 / GB-month, $0.20 / million I/O   | <https://aws.amazon.com/rds/aurora/pricing/>                        |
| Lambda (arm64)                          | $0.0000133334 / GB-s, $0.20 / M requests; free tier 400k GB-s + 1M requests | <https://aws.amazon.com/lambda/pricing/> |
| API Gateway HTTP API                    | $1.00 / million requests                | <https://aws.amazon.com/api-gateway/pricing/>                       |
| CloudWatch                              | logs $0.50 / GB ingested; custom metric $0.30 / month; first 10 alarms free | <https://aws.amazon.com/cloudwatch/pricing/> |
| EventBridge Scheduler                   | first 14M invocations / month free      | <https://aws.amazon.com/eventbridge/pricing/>                       |
| SNS email                               | first 1,000 email deliveries free       | <https://aws.amazon.com/sns/pricing/>                               |
| Amplify Hosting                         | build $0.01 / minute; SSR requests and compute billed per use, with a free tier | <https://aws.amazon.com/amplify/pricing/> |

A month is 730 hours.

## 2. Fixed baseline, per deployed stage (this is the part that is NOT near $0)

The plan (§11) hoped for "near-$0 at idle". The architecture is mostly pay-per-use, **but these resources
cost money 24/7 whether or not anyone uses the app**:

| #   | Resource (CDK source)                                                                                                                                              | Why it is fixed                                                    | Arithmetic                              | ≈ $/month |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------- | --------- |
| 1   | **NAT instance** `t4g.nano` + 8 GiB root volume (`data-stack.ts`, `natMode=instance`, the default)                                                                  | runs continuously so the in-VPC Lambdas can reach Oura/Strava/Terra/Secrets Manager/KMS | 730 × $0.0042 + 8 × $0.08 = 3.07 + 0.64 | 3.7       |
| 2   | **Public IPv4** address on the NAT instance                                                                                                                         | hourly charge per public IPv4                                      | 730 × $0.005                            | 3.65      |
| 3   | **KMS key** `alias/rd-<stage>-tokens`                                                                                                                               | per key-month (rotation on)                                        | 1 key                                   | 1.0       |
| 4   | **Secrets Manager: 9 secrets**: `db`, `nextauth`, `oauth-state`, `token-key`, `oura`, `strava`, `terra`, `google-oauth`, `github-token` (`data-stack.ts`)           | per secret-month (two were added in phase 9: `oauth-state`, `google-oauth`) | 9 × $0.40                               | 3.6       |
| 5   | **CloudWatch**: 2 log-metric filters feeding the alarms (`observability-stack.ts`)                                                                                  | per custom-metric-month; the 6 alarms stay inside the free 10      | 2 × $0.30                               | 0.6       |
| 6   | **Aurora storage** (+ backup beyond the cluster size)                                                                                                               | billed even while compute is paused; this DB is tens of MB         | ~0.05 GB × $0.10                        | < 0.01    |
|     | **Fixed total (NAT-instance mode)**                                                                                                                                 |                                                                    |                                         | **≈ 12.6** |

Flags, in order of size:

- **`natMode=gateway` replaces rows 1 and 2 with a NAT Gateway: 730 × $0.045 + the gateway's public IPv4
  (730 × $0.005) ≈ $36.5, i.e. fixed total ≈ $41.8 per stage.** It is the single biggest line in the stack,
  which is why the default is the NAT instance (trade-off: one instance, one AZ, self-patched; see README).
- **Public IPv4** (row 2) is a recent AWS charge people forget; it applies to the NAT instance's address.
- **Secrets Manager** is now 9 × $0.40. Phase 9 added two secrets (a separate OAuth-state key, the Google
  sign-in client). The per-function database roles added **no** secrets (they use IAM database
  authentication, so there is no password to store).
- **Both `dev` and `prod` stages deployed doubles everything in this section.** Destroy `dev` when idle
  (`cdk destroy 'rd-dev-*' -c stage=dev`); `prod` keeps its data, KMS key and secrets by design.
- Master-password rotation (phase 9, `dbRotationDays`, default 30) runs a small hosted Lambda once per
  interval. It is covered by the Lambda free tier and adds no fixed charge; it does resume Aurora once a month.

## 3. Usage-based items at 11 users

Everything below scales with traffic and is small at 11 users, **except Aurora compute, which depends on
how many hours a day the database is awake** and is the one to watch.

### Aurora compute (the main variable item)

`serverlessV2MinCapacity: 0` + auto-pause (5 min idle) means no compute charge while paused. Each wake costs
at least the idle period at the smallest running capacity (assumed 0.5 ACU): 0.5 × 5/60 ≈ 0.04 ACU-h ≈ $0.005.
What wakes it: the daily jobs (Oura sync, webhook-events TTL, history rebuild, all at ~10:00 UTC, so one
wake), Oura/Strava/Terra webhooks as athletes sleep and ride, and dashboard visits.

| Awake hours per day (at ~0.5 ACU) | ACU-hours / month | ≈ $/month at $0.12 |
| --------------------------------- | ----------------- | ------------------ |
| 1                                 | 15                | 1.8                |
| 3 (a realistic busy day for 11 athletes: ~20 wakes of ~9 min) | 45     | 5.4                |
| 6                                 | 90                | 10.8               |
| 24 (it never pauses: e.g. someone adds RDS Proxy or a few-minute schedule) | 365 | **43.8** |

This is why the CDK defaults are daily/slow schedules, the Strava replay is webhook-kicked rather than a
few-minute tick, and RDS Proxy is explicitly not used (README, "Aurora auto-pause"). The new
`history-rebuild` schedule is daily and runs right after the other daily jobs, so it adds no extra wake.

### Everything else (11 users, ~100k API requests/month assumed)

| Item                                                          | Basis                                                                            | ≈ $/month   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| Lambda (10 functions, arm64, 256 to 512 MB, ~100 ms typical)  | well inside the free tier (400k GB-s, 1M requests)                               | 0           |
| API Gateway HTTP API                                          | 100k × $1.00 / 1M                                                                | 0.10        |
| EventBridge Scheduler, SNS email                              | far below the free tiers                                                         | 0           |
| CloudWatch Logs (14 d dev / 30 d prod retention)              | ~50 to 200 MB/month at $0.50/GB                                                  | 0.1 to 0.5  |
| KMS requests, Secrets Manager API calls                       | one KMS decrypt and a few secret reads per Lambda cold start                     | < 0.1       |
| Aurora I/O, backups                                           | tiny data set; 1 to 7 days of backups are included up to the cluster size        | < 0.5       |
| Amplify Hosting (builds on demand, SSR)                       | builds ~3 to 5 min × $0.01; SSR requests for 11 users; free tier applies         | 0.1 to 1    |
| Data transfer out (NAT instance to providers, API responses)  | around 1 GB/month; AWS has a small monthly free allowance (verify on the EC2 page) | < 0.5       |
| **Subtotal**                                                  |                                                                                  | **≈ 0.5 to 3** |

## 4. Totals (per stage, UNVERIFIED unit prices)

| Scenario                                              | Fixed | Aurora compute | Other | **≈ Total / month** |
| ----------------------------------------------------- | ----- | -------------- | ----- | ------------------- |
| Quiet (1 h/day awake), NAT instance                   | 12.6  | 1.8            | 1     | **≈ 15**            |
| Typical 11 users (3 h/day awake), NAT instance        | 12.6  | 5.4            | 2     | **≈ 20**            |
| Busy (6 h/day awake), NAT instance                    | 12.6  | 10.8           | 3     | **≈ 26**            |
| Typical, `natMode=gateway`                            | 41.8  | 5.4            | 2     | **≈ 49**            |
| Pause broken (Aurora never pauses), NAT instance      | 12.6  | 43.8           | 3     | **≈ 59**            |
| `dev` and `prod` both up, typical                     | ×2 of the stage rows above                                        | **≈ 40**            |

**Conclusion: this is not a "near-$0" stack.** At 11 users expect roughly **$15 to $26 per stage per month**,
about two thirds of it fixed. The plan's expectation in §11 ("deliberately chosen to cost near-$0/month at 11
users") does not hold; PLAN.md was not edited (product behaviour is PLAN's, but the cost expectation is
now documented here and in `infra/cdk/DEPLOY.md`).

## 5. How to cut it (in order of effect)

1. Do not run `dev` and `prod` at the same time (halves the whole table).
2. Keep `natMode=instance` (saves ~$29/stage vs a NAT Gateway). If the NAT instance is too fragile for
   `prod`, that is the price of availability, not an accident.
3. Remove fixed secrets you do not use: `google-oauth` is only needed once Google sign-in is configured;
   `github-token` only for Amplify repo access (could move to the console connection). Each is $0.40.
4. Keep every scheduled job daily or slower, and never add RDS Proxy: both stop Aurora pausing (up to ~$44).
5. Lower `logRetentionDays` and `dbBackupDays` only if logs/backups ever grow; at this size they are cents.

## 6. Pricing pages to check before relying on any dollar figure

EC2 <https://aws.amazon.com/ec2/pricing/on-demand/> · EBS <https://aws.amazon.com/ebs/pricing/> ·
VPC (NAT Gateway, public IPv4) <https://aws.amazon.com/vpc/pricing/> ·
Aurora <https://aws.amazon.com/rds/aurora/pricing/> · KMS <https://aws.amazon.com/kms/pricing/> ·
Secrets Manager <https://aws.amazon.com/secrets-manager/pricing/> · Lambda <https://aws.amazon.com/lambda/pricing/> ·
API Gateway <https://aws.amazon.com/api-gateway/pricing/> · CloudWatch <https://aws.amazon.com/cloudwatch/pricing/> ·
EventBridge <https://aws.amazon.com/eventbridge/pricing/> · SNS <https://aws.amazon.com/sns/pricing/> ·
Amplify <https://aws.amazon.com/amplify/pricing/>. The AWS Pricing Calculator (<https://calculator.aws/>) can
price the same resource list for your region.

Also worth setting in the AWS account regardless of this estimate: a monthly **budget alert** (AWS Budgets) at,
say, $30 per stage, so a broken pause or a stray NAT Gateway is noticed within a day.
