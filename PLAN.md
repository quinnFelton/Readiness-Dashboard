# Oura + Strava + Terra Readiness Dashboard — Build Plan

**Owner:** Quinn Felton · **Status:** Planning → ready to scaffold
**Purpose of this document:** a complete technical spec meant to be dropped into a repo and used to drive a Claude Code build (one phase per agent/session). Each phase in §16 is scoped to be handed to an agent independently.

---

## 1. Product Overview

A personal web dashboard whose core analytic is **Power:HR efficiency (EF) trend vs. recovery context**: it compares how a user's ride power-to-heart-rate ratio (normalized power and peak-20-minute power, each against the heart rate during that same window) is moving against their resting HR and HRV trend, to tell true fitness gains apart from fatigue-driven changes in that ratio — earlier and more precisely than an hours/power-output estimate alone. A secondary daily composite score and general trend views round out the dashboard. Data sources are pluggable by role rather than fixed: one **activity source** (Strava today) and one-or-more **daily-metrics sources** (Oura and/or Zepp via Terra today), each selectable per user and extensible later without reworking the schema or scoring engine.

A **master user** role can see every connected user's data and drill into individual athletes — this is the same discovery-to-plan loop a coach runs with data, so the admin view should be designed with that lens even though it starts as a personal project.

**Initial scale:** 10 regular users + 1 master user (11 accounts). **Must scale later without a rearchitecture** — every design decision below treats "more users" as a traffic/cost question, not a schema question.

---

## 2. User & Access Model

- Two roles: `user` and `master`.
- `user`: sees only their own connected data, scores, and trends.
- `master`: sees a roster of all users plus per-user drill-down; same data, elevated scope — not a different data model.
- Enforce role checks **server-side on every endpoint**, not just in the UI.
- Every table carries `user_id` from day one, even though there are only 11 rows worth of users right now — this is what makes scaling additive later instead of a migration.

---

## 3. High-Level Architecture

```
                         ┌─────────────────────────┐
                         │   Next.js Frontend       │
                         │  (Amplify Hosting, SSR)  │
                         └────────────┬─────────────┘
                                      │ HTTPS (REST)
                         ┌────────────▼─────────────┐
                         │  API Gateway (HTTP API)   │
                         └────────────┬─────────────┘
                                      │
                  ┌───────────────────┼───────────────────┐
                  │                   │                   │
         ┌────────▼───────┐  ┌────────▼────────┐  ┌───────▼────────┐
         │  REST API       │  │  Terra Webhook   │  │  Scheduled Sync │
         │  Lambda (Express│  │  Receiver Lambda │  │  Lambda(s)      │
         │  via serverless-│  │  (signature-     │  │  (EventBridge:  │
         │  http)          │  │   verified)      │  │  Oura poll,     │
         └────────┬───────┘  └────────┬────────┘  │  Strava webhook │
                   │                   │            │  listener)      │
                   │                   │            └───────┬────────┘
                   └─────────┬─────────┴────────────────────┘
                             │
                  ┌──────────▼───────────┐
                  │  Aurora Serverless v2 │
                  │  (Postgres)           │
                  └──────────┬───────────┘
                             │
                  ┌──────────▼───────────┐
                  │  Scoring Engine        │
                  │  (shared package, runs │
                  │  inside sync Lambdas)  │
                  └────────────────────────┘
```

All compute is serverless (Lambda) and the database scales to near-zero at idle — appropriate for 11 users, and scales up automatically without a platform change if usage grows.

---

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript + React | Matches your existing React/React Native/TypeScript background; SSR fits Amplify Hosting cleanly |
| Styling | Tailwind CSS | Fast to build a data-dense dashboard without a design system from scratch |
| Charts | Recharts | Simple API for time-series line/area charts; swap for visx later if you want finer control |
| E2E testing | Playwright | Per your spec — covers real browser flows including OAuth redirect/callback handling |
| Unit testing | Vitest | Fast, TS-native; used mainly for the scoring engine |
| Backend | Node.js + Express (wrapped for Lambda via `serverless-http`) + TypeScript | REST API per your spec; Express keeps local dev simple, `serverless-http` lets the same app run in Lambda |
| Database | PostgreSQL via **Aurora Serverless v2** | Relational joins across users/providers/scores are a natural fit; Serverless v2 scales ACUs down near-zero at idle and up automatically later — no migration when you outgrow 10 users |
| Auth (app-level) | NextAuth.js + Postgres-backed sessions | Separate from the three provider OAuth connections below — this is *your* users logging into *your* dashboard |
| Secrets | AWS Secrets Manager (provider client secrets) + KMS (per-user token encryption) | Never store raw OAuth tokens in plaintext |
| Hosting (frontend) | AWS Amplify Hosting | Native Next.js SSR support, handles CDN/TLS automatically, minimal ops |
| Hosting (backend) | API Gateway (HTTP API) + Lambda | Pay-per-request; at 11 users this is effectively free-tier |
| Scheduling | EventBridge Scheduler | Drives the Oura polling Lambda |
| IaC | AWS CDK (TypeScript) | Keeps infra definitions in the same language as the app, easy for an agent to extend |
| CI/CD | GitHub Actions | Build/test on PR, deploy `main` to AWS |

---

## 5. Data Source Integrations

### 5.1 Oura (pull-based)

- **Auth:** OAuth2 Authorization Code flow. Store `access_token` + `refresh_token` encrypted (KMS) per user, plus `expires_at`.
- **Sandbox path:** since you don't own a ring yet, build and test against Oura's sandbox/test-user flow first; the adapter interface (below) means swapping in real tokens later touches zero application code.
- **Sync model:** scheduled Lambda (EventBridge, every 1–4h) calls, per connected user: `/v2/usercollection/daily_readiness`, `/v2/usercollection/daily_sleep`, `/v2/usercollection/daily_activity`, `/v2/usercollection/heartrate` — using each endpoint's date-range/pagination params to fetch only what's new since the last successful sync (track `last_synced_at` per connection).
- **Re-check at implementation time:** whether Oura now offers webhook/subscription delivery as an alternative to polling — if so, prefer it (see §14).

### 5.2 Strava (webhook-preferred)

- **Auth:** OAuth2 Authorization Code flow, scope `activity:read_all`. Access tokens expire in ~6h — the refresh-token exchange is mandatory, not optional; build it first.
- **Sync model:** subscribe to **Strava's native webhook events API** (activity create/update) rather than polling — Strava's shared app-wide rate limit (roughly 200 requests/15 min, 2,000/day at last check — confirm current limits in Strava's docs at implementation time) is tight enough that polling 10 users on a schedule risks burning it for no reason when a push model is available.
- **Streams are required, summary stats are not enough.** Computing normalized power and a peak-20-minute window needs the activity's *time-series* power and HR streams (`GET /activities/{id}/streams?keys=watts,heartrate,time`), not just the summary object. Strava's summary `weighted_average_watts` is close to NP but only present for power-meter rides on some account tiers — don't rely on it; compute NP yourself from the stream so the method is consistent across all users/activities (see §8).
- **Fetch streams selectively.** The streams endpoint is a separate, costlier call per activity against the same tight app-wide rate limit as everything else. Filter before fetching: skip stream processing for activities under ~20 minutes (can't produce a peak-20-min window anyway) and for non-ride activity types if you're scoping this to cycling first.
- **Training load:** compute a simple relative-effort metric per activity from duration × heart-rate-based intensity (or power-based TSS-equivalent where power data exists) — document the formula in code comments since it's a heuristic you'll likely tune.

### 5.3 Amazfit / Zepp via Terra (push-based, different shape)

Terra is architecturally different from the other two — it's an aggregator, not a direct device API, and it's **push-first**:

- **Credentials:** `dev_id` + API key from the Terra dashboard.
- **Connection flow:** backend calls Terra's `generateWidgetSession`; the frontend opens the returned widget URL; the user authenticates with their Zepp/Amazfit account inside Terra's hosted widget. Terra returns a `user_id` for that connection — pass your own internal user id as the `reference_id` so inbound webhook payloads can be matched back to a local user without a lookup table.
- **Data delivery:** primarily **webhooks** — Terra pushes new data backend-to-backend as soon as the provider makes it available. Register the webhook endpoint (API Gateway + Lambda) in the Terra dashboard.
- **Backfill:** Terra's pull endpoints (e.g. `/v2/activity`) are for **one-time historical backfill right after a user connects**, not ongoing sync — don't build a poller for Terra.
- **Signature verification (mandatory, do this before any payload processing):**
  - Header: `terra-signature`, format `t=<timestamp>,v1=<signature>`
  - Compute `HMAC-SHA256(signing_secret, "<timestamp>.<raw_request_body>")` and compare to `v1` using a constant-time comparison.
  - Reject anything that fails verification — never process an unverified payload.
- **Field names caveat:** pull the current webhook payload schema (sleep/activity/daily field names) from Terra's live docs during implementation rather than hardcoding from this plan — aggregator APIs like this evolve their normalized schema over time.

---

## 6. Backend Service Design

**Two independent "connection roles," not three fixed providers.** Per your requirement, a user picks *one* active **activity source** (Strava today) and one or more active **daily-metrics sources** (Oura and/or Zepp/Terra today), from a config-driven registry — not a hardcoded three-way integration. Adding Garmin, Whoop, or a manual upload later means registering a new adapter against an existing role, not touching the scoring/trend engine or the schema.

```ts
type ConnectionRole = "activity_source" | "daily_metrics_source";

// recovery-context scalars — one or more sources allowed per user
interface NormalizedDailyMetric {
  userId: string;
  date: string;             // YYYY-MM-DD
  source: "oura" | "terra" | string;   // string = future adapters, no schema change needed
  metricType: "hrv" | "resting_hr" | "sleep_score" | "readiness";
  value: number;
}

// per-activity, derived from power/HR streams — exactly one active activity source per user
interface NormalizedActivityEffort {
  userId: string;
  externalActivityId: string;   // natural key for idempotent upsert
  date: string;
  source: "strava" | string;
  durationSec: number;
  avgPower?: number;
  normalizedPower?: number;      // computed from stream, see §8
  avgHr: number;
  peak20Power?: number;          // best rolling 20-min average power
  peak20AvgHr?: number;          // HR during that same window — must match the power window, not the whole-ride avg
}

interface ProviderAdapter<T> {
  role: ConnectionRole;
  key: string;                   // "oura", "strava", "terra", future: "garmin", ...
  normalize(rawPayload: unknown): T[];
}
```

- Every adapter (`OuraAdapter`, `TerraAdapter` for `daily_metrics_source`; `StravaAdapter` for `activity_source`) implements the same `ProviderAdapter` contract for its role. The sync orchestrator looks up *which* adapter(s) are active per user from `connection_configs` (§7) rather than iterating a fixed list — this is what makes "scale and add more providers later without a major rework" true in practice, not just in intent.
- **Multi-source precedence for daily metrics:** when a user has both Oura and Zepp connected, define an explicit, auditable precedence per metric type (e.g., "HRV: prefer Oura if present that day, else Terra") rather than silently averaging or picking whichever synced last — store `source` alongside every `daily_metrics` row so a conflict is always traceable.
- Service layers: `AuthService`, `UserService`, `ConnectionConfigService` (manages which adapters are active per user/role), `SyncService` (orchestrates whichever adapters are configured), `ActivityEffortService` (stream fetch → runs the registered `ActivityEffortDeriver` variants, §8.8, and marks which is `is_default`), `FatigueFitnessService` (runs the registered `TrendClassifier` variants, §8.7, and marks which is `is_default`), `TrendService`.

### REST API surface (`/api/v1/...`)

| Method | Path | Purpose | Role |
|---|---|---|---|
| POST | `/auth/login` | App login (NextAuth-backed) | any |
| GET | `/users/me` | Current user profile | user |
| GET | `/users` | Roster of all users | master only |
| POST | `/connections/:provider/start` | Begin OAuth/widget flow | user |
| GET | `/connections/:provider/callback` | OAuth callback handler | user |
| DELETE | `/connections/:provider` | Disconnect + delete stored tokens | user |
| GET | `/scores/:userId?range=28d` | Readiness score series | user (self) / master (any) |
| GET | `/trends/:userId` | Trend/insight flags | user (self) / master (any) |
| POST | `/webhooks/terra` | Terra inbound webhook | signature-verified, no user auth |
| POST | `/webhooks/strava` | Strava inbound webhook | Strava's own verify-token challenge |

---

## 7. Data Model

```sql
-- app-level users (distinct from provider connections below)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL CHECK (role IN ('user','master')) DEFAULT 'user',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('oura','strava','terra')),
  role                TEXT NOT NULL CHECK (role IN ('activity_source','daily_metrics_source')),
  external_user_id    TEXT,               -- Terra's user_id, Oura/Strava athlete id
  access_token_enc    BYTEA,              -- KMS-encrypted
  refresh_token_enc   BYTEA,              -- KMS-encrypted
  expires_at          TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT true,   -- user-toggleable; see connection_configs below
  last_synced_at      TIMESTAMPTZ,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- which connection is authoritative per role, per user — this is what makes the
-- "user picks their activity source / daily-metrics source(s)" requirement real
CREATE TABLE connection_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('activity_source','daily_metrics_source')),
  provider            TEXT NOT NULL,
  priority            SMALLINT NOT NULL DEFAULT 0,  -- for daily_metrics_source: lower = preferred on conflict
  UNIQUE (user_id, role, provider)
);

CREATE TABLE daily_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  source          TEXT NOT NULL,       -- 'oura' | 'terra' | future adapters
  metric_type     TEXT NOT NULL,       -- 'hrv' | 'resting_hr' | 'sleep_score' | 'readiness'
  value           NUMERIC NOT NULL,
  derivation_version SMALLINT NOT NULL DEFAULT 1,   -- see §13 — bump when parsing logic changes
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, date, source, metric_type)
);
CREATE INDEX idx_daily_metrics_user_date ON daily_metrics (user_id, date);

-- derived, scalar-only — no raw stream data retained (§8, §13)
CREATE TABLE activity_efforts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_activity_id TEXT NOT NULL,   -- natural key from source, for idempotent upsert
  source              TEXT NOT NULL,
  date                DATE NOT NULL,
  duration_sec        INTEGER NOT NULL,
  avg_power           NUMERIC,
  normalized_power     NUMERIC,
  avg_hr              NUMERIC NOT NULL,
  peak20_power         NUMERIC,
  peak20_avg_hr        NUMERIC,
  ef_overall           NUMERIC,          -- normalized_power / avg_hr
  ef_peak20            NUMERIC,          -- peak20_power / peak20_avg_hr
  derivation_version   SMALLINT NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, external_activity_id)
);
CREATE INDEX idx_activity_efforts_user_date ON activity_efforts (user_id, date);

CREATE TABLE readiness_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  score           NUMERIC NOT NULL,
  components_jsonb JSONB NOT NULL,     -- {"recovery":..,"load_balance":..,"sleep":..}
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);
CREATE INDEX idx_readiness_user_date ON readiness_scores (user_id, date);

CREATE TABLE trends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric_type     TEXT NOT NULL,        -- 'hrv' | 'resting_hr' | 'ef_overall' | 'ef_peak20' | 'fatigue_fitness_state'
  window          TEXT NOT NULL CHECK (window IN ('7d','28d')),
  z_score         NUMERIC,
  direction       TEXT CHECK (direction IN ('up','down','flat',
                   'fitness_gain','overreaching_risk','acute_fatigue','ambiguous')),
  insight_text    TEXT,                -- plain-language flag, e.g. "EF rising while HRV falling — overreaching risk"
  flagged_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- short-retention audit/replay log, not for analytics
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,
  payload_jsonb   JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  status          TEXT CHECK (status IN ('pending','processed','failed'))
);
```

---

## 8. Core Analytic: Power:HR Decoupling vs. Recovery Context

**This is the product's actual IP — the rest of the system exists to feed it clean data. Treat it as the highest-value, most heavily-tested code in the repo, and build it as a standalone pure-function package (`packages/scoring-engine`) with no AWS/DB dependencies so it's trivial to unit test.**

### 8.1 Per-activity derivation (stream → scalars)

For every qualifying activity (≥20 min, has power + HR streams), compute from the raw `[timestamp, watts, heartrate]` stream and discard the stream itself afterward (§13):

- `avg_power`, `avg_hr` — straight averages over the full activity.
- `normalized_power` (NP) — the standard 30-second rolling-average-of-4th-power method: 30s rolling average of watts → raise each to the 4th power → mean → 4th root. This is the accepted way to represent variable-intensity effort as a single power number; don't substitute raw average power for it.
- `peak20_power` / `peak20_avg_hr` — the best rolling 20-minute window by average power, **and the HR averaged over that exact same window** (not the whole-ride HR — mismatching the windows is the easiest way to silently corrupt this metric). Find it with a sliding-window **prefix-sum** scan (O(n) over the stream, not O(n·window)) so it stays cheap even inside a Lambda with a tight timeout.
- `ef_overall = normalized_power / avg_hr`, `ef_peak20 = peak20_power / peak20_avg_hr` — Efficiency Factor in watts-per-beat. `ef_peak20` is the more sensitive signal (it isolates the hardest sustained effort, where decoupling shows up first); `ef_overall` is noisier but useful as a corroborating signal across easier rides too.
- Write one `activity_efforts` row per activity. **EF is sparse by design** — a rest day has no row, and that's correct; don't force a daily value by interpolating.

### 8.2 Trend baselines

For each of `ef_peak20` (primary), `ef_overall` (secondary), `resting_hr`, and `hrv`: compute a rolling 7-day mean and a 28-day baseline mean + stddev, then a z-score for the 7-day mean against the 28-day baseline. This reuses the same rolling-window machinery for all four series — one function, four inputs, not four bespoke implementations.

### 8.3 The classifier — this is the actual answer to "fatigue vs. fitness"

Cross the **direction of the EF trend** against the **direction of the recovery trend** (HRV + resting HR combined, same sign convention: recovery "up" = HRV up and/or resting HR down). Four quadrants:

| EF trend | Recovery trend | Classification | What it means |
|---|---|---|---|
| ↑ (more power per heartbeat) | stable/↑ | **`fitness_gain`** | Aerobic efficiency improving while well-recovered — the real thing, not a fatigue artifact. |
| ↑ | ↓ | **`overreaching_risk`** | Output is still improving but at rising physiological cost — the dangerous pattern that precedes a crash, and the one a pure power/duration estimate can't see at all. **This is the headline case you described wanting to catch earlier.** |
| ↓ (less power per heartbeat) | ↓ | **`acute_fatigue`** | Straightforward correlated fatigue — the expected, lower-urgency case. Recovery time should help. |
| ↓ | stable/↑ | **`ambiguous`** | EF dropped without a matching recovery signal — could be heat, altitude, pacing, nutrition, or illness not yet reflected in HRV. Flag for the user to review rather than auto-labeling; don't guess past what the data supports. |

Generate `insight_text` from whichever quadrant fires, store in `trends` with `metric_type = 'fatigue_fitness_state'`. This directly gives a user the "how did my recovery time actually affect me" view you wanted — each state change on the timeline is a labeled before/after.

### 8.4 Multi-activity days and daily metrics gaps

- If a user logs multiple qualifying rides in a day, don't collapse them into one daily EF value — keep per-activity granularity and let the 7d/28d rolling window operate across all qualifying activities in that window, regardless of which exact days they fall on. Forcing a daily bucket loses information for exactly the users who ride most.
- The classifier needs **both** an EF trend point and a recovery trend point to fire for a given window. Daily-metrics sync (morning, typically) and activity sync (after a ride, typically later) land at different times — design the trigger as "on either sync's completion, check whether enough data now exists to (re)run the classifier for the affected window," not "always recompute on every sync regardless of what's missing."
- **Compute on sync, not on page load** — same principle as before: the dashboard only ever reads precomputed `trends`/`activity_efforts` rows, keeping page loads fast and compute cost near-zero at 11 users.

### 8.5 Testing

Unit test (Vitest) with synthetic stream fixtures, at minimum: a clean steady-state ride (sanity-check NP math against a hand-computed value), a ride with a clear 20-minute threshold effort embedded in junk miles (verify the window-finder isolates it correctly), a synthetic multi-day sequence showing HR drift at constant power (the textbook decoupling case — verify `acute_fatigue`/`overreaching_risk` fires correctly depending on the paired recovery trend), and a missing-data case (no HRV connected yet — verify the classifier abstains rather than guessing).

### 8.6 Where the composite `readiness_scores` table fits

The quadrant classifier (§8.3) is the primary insight — it's what should headline the dashboard. The `readiness_scores` table in §7 still exists for a simpler day-level number (useful at a glance, and on days with no ride to classify), but it's now explicitly secondary: a light blend of that day's recovery metrics alone, not a replacement for the EF-vs-recovery analysis. Don't spend early build time tuning its weights — the classifier is where the real product value is.

---

### 8.7 Running multiple classifiers side-by-side (champion/challenger)

The threshold choices in §8.3 (and any future alternative approach — different z-score cutoffs, EF-only vs. EF+recovery, eventually a learned model) are exactly the kind of thing you'll want to compare empirically rather than commit to by guess. The architecture supports this cheaply if the classifier is treated as a registered strategy rather than a single hardcoded function:

```ts
interface TrendClassifier {
  id: string;                                       // "ef_quadrant_v1", "ef_quadrant_tight_v1", ...
  classify(efTrend: TrendSeries, recoveryTrend: TrendSeries): ClassificationResult;
}
```

- **Run every registered classifier on every compute pass**, not just the live one — they're pure functions over already-derived EF/recovery series, so this stays near-zero cost even with several variants active (no raw data is re-touched, consistent with §13's cost philosophy).
- **Tag output so variants don't collide:**
  ```sql
  ALTER TABLE trends ADD COLUMN classifier_id TEXT NOT NULL DEFAULT 'ef_quadrant_v1';

  CREATE TABLE classifiers (
    id           TEXT PRIMARY KEY,
    description  TEXT,
    is_default   BOOLEAN NOT NULL DEFAULT false,   -- which one the dashboard shows by default
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  Only the `is_default` classifier's rows drive what a regular user sees; the rest compute silently (the standard **champion/challenger / shadow deployment** pattern) until one earns promotion.
- **"More accurate" needs a concrete definition before it's measurable** — two complementary mechanisms, worth building together rather than picking one:
  - **Agreement feedback:** a thumbs-up/down on individual flagged insights (§9, Product Perspective in `README.md`), recorded against `classifier_id` — aggregate it into an agreement-rate comparison across variants.
  - **Outcome backtesting:** a lightweight `athlete_events` table (`date`, `event_type` ∈ {illness, injury, race, planned_rest}, `notes`) a coach or athlete logs after the fact, letting you check retroactively whether `overreaching_risk` fired *before* a real event, per classifier. Stronger signal, but depends on someone logging events — don't block the comparison framework on it existing from day one.
- **Suggested build point:** add this once Phase 5's single classifier is stable and you have a few weeks of real data to compare against — building the comparison framework before there's data to compare is wasted motion.

### 8.8 Running multiple activity-effort derivers side-by-side

Same idea as §8.7, one layer earlier. The window-selection variations in `ANALYTIC-IMPROVEMENTS.md` — plain peak-20, terrain-stable (A1), W′-balance-filtered (A2), temperature-aware (A3), algorithmic segment-matching (D2a) — are different ways of turning a raw stream into `activity_efforts` scalars, and are exactly the kind of thing worth comparing empirically rather than picking one by guess. The fix is the same shape as §8.7, applied to §8.1 instead of §8.3:

```ts
interface ActivityEffortDeriver {
  id: string;   // "peak20_v1", "peak20_terrain_stable_v1", "peak20_wbal_filtered_v1", ...
  derive(stream: ActivityStream): NormalizedActivityEffort[];
}
```

- **Run every registered deriver on every qualifying activity**, not just the live one — all of them operate on the single already-fetched stream (§5.2's selective-fetch guidance still governs *fetching*, before any deriver runs), so adding more derivers doesn't add more Strava API calls.
- **Tag output so variants don't collide, same as §8.7:**
  ```sql
  ALTER TABLE activity_efforts DROP CONSTRAINT activity_efforts_user_id_external_activity_id_key;
  ALTER TABLE activity_efforts ADD COLUMN deriver_id TEXT NOT NULL DEFAULT 'peak20_v1';
  ALTER TABLE activity_efforts ADD CONSTRAINT activity_efforts_user_activity_deriver_key
    UNIQUE (user_id, external_activity_id, deriver_id);

  CREATE TABLE derivers (
    id           TEXT PRIMARY KEY,
    description  TEXT,
    is_default   BOOLEAN NOT NULL DEFAULT false,   -- which one feeds the live classifier
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  Only the `is_default` deriver's rows feed the `is_default` classifier (§8.7) for what a regular user sees; other derivers compute and store silently.
- **Validating a deriver is one step further from ground truth than validating a classifier, so hold one axis constant at a time** — comparing every deriver against every classifier variant is combinatorial and hard to interpret at 10 users. Practical approach: run every registered deriver's output through the *same* default classifier, and compare on signal quality — does this deriver's EF series produce fewer spurious `ambiguous` flags or less day-to-day noise across a known-steady training block, and, where logged, does it flag `overreaching_risk` ahead of real `athlete_events` (§8.7) more reliably than another deriver's would have.
- **Don't conflate a bug fix with a new approach.** §13's `derivation_version` is still for fixing a given deriver's output after a correctness bug; a genuinely different window-selection strategy is a new `deriver_id`, not a version bump on an existing one.
- **Suggested build point:** same guidance as §8.7 — add this once you're actually implementing a second window-selection approach (e.g., A1 after the baseline peak-20 deriver is stable), not before there's a second deriver to compare against the first.

## 9. Frontend (Next.js)

- **Routes:** `/login`, `/dashboard` (self-view: hero fatigue/fitness quadrant state + EF trend chart), `/dashboard/trends` (per-metric breakdown: EF, HRV, resting HR individually), `/admin` (master-only: roster + per-athlete drill-down), `/settings/connections` (pick the active activity source and one-or-more daily-metrics sources from the registered adapters, with per-metric precedence when more than one daily-metrics source is active, connection status, disconnect).
- **Hero chart:** EF (peak-20 primary) plotted against HRV/resting HR on a shared timeline, with the quadrant classification (§8.3) shown as a colored band or marker per period — this is the single view that answers "is this fatigue or fitness."
- **Data fetching:** Server Components calling the backend REST API server-side — provider access tokens and the backend's own session logic never reach the client bundle.
- **Auth-aware rendering:** `/admin` route guarded both server-side (middleware checks role from session) and hidden from nav for `user`-role accounts — never rely on UI hiding alone.
- **Charts:** Recharts line/area charts for the readiness score series and per-source trend lines; keep one shared chart component parameterized by metric rather than one-off components per chart.

---

## 10. Testing Plan (Playwright)

Critical flows to cover end-to-end:

1. Login (valid/invalid credentials)
2. Connect Oura — mock the OAuth callback redirect
3. Connect Strava — mock the OAuth callback redirect
4. Connect Terra — mock the widget flow's redirect/postMessage back to the app
5. Dashboard renders a readiness score and trend chart for a seeded user
6. Master user sees the full roster and can drill into an individual athlete's dashboard
7. Regular user is blocked from `/admin` (negative test — assert redirect/403, not just absence of a nav link)
8. Disconnecting a provider removes its data from subsequent dashboard renders

**Mock all third-party OAuth/webhook calls in CI** via Playwright route interception rather than hitting real Oura/Strava/Terra endpoints in automated tests — keeps the suite fast, deterministic, and independent of sandbox account availability.

Unit tests (Vitest) focus on the scoring engine (§8) with deterministic fixtures — this is where real bugs will hide, and it's the one module that's pure functions, so it's cheap to test thoroughly.

---

## 11. AWS Hosting Plan

| Component | Service | Notes |
|---|---|---|
| Frontend | **Amplify Hosting** | Native Next.js SSR, auto CDN/TLS, minimal ops |
| Backend API | **API Gateway (HTTP API) + Lambda** | Express app via `serverless-http`; pay-per-request |
| Scheduled sync | **EventBridge Scheduler → Lambda** | Oura polling only; Strava/Terra are webhook-driven |
| Webhook receivers | **API Gateway + Lambda** | Terra + Strava inbound |
| Database | **Aurora Serverless v2 (Postgres)** | Scales ACUs toward zero at idle; scales up automatically later with no migration |
| Secrets | **Secrets Manager** (provider client secrets) + **KMS** (per-user token encryption key) | Never store raw tokens in plaintext |
| IAM | One execution role per Lambda, least-privilege | Sync Lambdas: Secrets Manager read + RDS write; webhook Lambdas: RDS write only; API Lambda: RDS read/write |
| Observability | CloudWatch Logs + Alarms (sync failures, webhook signature failures) → SNS → email | You're the only on-call, keep it simple |

**Cost expectation:** this stack is deliberately chosen to cost near-$0/month at 11 users — serverless compute billed per request and Aurora Serverless v2 billed per ACU-second scaling toward zero at idle. Confirm current AWS pricing before committing, but the architecture is designed around "don't pay for idle capacity" rather than a fixed monthly baseline.

---

## 12. Security

- Encrypt OAuth tokens at rest (KMS-backed column encryption); never log raw tokens or raw webhook payloads at INFO level.
- Enforce RBAC server-side on every endpoint — the `/admin`-only and `master`-only checks live in middleware, not in the frontend.
- HTTPS everywhere (API Gateway + Amplify both terminate TLS by default — don't disable it anywhere).
- **Verify every Terra webhook signature before processing** (§5.3) — reject anything that fails.
- Rate-limit the public API via API Gateway throttling.
- Scope OAuth requests to the minimum needed — don't request broader Strava/Oura scopes than the metrics actually used.
- Build per-user data export/delete from the start. HRV, sleep, and recovery data is sensitive health data even in a personal project with 10 friends/clients on it — treat it that way from day one rather than retrofitting deletion later.

---

## 13. Storage & Compute Efficiency

- **Don't retain raw streams or raw payloads at all** — process immediately on ingestion into `activity_efforts`/`daily_metrics` scalars and discard the source payload. This is more aggressive than a typical TTL-based raw-data policy, and it's the right call here specifically because the raw input (a multi-hour second-by-second power/HR stream) is orders of magnitude larger than the handful of scalars derived from it, and those scalars are genuinely all the product needs downstream.
- **`derivation_version`** (added to both `activity_efforts` and `daily_metrics` in §7) is what makes "no raw retention" safe: if the EF formula or peak-window algorithm changes later, rows with a stale `derivation_version` are identifiable, and *those specific activities* can be re-pulled from Strava/Oura/Terra (which still hold the source data indefinitely) and reprocessed — a rare, deliberate, bounded operation, not a standing cost you pay on every row forever.
- **Idempotent upserts, not append-only:** `activity_efforts` is keyed on `(user_id, external_activity_id)` — a retried sync (Lambda timeout/retry) re-derives and `ON CONFLICT DO UPDATE`s the same row rather than creating a duplicate. Same pattern for `daily_metrics` on `(user_id, date, source, metric_type)`.
- Precompute and cache `trends`/`readiness_scores` on sync, never recompute on dashboard load (§8.4).
- Index `activity_efforts` and `daily_metrics` on `(user_id, date)` — the only real query pattern the dashboard has.
- `webhook_events` is a debugging/audit log, not an analytics table — TTL it aggressively (e.g., delete rows older than 30 days via a scheduled Lambda). Since raw payloads are no longer retained in the main tables at all, this becomes the *only* place raw data briefly exists, which also narrows your sensitive-data exposure surface (§12) to one short-lived table instead of the whole dataset.

**A few more optimization ideas worth building in from the start, since they're cheap now and expensive to retrofit:**

- **Let Strava's own webhook tell you what changed.** The webhook payload is small — just an activity id and an aspect type (create/update/delete) — so fetch and process *only that one activity's* streams rather than re-scanning a user's activity list on every event. This is both cheaper and avoids the rate limit entirely for steady-state usage.
- **Watch Strava's rate-limit response headers** (`X-RateLimit-Usage`/`-Limit`) and back off proactively as you approach the ceiling, rather than discovering the limit via a 429. Trivial to add in the adapter, saves a class of flaky-sync bugs later.
- **Don't add a queue or Step Functions orchestration yet.** At 11 users, a single Lambda looping over connected users per sync run is simpler to reason about and debug than a fan-out architecture — that complexity belongs in §14 (Scaling Path), not v1. Resist adding it preemptively.
- **Materialize the admin roster's "latest state per user" only if it's ever actually slow.** `SELECT DISTINCT ON (user_id) ... ORDER BY user_id, flagged_at DESC` against `trends` is cheap at 10 users; a materialized view or denormalized summary table is a later optimization, not a day-one requirement.

---

## 14. Scaling Path (beyond 10 users)

- Schema is already multi-tenant (`user_id` everywhere) — onboarding more users is a data-volume change, not a design change.
- Aurora Serverless v2 absorbs load growth automatically; add **RDS Proxy** if Lambda concurrency starts exhausting Postgres connections at higher scale.
- Re-check whether Oura offers webhook/subscription delivery by the time you implement — if so, retire the EventBridge poller in favor of it, matching the Strava/Terra push model.
- Introduce **SQS** between "event received" and "process metric" once sync volume could exceed a comfortable single-Lambda processing window — decouples ingestion from scoring under load.
- Add Redis/ElastiCache only if dashboard read latency actually becomes a problem — unnecessary at 11 users, premature before then.

---

## 15. Repo Structure

```
oura-readiness-dashboard/
  apps/
    web/                   # Next.js app (App Router)
    api/                   # Express backend, Lambda-wrapped
  packages/
    shared-types/          # NormalizedDailyMetric, NormalizedActivityEffort, User, ProviderConnection, etc.
    scoring-engine/         # Pure-function NP/peak-20/EF derivation + quadrant classifier (§8); registered `ActivityEffortDeriver` (§8.8) and `TrendClassifier` (§8.7) variants both live here, unit-tested standalone
    provider-adapters/       # oura.ts, strava.ts, terra.ts — common ProviderAdapter<T> interface, registered by role (§6)
  infra/
    cdk/                    # AWS CDK app (TypeScript) — all AWS resources defined here
  tests/
    e2e/                    # Playwright specs
  CLAUDE.md                 # project-level instructions for Claude Code agents working in this repo
  PLAN.md                   # this document
```

---

## 16. Implementation Phases / Agent Task Breakdown

Each phase below is sized to be one Claude Code agent session/task.

| # | Phase | Scope |
|---|---|---|
| 0 | Scaffolding | Monorepo (npm/pnpm workspaces), TypeScript config, lint/format, CI skeleton, `CLAUDE.md` |
| 1 | Auth & User Model | `users` table, NextAuth wiring, RBAC middleware, seed 10 `user` + 1 `master` account |
| 2 | Connection Framework | `provider_connections` + `connection_configs` tables, `ProviderAdapter<T>` interface, registry + per-user role selection (§6) — build this *before* any single provider, so Oura/Terra/Strava all plug into it rather than being bespoke |
| 3 | Daily Metrics Sources | `OuraAdapter` (OAuth + sandbox) and `TerraAdapter` (widget flow + signature-verified webhook + backfill), both against the Phase 2 framework, normalized storage |
| 4 | Activity Source & Stream Derivation | `StravaAdapter` (OAuth + refresh + webhook), selective stream fetch, NP/peak-20-window/EF computation (§8.1) with prefix-sum windowing, idempotent `activity_efforts` upserts |
| 5 | Fatigue/Fitness Classifier | Rolling 7d/28d baselines, the EF-vs-recovery quadrant classifier (§8.2–8.4), insight-text generation, Vitest fixtures per §8.5 |
| 6 | Dashboard UI | Hero EF-vs-recovery chart with quadrant states, per-metric trend views, admin roster view, connections/settings page (source picker + precedence config) |
| 7 | E2E Testing | Full Playwright suite per §10 |
| 8 | AWS Deployment | CDK stacks, Amplify Hosting, Secrets Manager wiring, CloudWatch alarms |
| 9 | Hardening | Token-encryption audit, rate limiting, data export/delete endpoints, real AWS cost check against §11's estimate |

---

## 17. Open Assumptions to Confirm Before/During Build

- **Express vs Fastify:** defaulted to Express for familiarity with your existing Node.js experience; swapping is low-cost if preferred.
- **Strava webhooks for v1:** recommended over polling, but it's one more endpoint to stand up in Phase 3 — polling is a valid fallback if you want Phase 3 to ship faster.
- **Oura webhook/subscription availability:** re-check at implementation time; prefer it over the EventBridge poller if available.
- **Terra webhook payload field names:** pull the current schema from Terra's live docs during Phase 4 rather than from this plan — don't hardcode field names from memory.
- **Chart library:** Recharts assumed for speed; swap for visx/d3 if you want finer control over the composite score visualization.
- **EF formula choice:** `NP/avg_hr` and `peak20_power/peak20_avg_hr` are the standard Friel-style Efficiency Factor definitions — confirm this matches how you coach it before Phase 5, since the quadrant classifier's labels are only as meaningful as the EF definition underneath them.
- **Quadrant thresholds:** the §8.3 classifier currently treats trend "direction" as a simple sign off the 7d-vs-28d z-score — decide the actual z-score cutoff for "stable" vs. "up"/"down" (the plan assumes something like ±0.5–1.0 as a dead zone) once you have real data to calibrate against; this is exactly the kind of constant worth making config, not hardcoded.
- **Multi-source precedence defaults:** when both Oura and Zepp are connected, the plan assumes you'll set an explicit per-metric priority (§6, §7) rather than auto-averaging — confirm Oura-preferred is actually the right default once you're comparing the two side by side.

---

### Sources consulted while writing this plan
- [Terra API — Getting Started](https://docs.tryterra.co/unified-api/getting-started)
- [Terra API — Webhooks](https://docs.tryterra.co/unified-api/integration-setup/setting-up-data-destinations/webhooks)
- [Terra — Zepp Integration](https://tryterra.co/integrations/zepp)
- [Terra — Amazfit Integration](https://tryterra.co/integrations/amazfit)
