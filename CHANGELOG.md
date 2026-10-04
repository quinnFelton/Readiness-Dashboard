# PLAN.md Changelog

Running log of substantive revisions to `PLAN.md`, newest first. Each entry gives the triggering question, the exact diff, and the reasoning behind the shape of the change.

---

## Activity-effort deriver comparison framework (§8.8)

**Trigger:** confirming that the §8.7 classifier-comparison framework would also make the window-selection ideas in `ANALYTIC-IMPROVEMENTS.md` (terrain-stable windows, W′-balance filtering, temperature awareness, algorithmic segment-matching) easier to compare — it doesn't, since those operate one layer earlier (deriving `activity_efforts` from a raw stream, §8.1) than what §8.7 covers (classifying an already-derived EF trend, §8.3). This entry adds the same pattern to that earlier layer.

### New section — §8.8, inserted after §8.7

```markdown
### 8.8 Running multiple activity-effort derivers side-by-side

Same idea as §8.7, one layer earlier. The window-selection variations in `ANALYTIC-IMPROVEMENTS.md` — plain peak-20, terrain-stable (A1), W′-balance-filtered (A2), temperature-aware (A3), algorithmic segment-matching (D2a) — are different ways of turning a raw stream into `activity_efforts` scalars, and are exactly the kind of thing worth comparing empirically rather than picking one by guess. The fix is the same shape as §8.7, applied to §8.1 instead of §8.3:

\`\`\`ts
interface ActivityEffortDeriver {
  id: string;   // "peak20_v1", "peak20_terrain_stable_v1", "peak20_wbal_filtered_v1", ...
  derive(stream: ActivityStream): NormalizedActivityEffort[];
}
\`\`\`

- **Run every registered deriver on every qualifying activity**, not just the live one — all of them operate on the single already-fetched stream (§5.2's selective-fetch guidance still governs *fetching*, before any deriver runs), so adding more derivers doesn't add more Strava API calls.
- **Tag output so variants don't collide, same as §8.7:**
  \`\`\`sql
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
  \`\`\`
  Only the `is_default` deriver's rows feed the `is_default` classifier (§8.7) for what a regular user sees; other derivers compute and store silently.
- **Validating a deriver is one step further from ground truth than validating a classifier, so hold one axis constant at a time** — comparing every deriver against every classifier variant is combinatorial and hard to interpret at 10 users. Practical approach: run every registered deriver's output through the *same* default classifier, and compare on signal quality — does this deriver's EF series produce fewer spurious `ambiguous` flags or less day-to-day noise across a known-steady training block, and, where logged, does it flag `overreaching_risk` ahead of real `athlete_events` (§8.7) more reliably than another deriver's would have.
- **Don't conflate a bug fix with a new approach.** §13's `derivation_version` is still for fixing a given deriver's output after a correctness bug; a genuinely different window-selection strategy is a new `deriver_id`, not a version bump on an existing one.
- **Suggested build point:** same guidance as §8.7 — add this once you're actually implementing a second window-selection approach (e.g., A1 after the baseline peak-20 deriver is stable), not before there's a second deriver to compare against the first.
```

### §6 Backend Service Design — `ActivityEffortService` description updated

**Before:**
> `ActivityEffortService` (stream fetch → NP/peak-20 derivation, §8)

**After:**
> `ActivityEffortService` (stream fetch → runs the registered `ActivityEffortDeriver` variants, §8.8, and marks which is `is_default`)

### §15 Repo Structure — `scoring-engine` description updated

**Before:**
> `scoring-engine/` — Pure-function NP/peak-20/EF derivation + quadrant classifier (§8), unit-tested standalone

**After:**
> `scoring-engine/` — Pure-function NP/peak-20/EF derivation + quadrant classifier (§8); registered `ActivityEffortDeriver` (§8.8) and `TrendClassifier` (§8.7) variants both live here, unit-tested standalone

### Why this shape

- Mirrors §8.7 deliberately — one registry pattern, applied at both layers where "try several approaches, compare, promote the winner" applies, rather than two different mechanisms to remember.
- The `UNIQUE` constraint change on `activity_efforts` (adding `deriver_id`) is the one structurally necessary piece — without it, a second deriver's output would silently collide with (or be blocked by) the first deriver's row for the same activity, defeating the whole point of running them side by side.
- Explicitly separates *fixing* a deriver (`derivation_version`, §13) from *replacing* it with a different approach (`deriver_id`) — conflating the two would make it impossible to tell later whether an EF change came from a bug fix or a genuinely different method.
- Deliberately scopes validation to "hold one axis constant" rather than a full deriver × classifier comparison matrix — correct in principle, but not interpretable with 10 users' worth of data, and not worth the added complexity at this scale.

---

## Classifier comparison framework (§8.7)

**Trigger:** a question about how easily the plan supports building and comparing multiple trend-classifier variants side by side, to find the most accurate one before committing to a single algorithm for the final product.

### New section — §8.7, inserted after §8.6

```markdown
### 8.7 Running multiple classifiers side-by-side (champion/challenger)

The threshold choices in §8.3 (and any future alternative approach — different z-score cutoffs, EF-only vs. EF+recovery, eventually a learned model) are exactly the kind of thing you'll want to compare empirically rather than commit to by guess. The architecture supports this cheaply if the classifier is treated as a registered strategy rather than a single hardcoded function:

\`\`\`ts
interface TrendClassifier {
  id: string;                                       // "ef_quadrant_v1", "ef_quadrant_tight_v1", ...
  classify(efTrend: TrendSeries, recoveryTrend: TrendSeries): ClassificationResult;
}
\`\`\`

- **Run every registered classifier on every compute pass**, not just the live one — they're pure functions over already-derived EF/recovery series, so this stays near-zero cost even with several variants active (no raw data is re-touched, consistent with §13's cost philosophy).
- **Tag output so variants don't collide:**
  \`\`\`sql
  ALTER TABLE trends ADD COLUMN classifier_id TEXT NOT NULL DEFAULT 'ef_quadrant_v1';

  CREATE TABLE classifiers (
    id           TEXT PRIMARY KEY,
    description  TEXT,
    is_default   BOOLEAN NOT NULL DEFAULT false,   -- which one the dashboard shows by default
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  \`\`\`
  Only the `is_default` classifier's rows drive what a regular user sees; the rest compute silently (the standard **champion/challenger / shadow deployment** pattern) until one earns promotion.
- **"More accurate" needs a concrete definition before it's measurable** — two complementary mechanisms, worth building together rather than picking one:
  - **Agreement feedback:** a thumbs-up/down on individual flagged insights (§9, Product Perspective in `README.md`), recorded against `classifier_id` — aggregate it into an agreement-rate comparison across variants.
  - **Outcome backtesting:** a lightweight `athlete_events` table (`date`, `event_type` ∈ {illness, injury, race, planned_rest}, `notes`) a coach or athlete logs after the fact, letting you check retroactively whether `overreaching_risk` fired *before* a real event, per classifier. Stronger signal, but depends on someone logging events — don't block the comparison framework on it existing from day one.
- **Suggested build point:** add this once Phase 5's single classifier is stable and you have a few weeks of real data to compare against — building the comparison framework before there's data to compare is wasted motion.
```

### §6 Backend Service Design — `FatigueFitnessService` description updated

**Before:**
> `FatigueFitnessService` (the EF-vs-recovery classifier, §8)

**After:**
> `FatigueFitnessService` (runs the registered `TrendClassifier` variants, §8.7, and marks which is `is_default`)

### Why this shape

- No schema rework — `classifier_id` is an additive column, `classifiers` is a new table, neither touches existing data.
- Reuses the pure-function design already committed to for `scoring-engine` (§8), so a new classifier variant is a new implementation of one interface, not a parallel system.
- Keeps the project's cost discipline intact (§13): classifiers run over already-derived series, not raw streams, so running several in parallel doesn't reintroduce compute or storage cost.
