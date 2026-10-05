# Deploying (manual, human-run)

Nothing in this repo deploys by itself. These are the exact commands. `<stage>` is `dev` or `prod`;
replace `<ACCOUNT_ID>`, `<REGION>`, `<owner>/<repo>` and `you@example.com`. All commands run from
`infra/cdk` unless noted, with AWS credentials for the target account in your shell
(`export AWS_PROFILE=...`, `export AWS_REGION=<REGION>`).

> **Cost heads-up:** a stage is **not $0** — ≈ $11–12/month fixed (NAT instance, public IPv4, KMS key, 7
> secrets). Full list, and the NAT instance vs NAT Gateway trade-off, in [README.md](./README.md).
> Destroy `dev` when you're not using it.

## 0. Prerequisites

```bash
pnpm install                                   # from the repo root
pnpm --filter @rd/infra-cdk test               # assertion tests
cd infra/cdk && npx cdk synth -c stage=<stage> --quiet   # also bundles every Lambda with esbuild
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>  # once per account+region
```

You also need `jq` and the AWS CLI v2. For Amplify: a GitHub access token that can read the repo and create a
webhook on it (Amplify registers a push webhook). Check the current scope requirements in the Amplify
"Setting up GitHub access" docs; they weren't verified when this was written.

## 1. Deploy the data stack

```bash
npx cdk deploy rd-<stage>-data -c stage=<stage>
```

Creates the VPC/NAT, Aurora (empty), the KMS key and **placeholder** secrets. Nothing works yet.

## 2. Fill the secrets

Helper (merges keys into a JSON secret; values stay out of shell history):

```bash
setkeys() {  # setkeys <secret-id> KEY=VALUE ...
  local id=$1; shift
  local cur; cur=$(aws secretsmanager get-secret-value --secret-id "$id" --query SecretString --output text)
  for kv in "$@"; do cur=$(jq --arg k "${kv%%=*}" --arg v "${kv#*=}" '.[$k]=$v' <<<"$cur"); done
  aws secretsmanager put-secret-value --secret-id "$id" --secret-string "$cur" >/dev/null && echo "updated $id"
}
S=<stage>
```

| Secret `rd/<stage>/…` | Key                                                                                     | Source                                                                | Set by        |
| --------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------- |
| `db`                  | username/password/host/…                                                                | RDS-generated                                                         | **automatic** |
| `nextauth`            | `NEXTAUTH_SECRET`                                                                       | generated; read by BOTH the API and the Amplify build                 | **automatic** |
| `token-key`           | `KMS_ENCRYPTED_DATA_KEY`                                                                | step 3 below                                                          | you, once     |
| `oura`                | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`                                                  | Oura developer portal. `OURA_WEBHOOK_VERIFICATION_TOKEN` is generated | you           |
| `strava`              | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` (`STRAVA_WEBHOOK_VERIFY_TOKEN` is generated) | strava.com/settings/api. `STRAVA_SUBSCRIPTION_ID` added in step 8     | you           |
| `terra`               | `TERRA_DEV_ID`, `TERRA_API_KEY`, `TERRA_SIGNING_SECRET`                                 | Terra dashboard                                                       | you           |
| `github-token`        | `token`                                                                                 | GitHub token for Amplify (needed before the web stack deploys)        | you           |

Unfilled values read `REPLACE_ME`; the API treats them as "provider not configured" (it boots, and that
provider's `/connections` routes 404) rather than registering junk credentials.

```bash
read -rsp 'Oura client secret: ' V; echo; setkeys rd/$S/oura OURA_CLIENT_ID=<id> OURA_CLIENT_SECRET="$V"
read -rsp 'Strava client secret: ' V; echo; setkeys rd/$S/strava STRAVA_CLIENT_ID=<id> STRAVA_CLIENT_SECRET="$V"
read -rsp 'Terra API key: ' K; read -rsp 'Terra signing secret: ' G; echo
setkeys rd/$S/terra TERRA_DEV_ID=<dev-id> TERRA_API_KEY="$K" TERRA_SIGNING_SECRET="$G"
read -rsp 'GitHub token: ' V; echo; setkeys rd/$S/github-token token="$V"; unset V K G
```

## 3. Create the token data key (once per stage — never redo)

One AES-256 data key encrypts every OAuth token; it is stored KMS-encrypted and decrypted once per Lambda cold
start. **If you regenerate it while tokens exist, they become undecryptable and users must reconnect.**

```bash
BLOB=$(aws kms generate-data-key-without-plaintext \
  --key-id alias/rd-$S-tokens --key-spec AES_256 \
  --encryption-context purpose=rd-token-data-key \
  --query CiphertextBlob --output text)
setkeys rd/$S/token-key KMS_ENCRYPTED_DATA_KEY="$BLOB"
```

## 4. Deploy web, api, observability

```bash
npx cdk deploy rd-<stage>-web rd-<stage>-api rd-<stage>-observability \
  -c stage=<stage> \
  -c alarmEmail=you@example.com \
  -c webRepository=https://github.com/<owner>/<repo> \
  -c webBranch=<main|dev>
```

Optional context: `-c natMode=gateway`, `-c ouraSyncSchedule='cron(0 6 * * ? *)'`, `-c webDomain=app.example.com`
(see the table in README.md; use the same `-c` flags on every later deploy). Confirm the SNS subscription
email AWS sends to `alarmEmail`.

## 5. Apply database migrations

The DB is in isolated subnets, so migrations run **inside the VPC** via the `migrate` Lambda (the deploy
workflow does this automatically):

```bash
aws lambda invoke --function-name rd-$S-migrate --cli-read-timeout 900 \
  --cli-binary-format raw-in-base64-out --payload '{}' --log-type Tail \
  --query 'LogResult' --output text /tmp/migrate.json | base64 -d; cat /tmp/migrate.json
```

The first call may take ~15–45 s if Aurora is paused. Re-run after any new migration is merged.

## 6. First web build

The Amplify build reads the API URL from SSM, which exists only now that the api stack is deployed:

```bash
APP=$(aws cloudformation describe-stacks --stack-name rd-$S-web --query "Stacks[0].Outputs[?OutputKey=='AmplifyAppId'].OutputValue" --output text)
aws amplify start-job --app-id "$APP" --branch-name <main|dev> --job-type RELEASE
aws cloudformation describe-stacks --stack-name rd-$S-web --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" --output text
```

Optionally turn on builds-on-push afterwards with `-c webAutoBuild=true`. If the Amplify branch doesn't exist
in the repo yet, push it first. A custom domain is attached in the Amplify console; then redeploy with
`-c webDomain=<domain>` so `NEXTAUTH_URL` and the OAuth redirect URIs match.

## 7. Webhook URLs and redirect URIs to register

```bash
aws cloudformation describe-stacks --stack-name rd-$S-api --query "Stacks[0].Outputs" --output table
```

| Provider   | What to register                                                                                                        | Value                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Strava** | push-subscription callback URL                                                                                          | `https://<api-id>.execute-api.<REGION>.amazonaws.com/api/v1/webhooks/strava` (output `StravaWebhookUrl`)                                                                                   |
| **Strava** | app "Authorization Callback Domain"                                                                                     | the web domain, e.g. `<branch>.<app>.amplifyapp.com`; redirect used: `<WebUrl>/settings/connections/strava/callback`                                                                       |
| **Terra**  | webhook destination URL (Terra dashboard → webhooks/destinations; UI labels may change, see <https://docs.tryterra.co>) | `https://<api-id>.execute-api.<REGION>.amazonaws.com/api/v1/webhooks/terra` (output `TerraWebhookUrl`). Copy the dashboard's signing secret into `rd/<stage>/terra` `TERRA_SIGNING_SECRET` |
| **Terra**  | widget success/failure redirect                                                                                         | `<WebUrl>/settings` (set by the stack as `TERRA_*_REDIRECT_URL`)                                                                                                                           |
| **Oura**   | OAuth redirect URI (developer portal)                                                                                   | `<WebUrl>/settings/connections/oura/callback`                                                                                                                                              |
| **Oura**   | webhook subscription callback                                                                                           | `…/api/v1/webhooks/oura` (output `OuraWebhookUrl`) — created for you by step 9, nothing to paste                                                                                           |

## 8. Register the Strava subscription

Strava validates the callback with a GET (must answer within 2 s with the challenge,
<https://developers.strava.com/docs/webhooks/>). Warm the Lambda first so the cold start (VPC + secret
fetch) doesn't eat that budget — a `403` response here is expected and fine:

```bash
URL=$(aws cloudformation describe-stacks --stack-name rd-$S-api --query "Stacks[0].Outputs[?OutputKey=='StravaWebhookUrl'].OutputValue" --output text)
curl -s -o /dev/null -w '%{http_code}\n' "$URL?hub.mode=subscribe&hub.verify_token=warmup&hub.challenge=x"   # 403

VERIFY=$(aws secretsmanager get-secret-value --secret-id rd/$S/strava --query SecretString --output text | jq -r .STRAVA_WEBHOOK_VERIFY_TOKEN)
read -rsp 'Strava client secret: ' CS; echo
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=<STRAVA_CLIENT_ID> -F client_secret="$CS" \
  -F callback_url="$URL" -F verify_token="$VERIFY"     # -> {"id": 123456}
setkeys rd/$S/strava STRAVA_SUBSCRIPTION_ID=123456     # pins POSTs to your subscription
unset CS
```

Warm containers pick up `STRAVA_SUBSCRIPTION_ID` when they recycle (or immediately after any redeploy).
Inspect or delete a subscription with the `GET`/`DELETE` calls in the Strava docs.

## 9. Create the Oura webhook subscriptions

```bash
aws lambda invoke --function-name rd-$S-oura-subscriptions --cli-binary-format raw-in-base64-out \
  --payload '{}' /tmp/oura-subs.json && cat /tmp/oura-subs.json
```

Oura calls the `webhook-oura` GET handshake while this runs (so deploy the api stack first). A daily schedule
renews them afterwards.

## 10. Deploying from GitHub Actions (optional)

`.github/workflows/deploy.yml` is `workflow_dispatch`-only and uses GitHub OIDC (no AWS keys). One-time setup:

```bash
npx cdk deploy rd-github-oidc -c githubRepo=<owner>/<repo>      # add -c githubOidcProviderArn=... if the account
                                                                 # already has the GitHub OIDC provider
aws cloudformation describe-stacks --stack-name rd-github-oidc --query "Stacks[0].Outputs"
```

Then in GitHub: **Settings → Environments** → create `dev` and `prod`; add **Required reviewers** to `prod`
(that is the approval gate); add environment _variables_ `AWS_DEPLOY_ROLE_ARN` (the matching role's ARN),
`AWS_REGION`, and optionally `ALARM_EMAIL`, `WEB_REPOSITORY`, `WEB_BRANCH`, `WEB_DOMAIN`, `NAT_MODE`.
Run **Actions → Deploy → Run workflow**. The first-ever deploy of a stage must be done by hand
(steps 1–4) because secrets must be filled between the data and web stacks.

## Operations

```bash
# Re-run the Strava replay by hand (completes pending/failed webhook events)
aws lambda invoke --function-name rd-$S-strava-replay --payload '{"pendingAfterSec":0}' --cli-binary-format raw-in-base64-out /tmp/r.json
# Sync Oura now (all users, or {"userId":"<uuid>"})
aws lambda invoke --function-name rd-$S-oura-sync --payload '{}' --cli-binary-format raw-in-base64-out /tmp/s.json
# One-off webhook_events cleanup with a different retention
aws lambda invoke --function-name rd-$S-webhook-ttl --payload '{"days":7}' --cli-binary-format raw-in-base64-out /tmp/t.json
# Tear down dev (prod keeps data/KMS/secrets: DeletionPolicy Retain/Snapshot and termination protection)
npx cdk destroy 'rd-dev-*' -c stage=dev
```

Rotating a provider secret: `setkeys` it, then redeploy (or wait for containers to recycle) — secrets are read
once per cold start. The database master password is not auto-rotated yet (rotation needs the rotation Lambda
to reach Secrets Manager through the NAT; a follow-up).

## Known limitations / expectations

- **Aurora resume:** after ≥ 5 min idle the DB pauses; the next request waits ~15 s (30 s+ after a day idle).
  Webhooks are persisted and replayed; the first dashboard load after a quiet period can be slow.
- **First admin user:** the DB is unreachable from your laptop; `apps/api/db/seed` runs against a reachable
  Postgres only. Seeding the first master account in AWS needs a follow-up (see the phase report).
- **NAT instance** is a single point of failure in one AZ — use `-c natMode=gateway` if that matters more than cost.
