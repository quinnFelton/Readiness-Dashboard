<div align="center">
# Readiness Dashboard

**Power:HR efficiency trends vs. recovery data — telling true fitness gains apart from fatigue, earlier than power and hours alone.**

[![Status](https://img.shields.io/badge/status-integrations%20built%20%E2%80%94%20dashboard%20in%20progress-yellow)](#roadmap)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Next.js](https://img.shields.io/badge/frontend-Next.js-black?logo=next.js)](#tech-stack)
[![Node.js](https://img.shields.io/badge/backend-Node.js-339933?logo=node.js&logoColor=white)](#tech-stack)
[![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL-4169E1?logo=postgresql&logoColor=white)](#tech-stack)
[![AWS](https://img.shields.io/badge/hosted%20on-AWS-FF9900?logo=amazon-aws&logoColor=white)](#tech-stack)
[![Playwright](https://img.shields.io/badge/tested%20with-Playwright-2EAD33?logo=playwright&logoColor=white)](#tech-stack)

</div>
---

## The idea

Most "readiness" tools estimate fatigue from training hours and power output alone. That misses the signal that actually separates fitness from fatigue: **how much heart rate a given power output costs you, and how that cost is trending.**

This project computes **Efficiency Factor (EF)** — normalized power and peak-20-minute power, each divided by the heart rate during that exact effort — from every qualifying ride, then tracks how that ratio moves relative to resting heart rate and HRV. Crossing those two trends against each other separates five states:

| EF trend | Recovery trend | State                    | Meaning                                                                                                                                |
| :------: | :------------: | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
|    ↑     |   stable / ↑   | 🟢 **Fitness gain**      | More power per heartbeat, well recovered — the real thing.                                                                             |
|    ↑     |       ↓        | 🟠 **Overreaching risk** | Output still improving, but at rising physiological cost — the pattern that precedes a crash, and the one hours/power alone can't see. |
|    ↓     |       ↓        | 🔴 **Acute fatigue**     | Correlated, expected fatigue — recovery time should help.                                                                              |
|    ↓     |   stable / ↑   | ⚪ **Ambiguous**         | No matching recovery signal — heat, pacing, altitude, or illness not yet reflected. Flagged for review, not auto-labeled.              |
|    →     |      any       | 🔵 **Steady**            | Steady fitness and fatigue — efficiency is holding. If recovery is falling, the insight adds an early warning to watch the next rides. |

When either side lacks enough data, the classifier abstains (`insufficient_data`) rather than guessing.

The goal is to see the **overreaching** case — and the days recovery actually paid off — before they show up as a bad race or a missed block.

---

## Architecture

```mermaid
flowchart TB
    subgraph Sources["Pluggable Data Sources"]
        direction LR
        Strava["Strava\n(activity source)"]
        Oura["Oura\n(daily metrics)"]
        Terra["Terra API\n(Zepp / Amazfit)"]
    end

    subgraph Backend["AWS — Serverless Backend"]
        direction TB
        API["REST API\nAPI Gateway + Lambda"]
        Sync["Scheduled Sync\nEventBridge + Lambda"]
        Webhook["Webhook Receivers\nsignature-verified"]
        Engine["Scoring Engine\nregistered derivers (NP · peak-20 · EF)\n+ registered trend classifiers"]
        DB[("Aurora Serverless v2\nPostgreSQL")]
    end

    Web["Next.js Dashboard\n(Amplify Hosting)"]

    Strava -->|OAuth + webhook| Webhook
    Oura -->|OAuth + webhook| Webhook
    Oura -.->|polling backfill| Sync
    Terra -->|widget + webhook| Webhook
    Sync --> Engine
    Webhook --> Engine
    Engine --> DB
    API --> DB
    Web -->|HTTPS| API
    Web -.->|OAuth callback forwarded\nwith user session| API
```

Every provider is normalized through a common adapter interface before it ever touches the scoring engine — the engine has no idea whether a day's HRV came from Oura or a ride's power came from Strava. That's what lets new sources (Garmin, Whoop, a manual upload) get added later as a registered adapter, not a schema change.

The same registry idea applies to the analytics themselves. Every **activity-effort deriver** (how a ride stream becomes EF scalars) and every **trend classifier** (how EF and recovery trends become a state) is a registered, versioned strategy. All of them run on every ride and every compute pass, and their output is tagged with the method's id. One of each is the default that athletes see; the others run silently as challengers until the data says one should be promoted (`PLAN.md` §8.7–§8.8).

---

## Features

- **Power:HR decoupling engine** — normalized power + peak-20-minute power computed from raw activity streams, each paired with heart rate over the _same_ window, not the ride average.
- **Fatigue vs. fitness classification** — rolling 7-day/28-day trend baselines cross EF against HRV/resting HR into a labeled state, not just a raw number.
- **Side-by-side method comparison** — alternative derivers and classifiers run in shadow mode next to the default, so a new window-selection idea or threshold set can be compared on real data before it's promoted. Adding one is a registered strategy plus a migration row, not a rework.
- **Accuracy feedback loop** _(in progress)_ — thumbs-up/down on flagged insights and a log of real outcomes (illness, injury, races, planned rest) feed a per-classifier agreement rate and backtest, viewable by coaches.
- **Pluggable connections** — pick one active activity source and one-or-more daily-metrics sources per user; adding a new provider is a new adapter, not a rework.
- **Multi-user with a coach view** — a `master` role sees a full roster and can drill into any connected athlete.
- **Derive-then-discard storage** — raw streams and payloads are processed into scalars and dropped, not retained; a `derivation_version` on every row means re-deriving after an algorithm change is a targeted, bounded operation, not a standing cost.
- **Security-conscious by default** — OAuth tokens encrypted at rest, every third-party webhook signature-verified before processing, per-user data export/delete built in from day one.

---

## Product Perspective

_A few questions I ask myself as the product owner, not just the engineer, as this moves past the first build._

> **Who is this actually for?**
> Not casual fitness trackers — athletes who already train with power and HR data and already own a recovery wearable, but whose current tools (Strava, the Oura app, TrainingPeaks) don't cross-reference the two. Primary segment: structured-training cyclists and triathletes coached or self-coached at a competitive-amateur level. Secondary segment: coaches managing several athletes at once — the `master` role exists because I'm a USA Cycling–certified coach and built this for a problem I actually have, not a hypothetical one.

> **Where does the first real feedback come from?**
> My own AchievePTC athletes are the first cohort — a built-in, trust-already-established beta group rather than a cold launch. The test that matters isn't a star rating, it's narrower: does the `overreaching_risk` flag show up _before_ an athlete or I would have caught it by feel, and does it ever fire when an experienced coach would clearly call it noise? Early feedback will focus on calibrating the EF trend thresholds (§17 in `PLAN.md`) against that judgment. A thumbs-up/down on individual flagged insights, plus a simple log of real illness/injury/race events, gives each candidate classifier a measurable track record, so recalibration is a promotion decision backed by data rather than a guess.

> **What does scaling actually look like, beyond more AWS capacity?**
> Three stages, each unlocked by validating the one before it: **(1)** today — 10 of my own athletes plus myself as coach, proving the core insight holds up against real coaching judgment; **(2)** AchievePTC's other coaches onboarded as their own `master` users over their own rosters — the multi-tenant schema in `PLAN.md` §14 was built with this specific next step in mind, so it's a data-volume change, not a rearchitecture; **(3)** beyond AchievePTC, to other independent coaches and small coaching businesses who have the same gap in their current toolchain. The infrastructure plan was chosen specifically so stage 3 doesn't require revisiting stage 1's decisions.

---

## Tech Stack

| Layer    | Choice                                                                            |
| -------- | --------------------------------------------------------------------------------- |
| Frontend | Next.js (App Router), React, TypeScript, Tailwind CSS, Recharts                   |
| Backend  | Node.js, Express (Lambda via `serverless-http`), TypeScript                       |
| Database | PostgreSQL — Aurora Serverless v2                                                 |
| Infra    | AWS: API Gateway, Lambda, EventBridge, Amplify Hosting, Secrets Manager, KMS, CDK |
| Testing  | Playwright (e2e), Vitest (unit — scoring engine is the priority target)           |
| CI/CD    | GitHub Actions                                                                    |

## Data Sources

| Role                                      | Current providers                                                                            | Connection model                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Activity source _(pick one)_              | [Strava](https://developers.strava.com/)                                                     | OAuth2 + webhook, stream-derived metrics                                 |
| Daily metrics source _(pick one or more)_ | [Oura](https://cloud.ouraring.com/v2/docs), Zepp / Amazfit via [Terra](https://tryterra.co/) | OAuth2 + webhook with polling backfill (Oura) / widget + webhook (Terra) |

Multiple daily-metrics sources can be active at once; an explicit per-metric priority decides which value wins when more than one reports for the same day. Every webhook is signature-verified before its payload is read. OAuth redirects land on the web app (`/settings/connections/<provider>/callback`), which forwards the code to the API with the signed-in user's session.

---

## Getting Started

> Auth, the connection framework, the scoring engine, and the Strava/Oura/Terra integrations are built. The classifier service, the dashboard UI, and deployment are still in progress — see [Roadmap](#roadmap) for current status.

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/)
- Docker (local Postgres 16 via `docker compose`; Aurora Serverless v2 in deployed environments)
- Developer credentials for whichever providers you're connecting: [Strava API](https://developers.strava.com/), [Oura API](https://cloud.ouraring.com/oauth/applications), [Terra API](https://dashboard.tryterra.co/)
- AWS CLI configured, if deploying

### Install

```bash
git clone https://github.com/quinnFelton/weightedPhysiology-.git
cd weightedPhysiology-
pnpm install
```

### Configure

Copy the example environment file and fill in your provider credentials:

```bash
cp .env.example .env
```

| Variable                                                  | Purpose                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                                            | Postgres connection string                                             |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`               | Strava OAuth app credentials                                           |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` / `STRAVA_SUBSCRIPTION_ID`  | Strava webhook challenge token; pin events to your subscription        |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`                   | Oura OAuth app credentials                                             |
| `OURA_WEBHOOK_VERIFICATION_TOKEN` / `OURA_USE_SANDBOX`    | Oura webhook verification token; sandbox mode (no ring needed)         |
| `OURA_REDIRECT_URI` / `STRAVA_REDIRECT_URI`               | OAuth redirect — a web-app page under `/settings/connections`          |
| `TERRA_DEV_ID` / `TERRA_API_KEY` / `TERRA_SIGNING_SECRET` | Terra dashboard credentials + webhook signing secret                   |
| `TOKEN_ENCRYPTION_KEY`                                    | Local-dev stand-in for the KMS key used to encrypt stored OAuth tokens |
| `NEXTAUTH_SECRET`                                         | App-level session signing secret                                       |

### Run

```bash
docker compose up -d db          # local Postgres
pnpm db:migrate                  # apply migrations
pnpm --filter @rd/api dev        # API on :4000 (watch mode)
pnpm --filter @rd/web dev        # dashboard on :3000
pnpm typecheck && pnpm lint      # what CI runs first
pnpm test                        # Vitest: unit + DB-backed integration tests
pnpm test:e2e                    # Playwright end-to-end suite
```

---

## Project Structure

```
readiness-dashboard/
├─ apps/
│  ├─ web/                  # Next.js dashboard
│  └─ api/                  # Express backend (Lambda-wrapped)
├─ packages/
│  ├─ shared-types/          # Normalized data contracts shared by web + api
│  ├─ scoring-engine/         # Pure functions: NP / peak-20 / EF, baselines, deriver + classifier registries
│  └─ provider-adapters/       # oura/ · strava/ · terra/ — one ProviderAdapter interface per connection role
├─ infra/
│  └─ cdk/                    # AWS infrastructure as code
├─ tests/
│  └─ e2e/                    # Playwright specs
├─ pipeline/                  # Scripted multi-agent build pipeline (build → test → integrate → PR)
├─ docs/                      # File ownership per phase, per-phase test and integration reports
├─ CLAUDE.md                  # Build instructions for AI-assisted development
├─ PLAN.md                    # Full technical spec — schema, algorithms, phased build plan
├─ CHANGELOG.md               # Reasoned log of substantive PLAN.md revisions
└─ ANALYTIC-IMPROVEMENTS.md   # Candidate analytic methods to trial as challenger derivers/classifiers
```

For the full data model, the EF/NP derivation math, and the phase-by-phase build plan, see **[`PLAN.md`](./PLAN.md)**.

---

## Roadmap

The build runs as a staged pipeline (`pipeline/README.md`): each phase is built and independently tested on its own branch, then a stage is integrated and reviewed as one PR. The pure scoring engine (5a) was pulled forward so the Strava integration could reuse its math instead of reimplementing it.

- [x] **Phase 0** — Monorepo scaffolding, CI skeleton
- [x] **Phase 1** — Auth & user model (user / master roles)
- [x] **Phase 2** — Pluggable connection framework
- [x] **Phase 3** — Oura (OAuth + webhooks, verified against Oura's OpenAPI spec) and Terra (Zepp/Amazfit) daily-metrics integrations
- [x] **Phase 4** — Strava integration + activity stream derivation (NP, peak-20, EF)
- [x] **Phase 5a** — Pure scoring engine: NP, peak-20, EF, baselines, fatigue/fitness classifier
- [x] **Comparison frameworks** — deriver and classifier registries, `deriver_id` on efforts (`PLAN.md` §8.7–§8.8)
- [ ] **Phase 5b** — Classifier service + trends/scores API, insight feedback, athlete events, classifier comparison & promotion
- [ ] **Phase 6** — Dashboard, coach admin (incl. classifier comparison page), connection settings + OAuth callback pages
- [ ] **Phase 7** — End-to-end test suite
- [ ] **Phase 8** — AWS deployment
- [ ] **Phase 9** — Hardening (security audit, cost check)

---

## Security & Privacy

This project handles real sleep, HRV, and heart-rate data. OAuth tokens are encrypted at rest, every inbound webhook is signature-verified before processing, raw provider payloads are not retained once normalized, and per-user data export/delete is a first-class feature rather than an afterthought. See [`PLAN.md`](./PLAN.md#12-security) for the full threat-model notes.

---

## License

MIT - Quinn Felton 2026

---

<div align="center">
Built by [Quinn Felton](https://github.com/quinnFelton) — [LinkedIn](https://www.linkedin.com/in/quinn-felton)

</div>
