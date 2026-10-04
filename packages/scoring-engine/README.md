# @rd/scoring-engine

Pure TypeScript implementation of PLAN §8.1–8.4: stream → per-activity scalars → rolling
baselines → fatigue/fitness quadrant. No I/O, DB, AWS, network, clock reads or randomness.
Every "now" is passed in as `asOf`. Current `DERIVATION_VERSION`: **1** (bump on any output
change, CLAUDE.md rule 5).

## Public API

| Function                                                  | Purpose                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `deriveActivityEffort(stream, opts?)`                     | Stream → `activity_efforts` scalars, or a rejection reason |
| `normalizedPower(stream, opts?)`                          | NP                                                         |
| `peakWindow(stream, seconds, opts?)`                      | Best window by mean power, HR from the same window         |
| `rollingBaseline(series, {shortDays, longDays}, asOf)`    | 7 d mean vs 28 d mean/SD → z                               |
| `recoveryTrend(hrvBaseline, restingHrBaseline, config?)`  | HRV + resting HR → recovery z/direction                    |
| `classifyFatigueFitness(efTrend, recoveryTrend, config?)` | Quadrant state + insight text                              |

Constants/defaults: `DERIVATION_VERSION`, `DEFAULT_CLASSIFIER_CONFIG`,
`DEFAULT_EFFORT_OPTIONS`, `DEFAULT_BASELINE_WINDOWS`. Lower-level helpers (`resampleTo1Hz`,
`normalizedPowerFromGrid`, `peakWindowFromGrid`, `dayNumber`, `directionFromZ`, `formatZ`,
`validateClassifierConfig`) are also exported.

## 1. Stream input and sampling (`stream.ts`)

Input is `{ t: seconds, watts?: number | null, hr?: number | null }[]`, in any order and
at any rate. Everything is computed on a **1 Hz grid of active seconds**, built like this:

- **Zero-order hold, time-weighted.** Sample _i_ holds its values over `[tᵢ, tᵢ₊₁)`. Each
  1 s bucket is the time-weighted mean of the holds overlapping it. So 1 Hz data passes
  through unchanged, faster data (e.g. 2 Hz) is averaged per second, and slower "smart
  recording" data (e.g. one sample per 5 s) is held forward.
- **Gaps > `maxGapSec` (default 10 s) are collapsed, not zero-filled.** The sample before
  the gap holds for a nominal 1 s, then the clock resumes at the next sample. A recording
  gap (auto-pause, café stop, dropout) has neither power nor HR, so dropping it keeps
  power and HR on the same seconds. The grid keeps each active second's original `t`, so
  peak-window start/end are reported in stream time (a window can span a collapsed gap).
- **Watts:** `null`, `undefined`, NaN or negative counts as **0 W** for power math and is
  excluded from `powerCoverage`. A recorded `0` is valid (coasting) and counts toward
  coverage.
- **HR:** `null`, `undefined`, NaN or ≤ 0 is **excluded**. Such seconds have `hr = null`,
  and HR means run over HR-present seconds only.
- The last sample holds for a nominal 1 s. Samples with a non-finite `t` are dropped. With
  duplicate timestamps the later sample wins.

## 2. Per-activity formulas (`power.ts`, `effort.ts`, PLAN §8.1)

| Output                        | Formula                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `durationSec`                 | active (gap-collapsed) seconds, rounded                                                                |
| `avgPower`                    | mean of grid watts (missing = 0 W)                                                                     |
| `avgHr`                       | mean of grid HR over HR-present seconds                                                                |
| `normalizedPower`             | 30 s rolling mean of watts (full windows only; first value at second 30) → ⁴ → mean → ⁴√               |
| `peak20Power`                 | max over all 1200 s windows of mean watts, via an O(n) prefix-sum scan; ties go to the earliest window |
| `peak20AvgHr`                 | mean HR over **exactly the same grid seconds** as `peak20Power` (never whole-ride HR)                  |
| `peak20StartT` / `peak20EndT` | original `t` of the window's first second / last second + 1                                            |
| `efOverall`                   | `normalizedPower / avgHr`                                                                              |
| `efPeak20`                    | `peak20Power / peak20AvgHr`                                                                            |

EF is in watts per bpm. Everything is returned at full precision; rounding is left to
storage/display.

**Qualification** (`DEFAULT_EFFORT_OPTIONS`, all overridable):

| Option             | Default                  | Effect when failed                                       |
| ------------------ | ------------------------ | -------------------------------------------------------- |
| `minDurationSec`   | 1200 (20 min, PLAN §8.1) | `reason: 'too_short'`                                    |
| `minPowerCoverage` | 0.9                      | `reason: 'insufficient_power'` (also when coverage is 0) |
| `minHrCoverage`    | 0.9                      | `reason: 'insufficient_hr'` (also when coverage is 0)    |
| `maxGapSec`        | 10                       | gap-collapse threshold (see §1)                          |

`minHrCoverage` also applies to the peak20 window on its own. If the best-power window
has less HR coverage than that, `peak20AvgHr` and `efPeak20` are `null`; we don't pick a
different window. An empty stream gives `reason: 'empty_stream'`. A rejection still
reports `durationSec` and both coverages, for logging.

## 3. Rolling baselines (`baseline.ts`, PLAN §8.2)

One function serves `ef_peak20`, `ef_overall`, `hrv` and `resting_hr`. Input is
`{ date: 'YYYY-MM-DD', value }[]`.

- **Points, not days.** Several activities on one date each count separately (PLAN §8.4).
  Rest days are simply absent, and nothing is interpolated.
- **Windows** are calendar days ending at `asOf`, inclusive. Short: `asOf-6 … asOf`; long:
  `asOf-27 … asOf`. Points dated after `asOf` and non-finite values are ignored. Malformed
  dates throw.
- **By default the long window includes the short window**, the literal reading of PLAN
  §8.2. `longExcludesShort: true` compares against the `longDays` immediately before the
  short window instead.
- `z = (shortMean − longMean) / longStdDev`, where `longStdDev` is the **sample** (n − 1)
  SD.
- `z = null` when there are no short-window points, fewer than 2 long-window points, or the
  SD is zero and the means differ (z would be ±∞). A flat baseline matched exactly gives
  `z = 0`. "Zero" uses a relative tolerance of 1e-9 to absorb float noise.

## 4. Recovery trend (`classifier.ts`, PLAN §8.3)

Sign convention: recovery **up** means HRV up and/or resting HR down.

```
recovery z = mean(hrvZ, −restingHrZ)      (over whichever signals are usable)
```

A signal is usable if its baseline exists, has ≥ `recoveryMinShortPoints` short and
≥ `recoveryMinLongPoints` long points, and has a non-null z. By default **both** signals
are required (`allowSingleRecoverySignal: false`), so "no HRV connected yet" abstains
(PLAN §8.5). Opposing signals (HRV up _and_ RHR up) cancel toward flat.

## 5. Classifier (`classifier.ts`, PLAN §8.3–8.4)

Direction from z with dead zone `d`: `z > d` → up, `z < −d` → down, `|z| ≤ d` → **flat**
(the boundary itself is flat).

| EF                    | Recovery  | State               |
| --------------------- | --------- | ------------------- |
| up                    | flat / up | `fitness_gain`      |
| up                    | down      | `overreaching_risk` |
| down                  | down      | `acute_fatigue`     |
| down                  | flat / up | `ambiguous`         |
| flat                  | any       | `steady`            |
| any side lacking data |           | `insufficient_data` |

`efTrend` should be the `ef_peak20` baseline (the primary signal, PLAN §8.2). The
classifier applies its **own** config's dead zone to the recovery z, so the result never
depends on how the `RecoveryTrend` was built. `insufficient_data` insight text lists every
missing piece (e.g. "EF: short window has 1 (needs 2), long window has 5 (needs 6); no HRV
data"). PLAN §8.3 has no row for flat EF; by owner decision (2026-10-04) it maps to
`steady` ("steady fitness and fatigue"), with an early-warning note if recovery is falling.

**`DEFAULT_CLASSIFIER_CONFIG`** (PLAN §17: calibrate on real data):

| Key                         | Default | Meaning                                                   |
| --------------------------- | ------- | --------------------------------------------------------- |
| `efDeadZone`                | 0.5     | \|EF z\| ≤ this is flat                                   |
| `recoveryDeadZone`          | 0.5     | \|recovery z\| ≤ this is flat                             |
| `efMinShortPoints`          | 2       | qualifying rides needed in the 7 d window                 |
| `efMinLongPoints`           | 6       | qualifying rides needed in the 28 d window (≥ 2)          |
| `recoveryMinShortPoints`    | 4       | daily readings per signal needed in the 7 d window        |
| `recoveryMinLongPoints`     | 14      | daily readings per signal needed in the 28 d window (≥ 2) |
| `allowSingleRecoverySignal` | false   | allow HRV-only or RHR-only recovery                       |

Invalid configs (negative dead zones, non-integer or too-small minimums) throw `RangeError`.

## Testing

`pnpm --filter @rd/scoring-engine test`. Fixtures are deterministic and hand-checkable
(`src/__fixtures__`). The PLAN §8.5 cases live in `effort.test.ts` (steady ride, threshold
effort in junk miles) and `scenarios.test.ts` (multi-day HR drift at constant power × each
recovery trend; missing-data abstention). The target is 100% branch coverage.
