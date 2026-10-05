# Power:HR Optimization — Research Findings and Build/Test Plan

Companion to `PLAN.md` (the spec) and `ANALYTIC-IMPROVEMENTS.md` (items A1–D2b). This document
adds what the sports-science literature says about the Power:HR efficiency factor (EF), turns it
into buildable work for this repo, and defines how to test each piece. Section references such as
"§8.8" point at `PLAN.md`; "A3" or "C2" point at `ANALYTIC-IMPROVEMENTS.md`. New items use the
prefixes F (foundations), E (EF derivers), N (environment), R (recovery baselines), K (combining)
and S (other combined signals). The product and market roadmap is in `PRODUCT-ROADMAP.md`.

Researched 2026-10-04. Sources are listed at the end; numbers quoted here come from those sources
unless marked as an estimate or a hypothesis to test.

---

## Summary

1. **A plain power/HR ratio rises with intensity even when fitness is unchanged.** Heart rate is
   roughly linear in power with a non-zero intercept, so `ef_peak20` largely tracks how hard the
   hardest 20 minutes was. A hard week reads as "EF up", an easy week as "EF down". This is the
   largest fixable error in the current analytic.
2. **The best reading is early, steady and sub-threshold**: after a 10–15 min warm-up, from a
   steady block of at least 10 minutes, with the first ~3 minutes dropped while HR settles, in the
   first 60–75 minutes of the ride. Peak-20 windows are usually none of those things.
3. **Environment moves HR at fixed power by more than a month of training does.** Heat alone
   raised HR 11% over 30 minutes at constant work in 35 °C. The day-to-day noise of exercise HR is
   about 3% and a meaningful change is about 1%, so covariates have to be captured and handled.
4. **"EF up with recovery up" is not always fitness.** Functional overreaching lowers exercise HR
   and peak HR and can raise weekly-averaged HRV, while performance falls and perceived effort
   rises. The current table labels that pattern `fitness_gain`. Telling the two apart needs a third
   input: perceived effort, performance, or training load.
5. **Nightly RHR is a covariate of EF itself, not only a parallel axis.** Exercise HR sits on top
   of that day's resting HR. Netting the night's RHR out of the denominator, or modelling the
   coupling per athlete, makes the two axes of the quadrant more independent.
6. **The 7 d vs 28 d z-score with a fixed 0.5 dead zone flags noise as a trend about 40% of the
   time when the short window holds two rides** (derivation in §1.7). The dead zone should scale
   with the number of readings.
7. **HRV needs different statistics from the ones it gets today**: log transform, a coefficient of
   variation series, and a saturation guard for athletes with a low resting HR.

The recommended first slice (about two weeks of focused work) is F1, F6, E1, E3, R1, K0 and the
comparison metrics in §3.2. It runs entirely in shadow behind the existing registries and answers
the biggest open question with your own data before anything user-visible changes.

---

## Part 1 — What the research says

### 1.1 What the app computes today

| Piece                | Current behaviour                                                           | Where                                     |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Primary EF           | best 20-min mean power ÷ mean HR of the same window                         | `scoring-engine/src/effort.ts`            |
| Secondary EF         | NP ÷ whole-ride mean HR                                                     | same                                      |
| Streams fetched      | `time,watts,heartrate` only                                                 | `provider-adapters/src/strava/mapping.ts` |
| HRV                  | Oura `average_hrv` (night mean rMSSD), Terra `avg_hrv_rmssd`, raw ms        | `oura/mapping.ts`, `terra/normalize.ts`   |
| Resting HR           | Oura `lowest_heart_rate`, Terra `resting_hr_bpm`                            | same                                      |
| Trend                | 7 d mean vs 28 d mean and SD (28 d includes the 7 d), z-score               | `baseline.ts`                             |
| Recovery             | `mean(hrvZ, −restingHrZ)`, both required                                    | `classifier.ts`                           |
| Direction            | fixed dead zone 0.5 on each axis; EF needs ≥ 2 rides in 7 d and ≥ 6 in 28 d | `classifier.ts`                           |
| FTP, HR max, HR rest | one process-wide value from env (`STRAVA_FTP`, `HR_MAX`, `HR_REST`)         | `efforts/activity-effort-service.ts`      |

### 1.2 Finding 1 — a plain ratio is intensity-dependent

Heart rate rises roughly linearly with power below threshold, but the line does not pass through
the origin: HR while turning the pedals at 0 W is not 0. Write `HR = a + b·P`. Then
`EF = P / (a + b·P)`, which increases with `P` for any `a > 0`.

Hand-checkable example, same rider, same day, `a = 70`, `b = 0.35`:

| Power | HR    | P ÷ HR |
| ----- | ----- | ------ |
| 150 W | 122.5 | 1.224  |
| 250 W | 157.5 | 1.587  |

That is a 30% "improvement" from riding harder. Real month-to-month fitness changes in EF are a
few percent. Consequences for this app:

- `ef_peak20` is dominated by the power of the peak-20 window. A block of interval sessions raises
  it; a recovery week lowers it.
- The quadrant inherits this. A hard block pushes EF up while HRV falls, which is read as
  `overreaching_risk`; an easy week pushes EF down while HRV recovers, which is read as
  `ambiguous`. Both can fire with no physiological change in efficiency.
- `ef_overall` (NP ÷ mean HR) has the same problem.

What the literature uses instead:

- **Power at a fixed HR, or HR at a fixed power.** The Lamberts and Lambert Submaximal Cycle Test
  rides at fixed fractions of max HR (6 min at 60%, 6 min at 80%, 3 min at 90%) and reads power.
  Its measures are highly reliable (intraclass correlation 0.85–1.00, typical error 1.3–4.4%) and
  mean power in the later stages tracks cycling performance (r = 0.80–0.94).
- **Submaximal exercise HR at a standard load** is the HR-based measure with the best
  signal-to-noise ratio in Buchheit's review of HR monitoring: typical error about 3%, smallest
  worthwhile change about 1%.
- **Heart-rate reserve.** %HR reserve tracks %VO₂ reserve in cycling (Swain and Leutholtz), which
  supports measuring cardiac cost above rest rather than from zero. In the example above, with a
  resting HR of 50, `P ÷ (HR − 50)` still rises 12% from 150 W to 250 W, because pedalling at 0 W
  costs more than rest. Reserve handles the daily resting shift (Finding 5); only a fixed reference
  intensity removes the intensity effect.

### 1.3 Finding 2 — when to read it

EF and aerobic decoupling were defined by Friel for steady aerobic efforts below the aerobic
threshold. Three physiological facts set the reading window:

- **HR lags power.** A first-order time constant of about 57 s is reported for both cycling and
  treadmill step changes, so HR needs about 3 minutes to settle after a change in power. Buchheit
  recommends at least 3–4 minutes at a load and averaging the last 30–60 s.
- **HR drifts upward at constant power** from roughly 10–20 minutes onward, faster in heat and with
  dehydration (Finding 3). Late-ride HR measures durability and heat load, not base efficiency.
- **Above threshold HR does not reach a steady state.** A peak-20 window is often near or above
  threshold.

| Level             | Best                                                                                                                                                       | Avoid for the fitness trend                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Within a ride     | first clean steady block after a 10–15 min warm-up, ≥ 10 min long, first ~3 min dropped, inside the first 60–75 min                                        | first 10 min; the peak effort; anything after long or hard work; the last third of a long ride                |
| Intensity         | a fixed personal reference, about 55–75% of FTP (below aerobic threshold)                                                                                  | comparing readings taken at different intensities                                                             |
| Which rides       | endurance rides, standardized warm-ups, indoor steady rides                                                                                                | races, group rides, interval sessions, rides with long coasting                                               |
| Across days       | like with like: same position, similar cadence, similar temperature, indoor separate from outdoor                                                          | mixing indoor and outdoor, or cool and hot days, in one trend without adjustment                              |
| Time of day       | record it as a covariate; evidence is mixed (one study found HR 7 bpm lower in the morning at 70% VO₂max for the first 30 min, others found no difference) | assuming a fixed correction                                                                                   |
| Relative to load  | note the previous day's load: HR can be suppressed the day after hard training, which inflates EF                                                          | reading a single high EF after a big day as fitness                                                           |
| Nightly HRV / RHR | one consistent method (Oura's whole-night mean is valid) against its own baseline, as a 7-day mean                                                         | single nights; nights after alcohol, a late meal or a late hard session, which depress night HRV on their own |

A late-ride reading at the same power is still worth computing, as a separate series: the
first-half vs second-half change (Friel's decoupling, with under 5% as the coaching rule of thumb
for adequate aerobic endurance) and the drift in bpm per hour. Durability, the resistance to that
deterioration, is treated in the recent literature as its own performance trait (Maunder et al.),
and in professionals the power profile declines measurably after about 20 kJ/kg of accumulated
work.

The cleanest reading of all is a short standard block the rider does on purpose: 10 minutes at a
fixed personal power and habitual cadence at the start of any ride. It costs the rider nothing and
gives a like-for-like number several times a week (E1 detects it automatically; §3.3 uses it).

### 1.4 Finding 3 — environment and context

Effect on HR at a fixed sub-threshold power, and therefore on EF:

| Factor                  | Direction                 | Size reported                                                                                                                                                                 | Handling                                                                  |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Heat                    | HR up, EF down            | HR +11% between minutes 15 and 45 at constant work in 35 °C, with a 15% fall in VO₂max; far smaller in 22 °C                                                                  | capture temperature and humidity; stratify, then adjust (N1, N2)          |
| Dehydration             | HR up                     | rise in HR, rise in core temperature and fall in stroke volume all linear in % body mass lost (r ≥ 0.98) over 2 h in the heat; secondary sources quote roughly 3–7 bpm per 1% | cannot be measured; shows up as drift, so read early and track drift (E5) |
| Heat acclimation        | HR down                   | lower steady-state HR within days of starting heat training                                                                                                                   | treat a run of hot rides as a state, not as a fitness gain (N3)           |
| Altitude                | HR up                     | a rise above 4% in exercise HR at altitude predicted illness the next day                                                                                                     | flag deviation from home altitude (A4), watch the 4% rule (S10)           |
| Indoor, low airflow     | HR up                     | behaves like heat                                                                                                                                                             | `trainer` flag; trend indoor and outdoor separately until adjusted        |
| Cadence                 | higher cadence, higher HR | HR and VO₂ higher at 100 rpm than at 80 rpm at the same power                                                                                                                 | capture mean cadence of the window; covariate                             |
| Time into ride          | HR up                     | drift begins after 10–20 min                                                                                                                                                  | read early; fit a drift term (E3)                                         |
| Time of day             | unclear                   | 0 to 7 bpm                                                                                                                                                                    | covariate only                                                            |
| Intensity of the window | EF up with power          | 30% across 150→250 W in the example                                                                                                                                           | fixed reference intensity (E3)                                            |
| Night before            | see Finding 5             |                                                                                                                                                                               | reserve-based EF and coupling model (E2, K3)                              |

Two practical points. Humidity matters as much as temperature for heat strain, so use dew point,
apparent temperature or wet-bulb temperature rather than dry-bulb alone. And the Strava `temp`
stream is the head unit's own sensor, which is known to read high in direct sun and reads room
temperature indoors, so treat it as a cross-check on weather data rather than the reference.

The scale comparison is the important part: exercise HR varies about 3% day to day, a worthwhile
change is about 1%, and one hot afternoon moves it by 10%. Temperature handling is a first-order
requirement, not the 1–3 day optional exclusion that A3 describes.

### 1.5 Finding 4 — the same picture can mean fitness or overreaching

- In overload studies of endurance athletes, the functionally overreached group showed lower peak
  HR (182 → 176 bpm), faster HR recovery (38 → 45 bpm), lower performance (372 → 363 W) and
  much higher perceived fatigue. A lower HR at submaximal intensity and at exhaustion was the most
  discriminating response between overreached and control athletes (Le Meur et al., as cited by
  Aubry et al.).
- A meta-analysis found that single-day resting HRV does not detect this state, while
  weekly-averaged HRV shows a moderate _increase_ (parasympathetic hyperactivity).
- Over two Grand Tours, the ratios that moved most were perceived effort to HR and perceived effort
  to power, not power to HR alone (Sanders et al., 12 professional cyclists).
- Buchheit also describes a bell-shaped pattern in elite athletes: vagal HRV falls in the weeks
  before competition while performance keeps improving.

So lower HR for the same power, with stable or rising HRV, is produced both by aerobic adaptation
and by overreaching. The current table calls it `fitness_gain` in both cases. The authors of these
studies are consistent that no single HR marker is safe on its own and that it must be read with
training phase, perceived fatigue and performance. Inputs this app can add:

| Discriminator                      | Fitness       | Overreaching                        | Source in this app                                                                                         |
| ---------------------------------- | ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Perceived effort at a given power  | same or lower | higher                              | new: one-tap RPE after each ride (the documented Strava activity model does not expose perceived exertion) |
| Best efforts over the window       | stable or up  | down                                | power-duration bests from streams                                                                          |
| Peak HR reached in maximal efforts | normal        | suppressed                          | stream max HR in hard efforts vs rolling personal max                                                      |
| Load context                       | normal ramp   | sharp rise in acute vs chronic load | existing `training_load`                                                                                   |

### 1.6 Finding 5 — how EF connects to the rider's RHR and HRV baseline

**Mechanism.** Exercise HR at a given power is the day's resting level plus the reserve the work
demands. Anything that shifts resting HR overnight (residual fatigue, illness onset, heat,
dehydration, alcohol, the luteal phase) carries into exercise HR that day, so part of what the EF
axis measures is the same thing the recovery axis measures. That double counting pushes readings
toward the `acute_fatigue` and `fitness_gain` diagonal.

**Three ways to use the link**, in increasing effort:

1. _Reserve-based EF_ (E2): `P ÷ (HR − RHR_last_night)`. The EF axis becomes cardiac cost above
   rest; the night's shift stays on the recovery axis only.
2. _Coupling model_ (K3): per athlete, regress ride HR at reference power on that morning's RHR
   and HRV deviations. The coefficient says how many bpm of ride HR one bpm of overnight RHR is
   worth for this rider. The residual is what the ride showed beyond what the night predicted.
3. _Lead-lag_ (S5): cross-correlate load, night HRV and next-day EF at lags of −2 to +2 days per
   athlete to learn which signal leads for them.

The sign of the coupling is not fixed (Finding 4: sympathetic fatigue raises both RHR and exercise
HR; parasympathetic overreaching lowers both), so it has to be estimated per athlete and
re-estimated over time, never hard-coded.

**Baseline statistics the literature supports:**

- _Averaging._ Night-to-night variation in ln rMSSD is about 12%, four times that of exercise HR.
  Correlations with performance appear only when at least 3–4 days are averaged, and noise falls
  with √n. The 7-day mean already in use is the standard choice.
- _Log transform._ The HRV-guided training studies compute baselines on ln rMSSD. The app z-scores
  raw milliseconds, which are right-skewed, so one very good night inflates the SD.
- _Smallest worthwhile change._ Those studies act when the 7-day mean leaves the baseline mean
  ± 0.5 SD, which matches the existing 0.5 dead zone for HRV. In road cyclists, training guided
  this way improved peak power about 5%, power at the second threshold about 14% and 40-minute
  time-trial power about 7%.
- _Variability of HRV._ The 7-day coefficient of variation is used alongside the mean as a sign of
  how well load is being absorbed.
- _Saturation._ In athletes with a long R-R interval (above about 1000 ms, a resting HR below 60),
  rMSSD can fall as vagal tone rises. The ratio of ln rMSSD to R-R interval separates this from
  sympathetic fatigue: under saturation HR is lower and the ratio falls; under fatigue HR is higher
  and the ratio holds or rises. Competitive cyclists with resting HR in the 40s are the population
  where this matters.
- _Menstrual cycle._ Resting HR is about 1.7 bpm (3.4%) higher in the mid-luteal than in the early
  follicular phase in endurance athletes, with HRV lower; a study of more than 13,000 cycles shows
  the same pattern. Against a 28-day baseline this is a predictable monthly oscillation.
- _Illness._ Resting HR, HRV, respiratory rate and skin temperature shift before symptoms. On Oura
  data, a model detected COVID-19 on average 2.75 days before the person sought a test, with 82%
  sensitivity and 63% specificity. The app already fetches the Oura payloads that carry
  `temperature_deviation` and `average_breath` and discards them.

### 1.7 Finding 6 — the combining statistics flag noise

`z = (mean of 7 d − mean of 28 d) ÷ SD of the 28 d readings`, flagged when `|z| > 0.5`. With `n_s`
readings in the short window and `n_l` in the long window that contains it, pure noise of standard
deviation σ gives `Var(short − long) = σ²·(1/n_s − 1/n_l)`.

| Rides in 7 d / 28 d                        | SD of the difference | Chance a flat EF is flagged up or down |
| ------------------------------------------ | -------------------- | -------------------------------------- |
| 2 / 8                                      | 0.61 σ               | 41%                                    |
| 4 / 16                                     | 0.43 σ               | 25%                                    |
| 6 / 24                                     | 0.35 σ               | 16%                                    |
| 7 nights / 28 nights (one recovery signal) | 0.33 σ               | 13%                                    |

(Estimates assuming independent readings and a well-estimated SD.) The minimum the classifier
accepts is two rides, where four in ten "trends" are noise. Two remedies, both needed: lower the
per-reading noise (Findings 1–3), and make the threshold depend on the standard error instead of a
fixed fraction of the SD (K0).

### 1.8 Strength of evidence

| Claim                                                                       | Basis                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Ratio depends on intensity                                                  | arithmetic, given a linear HR–power relation with positive intercept            |
| HR lag, drift, heat and dehydration effects                                 | controlled laboratory studies                                                   |
| Submaximal HR and power at fixed HR as fitness markers; reliability figures | validation studies and a widely cited review                                    |
| Overreaching lowers exercise HR, raises weekly HRV                          | overload studies with small groups (about 10–20 athletes) and one meta-analysis |
| 7-day ln rMSSD mean with 0.5 SD band                                        | several randomized HRV-guided training studies, small samples                   |
| 5% decoupling threshold; discard the first 20–30 min                        | coaching practice (Friel), not a validated cut-off                              |
| Time-of-day effect                                                          | mixed, small studies                                                            |
| `lowest_heart_rate` vs night-average HR as the better RHR                   | no evidence found; a hypothesis to test (R5)                                    |

---

## Part 2 — Build plan

### 2.0 Constraints from the current code

- **Deriver input is too narrow.** `ActivityEffortDeriver.derive(stream, opts)` takes
  `{t, watts, hr}` and nothing else. Every item below needs more channels (cadence, grade,
  altitude, temperature, speed) and per-ride context (athlete profile, last night's RHR, indoor
  flag). Context is passed in, so derivers stay pure (CLAUDE.md rule 1).
- **Derivers share one output shape built around peak-20.** The trend service reads `ef_peak20`
  from the default deriver's rows. Derivers that define EF differently need a common
  `ef_primary` column so any of them can be promoted without changing readers.
- **Athlete parameters are process-wide env values.** FTP, HR max and HR rest must be per user
  before any reference-intensity method can work.
- **Streams are discarded (rule 5) and nothing re-fetches them.** A new deriver only produces rows
  for rides that arrive after it is registered. Comparing derivers on the same past rides needs
  either a re-fetch job (F5) or a decision about a short-retention cache (Decision 1).
- **Rule 2 wording.** "HR from the same window as power" is satisfied by everything below.
  E3 regresses HR on lag-smoothed power over one common window; if you read rule 2 more strictly
  than that, say so before E3 is built (Decision 3).
- **Third-party field names** in this document come from the docs fetched on 2026-10-04 or the
  OpenAPI excerpt in the repo. Rule 8 still applies at build time: re-verify and cite.

### 2.1 Stage F — foundations

| #   | Item                                 | What changes                                                                                                                                                                                                                                                                                                                                                                           | Days |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| F1  | Wider stream and derive context      | `StreamSample` gains optional `cadence`, `grade`, `altitude`, `tempC`, `speed`; `resampleTo1Hz` carries them. New `DeriveContext { referencePower, hrMax, restingHrLastNight, indoor, startHourLocal }`. Deriver output gains `efPrimary`, `efKind`, window start and length, window power and HR, `quality` (0–1). `peak20_v1` output is unchanged apart from `efPrimary = efPeak20`. | 1–2  |
| F2  | Covariate capture                    | Strava streams call asks for `cadence,temp,altitude,grade_smooth,velocity_smooth,moving` as well (same single request). Read `trainer`, `start_latlng`, `kilojoules`, `elev_high`, `elev_low`, `average_cadence` from the activity. New `activity_context` table, one row per activity, deriver-independent.                                                                           | 2–3  |
| F3  | Weather lookup                       | Open-Meteo archive by start position rounded to about 0.1° and hour: temperature, dew point, apparent temperature, wet-bulb, wind. Cached; lat/lng is used for the lookup and not stored. ERA5 data has a 5-day delay, so use the no-delay model for new rides and accept later correction. Skipped for `trainer` rides. Extends A3.                                                   | 2–3  |
| F4  | Per-user athlete profile             | `athlete_profile (user_id, ftp, reference_power, hr_max, habitual_cadence, home_altitude_m, source, updated_at)`. FTP entered by the user at first; estimated from the power-duration curve later (shared with A2). Replaces the env values, which remain as fallbacks.                                                                                                                | 2–3  |
| F5  | Re-derivation job                    | When a deriver id is added, re-fetch streams for each user's trailing N days (default 35: one long window plus one short) and run only the new deriver. Bounded per invocation and scheduled inside the Strava read budget (100 per 15 min, 1,000 per day, shared by the whole application).                                                                                           | 2–3  |
| F6  | Synthetic ride generator (test code) | Seeded, deterministic generator in `__fixtures__`: power profile in, HR out from `HR(t) = hr0 + slope·P̃τ(t) + drift·t + heat + noise`, with dropouts and spikes on request. Ground truth is known, so every deriver is tested by whether it recovers it.                                                                                                                               | 1–2  |

### 2.2 Stage E — EF derivers (each a new `deriver_id`, shadow first)

Each differs from the previous one in a single respect, so a comparison isolates one cause (§8.8).

**E1 `steady_block_v1` — early steady sub-threshold block.** Find blocks where 30-s smoothed
power stays within the intensity band (default 55–80% of `referencePower`), its coefficient of
variation is under a cap (default 10%, calibrate on real rides), coasting is under 5% of the
block, and the block starts after `warmupSkipSec` (600) and ends before `freshWindowEndSec`
(4,500). Drop the first `settleTrimSec` (180) of each block; require `blockMinSec` (600) after
trimming. `efPrimary` is the time-weighted mean of block power ÷ block HR over qualifying blocks,
HR from exactly the same seconds. Abstains (no row) when no block qualifies. Every threshold is
config (rule 9). 3–4 days.

**E2 `steady_block_hrr_v1` — same blocks, reserve denominator.** `efPrimary = P ÷ (HR −
restingHrLastNight)`. Abstains when the night value is missing. Because block selection is
identical to E1, the comparison shows exactly what netting out resting HR does. 1 day.

**E3 `hr_model_v1` — HR at reference power from a fitted response.** Over sub-threshold seconds
after the warm-up and inside the fresh window, fit by least squares
`HR(t) = a + b·P̃τ(t) + c·t`, where `P̃τ` is power smoothed with a first-order lag (τ from config,
default 60 s; optionally chosen from a small grid by best fit). Outputs: HR at `referencePower`
at a fixed reference time (30 min), reported as `efPrimary = referencePower ÷ HR_ref`; `c` as
drift in bpm per hour; fit quality (R², standard error of `HR_ref`) feeding `quality`. Requires a
minimum spread of power (default 15% of FTP) and abstains otherwise. This removes the intensity
effect of Finding 1 and works on variable rides where E1 finds no block. 3–4 days.

**E4 `hr_model_hrr_v1`** — E3 with `HR_ref − restingHrLastNight` in the denominator. 0.5 day.

**E5 Durability series (not an EF variant).** For rides over 90 minutes: decoupling % (first vs
second half of the steady portion), drift bpm per hour from E3's `c`, and EF in the last steady
block relative to the first. Stored as their own columns and trended separately; never mixed into
the fitness axis. 2–3 days.

A1 (terrain), A2 (W′ balance), A4 (altitude) and A5 (window quality) from
`ANALYTIC-IMPROVEMENTS.md` become filters and inputs to `quality` on E1 and E3 rather than
variants of peak-20. Build A1 and A4 with E1; A2 later.

### 2.3 Stage N — environment

**N1 Stratify and gate (rules).** Trend indoor and outdoor readings as separate strata; exclude
from the trend, but keep and display, readings above a heat threshold or beyond an altitude
deviation. Every exclusion is visible on the chart with its reason. 1–2 days.

**N2 `ef_adjusted_v1` — per-athlete covariate adjustment.** Once a user has at least 30 readings
with spread in the covariates, fit `ln(efPrimary)` on heat excess (hinge above a comfort point,
using wet-bulb or apparent temperature), indoor, altitude deviation, cadence deviation, start
hour and previous-day load. Two safeguards matter:

- _Seasonal confounding._ Summer is both hot and fit. Estimate coefficients on deviations from a
  rolling 28-day mean of both EF and each covariate, so the slow fitness trend cannot be absorbed
  by temperature.
- _Small samples._ Ridge-shrink toward literature priors and report the adjusted and unadjusted
  values side by side.

Fit and apply are pure functions over stored scalars; coefficients go in a per-user table.
Overlaps D1 (personalization); build as one model. 4–6 days.

**N3 Heat-acclimation state (later).** Count heat exposures over the trailing 14 days and let the
expected heat penalty shrink accordingly. Build only if N2's residuals show it. 2–3 days.

### 2.4 Stage R — recovery baselines

| #   | Item                 | Notes                                                                                                                                                                                                                              | Days |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| R1  | ln transform for HRV | A `transform` option on the baseline call; stored values stay in ms.                                                                                                                                                               | 0.5  |
| R2  | Window variants      | 7/28 overlapping (today), 7/28 non-overlapping (`longExcludesShort` exists), 7/42, 7/60. Registered as classifier variants and chosen by backtest.                                                                                 | 1    |
| R3  | HRV CV series        | 7-day coefficient of variation of ln rMSSD as a new trend metric.                                                                                                                                                                  | 1    |
| R4  | Saturation guard     | Map Oura `average_heart_rate` for the night; compute ln rMSSD ÷ R-R. When HRV is down, resting HR is also down and the ratio has fallen, recovery direction is `flat`, with a note. Verify the Terra equivalent field in its docs. | 2    |
| R5  | RHR definition       | `lowest_heart_rate` vs night-average HR as challengers; compare noise.                                                                                                                                                             | 0.5  |
| R6  | New daily metrics    | From payloads already fetched: `temperature_deviation`, `average_breath`, `total_sleep_duration`, `time_in_bed`, `efficiency`, `bedtime_start`. Extends `DailyMetricType` and the `daily_metrics.metric_type` values.              | 2–3  |
| R7  | Data-quality gate    | C2, with concrete Oura inputs: short night, `low_battery_alert`, period type. Prerequisite for any outlier weighting (C1).                                                                                                         | 3–5  |
| R8  | Context flags        | Late session (ride ended within 3 h of `bedtime_start`), plus optional user tags for alcohol, travel and cycle phase. Used to explain a bad night, not to discard it.                                                              | 2    |

### 2.5 Stage K — combining

**K0 `ef_quadrant_se_v1` — standard-error-aware direction.** Direction is non-flat only when
`|short mean − long mean|` exceeds both the smallest worthwhile change and `k` standard errors,
with `SE = SD_long·√(1/n_s − 1/n_l)`. With `k = 1.5` the false-flag rate is about 13% regardless
of how many rides the week had. Same inputs as `ef_quadrant_v1`, so it isolates the statistics.
1–2 days.

**K1 `ef_quadrant_v2`.** The K0 logic fed by the winning Stage E deriver and R1–R2 baselines.
1 day once those exist.

**K2 Third axis: effort and load.** Add to `TrendInputs`: training-load context (acute and
chronic load from `training_load`, per-user FTP from F4), an RPE trend (new in-app one-tap rating
after each ride), a best-efforts trend, and peak-HR suppression. Decision changes:

| EF           | Recovery   | Extra evidence                                                                               | State                    |
| ------------ | ---------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| up           | flat or up | load normal, RPE not rising                                                                  | `fitness_gain`           |
| up           | flat or up | load sharply up, and RPE rising at the same power or best efforts down or peak HR suppressed | `overreaching_risk`      |
| down         | flat or up | reading taken in heat, at altitude, or indoors against an outdoor baseline                   | `environmental` (new)    |
| down or flat | down       | resting HR up with temperature deviation and respiratory rate up                             | `possible_illness` (new) |

New states touch the engine type, the `trends.direction` CHECK constraint, the shared-types union,
dashboard copy and e2e specs (Decision 2). 5–7 days including the RPE input.

**K3 Coupling model.** Per-athlete regression of ride HR at reference power on the same morning's
RHR and ln rMSSD deviations; store the coefficients and the residual z. Needs about 30 paired
readings. 4–6 days.

**K4 Confidence.** Every classification carries a confidence built from reading counts, deriver
`quality`, size of the covariate adjustment and data-quality flags. The dashboard shows low
confidence instead of hiding the state. 2–3 days.

B1 (daily-only read) and C1 (outlier weighting) slot in here unchanged, C1 after R7.

### 2.6 Schema changes, consolidated

```sql
-- F1: every deriver reports one comparable number
ALTER TABLE activity_efforts
  ADD COLUMN ef_primary NUMERIC, ADD COLUMN ef_kind TEXT,
  ADD COLUMN window_start_sec INTEGER, ADD COLUMN window_sec INTEGER,
  ADD COLUMN window_power NUMERIC, ADD COLUMN window_hr NUMERIC,
  ADD COLUMN quality NUMERIC,
  ADD COLUMN drift_bpm_per_h NUMERIC, ADD COLUMN decoupling_pct NUMERIC;   -- E5
UPDATE activity_efforts SET ef_primary = ef_peak20, ef_kind = 'peak20' WHERE deriver_id = 'peak20_v1';

-- F2/F3: per-activity context, independent of deriver
CREATE TABLE activity_context (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_activity_id TEXT NOT NULL,
  start_hour_local SMALLINT, indoor BOOLEAN,
  device_temp_c NUMERIC, air_temp_c NUMERIC, dew_point_c NUMERIC, wet_bulb_c NUMERIC, wind_ms NUMERIC,
  weather_source TEXT, avg_altitude_m NUMERIC, avg_cadence NUMERIC, kilojoules NUMERIC,
  rpe SMALLINT CHECK (rpe BETWEEN 1 AND 10),                               -- K2, entered in-app
  PRIMARY KEY (user_id, external_activity_id)
);

-- F4, N2/K3
CREATE TABLE athlete_profile (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ftp NUMERIC, reference_power NUMERIC, hr_max NUMERIC, habitual_cadence NUMERIC,
  home_altitude_m NUMERIC, source TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE user_ef_model (user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, coefficients_jsonb JSONB NOT NULL, n_readings INTEGER NOT NULL,
  fitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, model_id));
```

Plus one `derivers` or `classifiers` row per new id, the widened `metric_type` and `direction`
values, and `derivation_version` bumps where an existing deriver's output changes (rule 5). All
new tables carry `user_id` (rule 4); coefficients are derived scalars, not payloads.

### 2.7 Proposed pipeline phases

| Phase                       | Agent                                                     | Scope                                | Paths (add to `docs/OWNERSHIP.md`)                                                                                                                                              |
| --------------------------- | --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 EF foundations           | scoring-engine-builder                                    | F1, F6, K0                           | `packages/scoring-engine/**`                                                                                                                                                    |
| 11 Context capture          | provider-adapter-builder, then backend-builder            | F2, F3, F4, F5                       | `packages/provider-adapters/src/strava/**`, new `packages/provider-adapters/src/weather/**`, `apps/api/src/efforts/**`, new `apps/api/src/profile/**`, migration `*_phase-11_*` |
| 12 EF derivers              | scoring-engine-builder                                    | E1–E5, A1, A4                        | `packages/scoring-engine/**`, migration `*_phase-12_*` (deriver rows)                                                                                                           |
| 13 Recovery baselines       | provider-adapter-builder, scoring-engine-builder          | R1–R8                                | `packages/provider-adapters/src/{oura,terra}/**`, `packages/shared-types/src/metrics.ts`, `packages/scoring-engine/**`, migration `*_phase-13_*`                                |
| 14 Comparison metrics       | backend-builder, frontend-builder                         | §3.2 metrics endpoint and admin view | `apps/api/src/comparison/**`, `apps/web/src/components/admin/**`                                                                                                                |
| 15 Adjustment and combining | scoring-engine-builder, backend-builder, frontend-builder | N1–N2, K1–K4, RPE input              | engine, `apps/api/src/fatigue-fitness/**`, `apps/web/src/components/dashboard/**`, migration `*_phase-15_*`                                                                     |

Phases 10, 11 and 13 are independent and can run in parallel. 12 needs 10 and 11. 14 needs 12.
15 needs 12, 13 and at least eight weeks of shadow data from 14. Total: roughly 55–75 focused
days; the first slice named in the Summary is about 10–14 of them.

---

## Part 3 — Test and validation plan

### 3.1 Unit tests on synthetic rides (Vitest, pure, hand-checkable)

Built on F6. Each row is a fixture and an assertion; the "documents the artifact" rows keep the
old behaviour visible so the reason for the change stays in the test suite.

| Fixture                                                                                          | Assertion                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same rider (`a = 70`, `b = 0.35`), two rides whose hardest 20 min are 150 W and 250 W            | `peak20_v1` values differ by about 30% (documents the artifact); `hr_model_v1` values agree within 1%                                                           |
| Three 12-min steps at 55%, 65%, 75% of FTP                                                       | `hr_model_v1` recovers `a` and `b` within 2%; `steady_block_v1` returns one value per its config, not a blend across steps                                      |
| Constant 200 W for 2 h with 8 bpm/h drift                                                        | `steady_block_v1` is within 2% of the no-drift truth; NP ÷ mean HR is more than 5% low; `drift_bpm_per_h` is 8 ± 0.5; decoupling % matches the hand calculation |
| Step from 120 W to 220 W                                                                         | with `settleTrimSec = 180` the block HR is within 1 bpm of steady state; with 0 it is not                                                                       |
| Resting HR shifted +5 bpm with exercise HR shifted +5                                            | `steady_block_hrr_v1` unchanged; `steady_block_v1` falls by the hand-computed amount                                                                            |
| Race-like stochastic power with no steady block                                                  | `steady_block_v1` abstains; `hr_model_v1` returns a value with reduced `quality`                                                                                |
| Ride with under 15% FTP power spread                                                             | `hr_model_v1` abstains                                                                                                                                          |
| HR dropout for 4 min inside the block; HR spike to 230                                           | coverage rule rejects or trims; spike does not move the result beyond tolerance                                                                                 |
| Same ride sampled at 1 Hz and at one sample per 5 s                                              | results agree within 0.5%                                                                                                                                       |
| Junk appended after the fresh window                                                             | early-window results are identical                                                                                                                              |
| Model mismatch: two-phase HR kinetics; HR curving above threshold                                | `hr_model_v1` error stays under 3% when above-threshold seconds are excluded (a deriver must not be tested only on data generated by its own model)             |
| Baselines: HRV series with one extreme night                                                     | ln transform reduces its effect on SD by the hand-computed factor                                                                                               |
| Saturation: HRV down 10%, night HR down 4 bpm                                                    | R4 returns `flat` with a saturation note; without the guard, `down`                                                                                             |
| K0: seeded noise-only series at 2, 4 and 6 rides a week                                          | false-flag rates near 13% for `ef_quadrant_se_v1` and near the §1.7 table for `ef_quadrant_v1`                                                                  |
| K2: synthetic athlete with rising load, falling HR, rising HRV, falling best efforts, rising RPE | `ef_quadrant_v1` says `fitness_gain`; K2 says `overreaching_risk`                                                                                               |

Keep `purity.test.ts` covering every new file, and the 100% branch-coverage target.

### 3.2 Shadow comparison in the app — metrics fixed before looking at data

Every deriver runs on every ride and stores its row (§8.8 already provides this). Add one
comparison endpoint and admin view that reports, per user and per deriver, over a chosen range:

| Metric               | Definition                                                                                                                       | Better is                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Noise                | typical error: SD of differences between pairs of readings ≤ 7 days apart, ÷ √2, as % of the mean                                | lower; under 3% matches the literature for exercise HR     |
| Intensity leakage    | correlation of `ef_primary` with the window's power as a fraction of FTP                                                         | near 0; the direct test of Finding 1                       |
| Environment leakage  | correlation with temperature, indoor flag, cadence                                                                               | near 0 after N2                                            |
| Coverage             | share of qualifying rides that yield a reading; readings per week                                                                | higher; a method that abstains on most rides is not usable |
| Validity             | correlation of the 28-day EF trend with an independent performance marker (best 20-min power per block, FTP tests, race results) | higher                                                     |
| Classifier stability | state changes per 28 days; share of `ambiguous`                                                                                  | lower                                                      |
| Outcome              | existing backtest: flags preceding logged illness or injury, false alarms                                                        | more preceded events per false alarm                       |
| Agreement            | thumbs up/down by classifier                                                                                                     | higher                                                     |

**Promotion rule.** A challenger replaces the default when, over at least 8 weeks and 30 rides
for a user, it has lower noise and lower intensity leakage, keeps coverage above 60% of qualifying
rides, and is not worse on validity. Change one layer at a time: pick the deriver with the
classifier held at `ef_quadrant_v1`, then pick the classifier. Record each promotion and its
numbers in `CHANGELOG.md`.

### 3.3 N-of-1 protocols (ground truth you can create yourself)

| Question                                      | Protocol                                                                              | What it validates                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| How noisy is each deriver?                    | the same 10-min reference block at the start of 6 rides in 2 weeks of steady training | typical error per deriver on real data                   |
| Does the intensity artifact exist in my data? | one ride with 3 × 10 min at 55%, 65%, 75% of FTP                                      | plain ratio rises across steps; `hr_model_v1` stays flat |
| How large is my heat penalty?                 | the same indoor steady workout with and without a fan on two easy days                | sign and size of N2's heat coefficient                   |
| What does fatigue do to my reading?           | reference block the morning after a hard day and after a rest day, three pairs        | direction and size of the day-after effect; input to K3  |
| Does time of day matter for me?               | reference block morning vs evening, three pairs                                       | whether start hour deserves a coefficient                |
| Night vs next ride                            | no protocol: 8 weeks of normal riding with reference blocks                           | K3 coupling coefficient and lead-lag                     |

### 3.4 Real-ride replay

A local script that pulls your own recent rides, runs every registered deriver and prints the §3.2
metrics, so a deriver can be tuned before it is deployed. Keep the stream corpus out of git
(Decision 6). All automated tests continue to mock every third party (rule 10).

### 3.5 Classifier simulation

Extend `scenarios.test.ts` with a multi-week simulated athlete: daily load drives fitness and
fatigue (impulse-response), which drive ride HR, night HRV and RHR with realistic noise levels
(3% and 12%). Scripted episodes: steady build, heat wave, illness onset, sympathetic fatigue,
parasympathetic overreaching, taper. Each classifier's output is asserted per episode. This is the
only place the full decision table can be checked against a known truth.

### 3.6 API, UI and e2e

- New endpoints (profile, RPE, comparison metrics) get RBAC tests for self, other user and master
  (rule 3).
- Weather client and re-derivation job: unit tests with mocked HTTP, including rate-limit
  exhaustion and the 5-day archive delay.
- Playwright: RPE entry, the excluded-reading markers and reasons, new state copy, confidence
  display, comparison view for master only.
- Migrations: up and down on a seeded database; idempotent upserts on the new natural keys.

---

## Part 4 — Other combinations of on-bike and off-bike data

Grouped by what they need. "Have" means the data is already fetched or stored today.

### Data already in hand

| #   | Signal                | Answers                                           | Computation                                                                                                                                                                                                       |
| --- | --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Illness early warning | "Am I getting sick?"                              | two or more of: RHR up, HRV down, temperature deviation up, respiratory rate up, beyond personal thresholds for 1–2 nights (R6). Wording stays at "unusual night, consider an easy day"; this is not a diagnosis. |
| S2  | Non-training stress   | "Why is recovery down when training is light?"    | recovery trend down while acute load is at or below chronic load. Points at sleep, travel, work or illness rather than training.                                                                                  |
| S3  | Load tolerance        | "Am I absorbing this block?"                      | acute and chronic load against the 7-day ln rMSSD mean and its CV: rising load with stable HRV is coping; rising load with falling mean or rising CV is not.                                                      |
| S4  | Recovery kinetics     | "How long do I need after a big day?"             | nights until RHR and HRV return inside the baseline band after rides above a load threshold; the personal curve of load against next-night change. Tracks how recovery speed changes through a season.            |
| S5  | Lead-lag map          | "Which of my signals moves first?"                | per-athlete cross-correlation of load, night metrics and EF at ±2 days (§1.6).                                                                                                                                    |
| S6  | Late-session effect   | "Was last night bad because of the evening ride?" | night HRV after rides ending within 3 h of bedtime vs other nights (R8).                                                                                                                                          |
| S7  | Sleep sensitivity     | "What does a short night cost me?"                | regression of next-day EF, RPE and best efforts on sleep duration and timing; shown only when the interval excludes zero.                                                                                         |

### One new input or derivation

| #   | Signal                     | Needs                                       | Notes                                                                                                                                                                     |
| --- | -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S8  | Overreaching discriminator | RPE, best efforts, peak-HR suppression (K2) | the Finding 4 case                                                                                                                                                        |
| S9  | Durability trend           | E5                                          | decoupling and drift by ride duration, and how they respond to sleep and recovery state                                                                                   |
| S10 | Altitude-camp monitor      | altitude (F2), R6                           | exercise HR more than 4% above the athlete's norm at altitude as a next-day illness warning, with night RHR                                                               |
| S11 | Heat-adaptation tracker    | weather (F3), N2                            | the athlete's heat penalty per degree shrinking across a heat block; night RHR and temperature response to heat sessions                                                  |
| S12 | HR recovery after efforts  | stream analysis                             | drop in HR in the 60 s after hard efforts end; faster recovery with falling performance is an overreaching sign, so read it with S8                                       |
| S13 | HRV-guided day             | R1, R3, B1                                  | morning suggestion to keep or swap a hard session when the 7-day ln rMSSD mean leaves its band; this is the protocol with trial evidence in cyclists                      |
| S14 | Taper and peak tracking    | race dates in `athlete_events`              | freshening pattern before a target event; suppress the usual falling-HRV warning in the final days, where a fall with improving performance is expected in elite athletes |

### New data source

| #   | Signal                                                                                                                     | Needs                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S15 | Cycle-aware baselines                                                                                                      | opt-in cycle phase, from the user or a provider                                                    |
| S16 | Aerobic threshold from in-ride HRV (DFA-α1 crossing 0.75, validated against the first lactate threshold in elite cyclists) | R-R intervals from a chest strap, which requires FIT files; not available in Strava streams        |
| S17 | Core-temperature-based heat load                                                                                           | CORE sensor field in FIT files; agreement with rectal temperature is limited, so use it as a trend |
| S18 | Fuelling vs drift                                                                                                          | carbohydrate intake logged per ride                                                                |

Build order by value for effort: S1, S2, S3 (cheap once R6 lands), then S13, S8, S4, S9.

---

## Decisions needed from the owner

1. **Stream retention.** Rule 5 says discard. Deriver comparison on identical past rides needs
   either re-fetching (F5, bounded by Strava's application-wide read budget) or a separate
   short-retention cache of down-sampled series. Recommendation: F5 now; revisit a cache only if
   the user count makes re-fetching impractical, and check the provider's caching terms first.
2. **New states** `environmental` and `possible_illness` (K2), or keep the six states and put the
   explanation in `insight_text` only.
3. **Rule 2 wording** for model-based derivers (E3).
4. **Strava API terms.** The agreement in force since November 2024 limits display of a user's
   Strava data to that user and prohibits using it for machine-learning model training. The master
   roster view and the per-athlete regressions (N2, K3, D1) should be checked against the current
   text, or moved onto directly connected sources. Details in `PRODUCT-ROADMAP.md` §1.
5. **Weather provider terms.** Open-Meteo's free tier is for non-commercial use; a commercial
   deployment needs its paid API.
6. **Real-ride fixtures.** Keep them local and untracked, or commit a small, consented,
   location-stripped set.
7. **Reference power definition.** A fixed fraction of FTP (default 65%) or a wattage the athlete
   picks. It must stay fixed between FTP changes, and a change must restart the series.

---

## Sources

Exercise HR, EF and decoupling

- [Buchheit 2014, Monitoring training status with HR measures (Frontiers in Physiology)](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2014.00073/full)
- [Lamberts et al., A novel submaximal cycle test to monitor fatigue and predict cycling performance (BJSM)](https://bjsm.bmj.com/content/45/10/797)
- [Can the LSCT indicate fatigue and recovery in trained cyclists?](https://lida.sport-iat.de/ta/Record/4041084?lng=en)
- [Friel, Aerobic endurance and decoupling (TrainingPeaks)](https://www.trainingpeaks.com/learn/articles/aerobic-endurance-and-decoupling/)
- [Sanders et al. 2018, Analysing a cycling grand tour: intensity and load ratios](https://cris.maastrichtuniversity.nl/en/publications/analysing-a-cycling-grand-tour-can-we-monitor-fatigue-with-intens/)
- [HR dynamics identification, treadmill (Frontiers in Control Engineering 2022)](https://www.frontiersin.org/journals/control-engineering/articles/10.3389/fcteg.2022.894180/pdf)
- [HR and HRV kinetics across intensity domains of cycling](https://repositorio.unesp.br/items/e5a46c18-9506-450f-8080-ec2377e1e7c4)
- [%HRR and %VO₂ reserve (JSSM, citing Swain and Leutholtz 1997)](https://www.jssm.org/jssm-05-662.xml-Fulltext)
- [Cadence, HR and oxygen uptake at constant power (JSSM)](https://www.jssm.org/jssm-13-114.xml-Fulltext)
- Time of day: [Int J Sports Med 2005](https://www.thieme-connect.com/products/ejournals/html/10.1055/s-2004-830439), [summary of a null result](https://coachsci.sdsu.edu/csa/vol161/wilfong.htm)

Environment

- [Effect of ambient temperature on cardiovascular drift and maximal oxygen uptake](https://www.sponet.de/sponet/Record/4014508)
- [Montain and Coyle 1992, graded dehydration and cardiovascular drift](https://pubmed.ncbi.nlm.nih.gov/1447078/)
- [Prolonged heat acclimation in endurance-trained athletes](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6843002/)
- [Validity of the CORE sensor during cycling](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8434645/)
- [Open-Meteo historical weather API](https://open-meteo.com/en/docs/historical-weather-api)

Overreaching and durability

- [Aubry et al. 2015, functional overreaching and faster HR recovery](https://pmc.ncbi.nlm.nih.gov/articles/PMC4619310)
- [Meta-analysis: HR-based indices and parasympathetic hyperactivity in overreached athletes](https://lida.sport-iat.de/ta/Record/4070230)
- [Maunder et al. 2021, The importance of durability in physiological profiling](https://lida.sport-iat.de/ta/Record/4069575)
- [Durability in professional cyclists: a field study](https://investiga.upo.es/documentos/63b2efbd7109c1657f644816)
- [Estimation of heart rate recovery from field rides](https://lida.sport-iat.de/ta/Record/4089457)

HRV, RHR and night data

- [HRV-guided training in cyclists (TrainingPeaks summary)](https://www.trainingpeaks.com/blog/new-study-widens-hrv-evidence-for-more-athletes/)
- [Training prescription guided by HRV (HRV4Training)](https://www.hrv4training.com/blog2/training-prescription-guided-by-heart-rate-variability)
- [Whole-night HR and HRV from Oura (HRV4Training)](https://www.hrv4training.com/blog2/oura-ring-integration-read-sleep-data-whole-night-heart-rate-and-hrv-in-hrv4training)
- Menstrual cycle: [endurance athletes](https://ninum.uit.no/handle/10037/32174), [BMJ Open SEM](https://bmjopensem.bmj.com/content/7/3/e001047.full.pdf)
- [TemPredict: illness detection from Oura data](https://pmc.ncbi.nlm.nih.gov/articles/PMC8891385)
- [DFA-α1 and the aerobic threshold (Frontiers in Physiology)](https://frontiersin.org/journals/physiology/articles/10.3389/fphys.2020.596567/text)

Providers

- [Strava API reference](https://developers.strava.com/docs/reference/) and [rate limits](https://developers.strava.com/docs/rate-limits/)
- [Oura OpenAPI 1.41](https://cloud.ouraring.com/v2/static/json/openapi-1.41.json) (excerpt in `packages/provider-adapters/src/oura/docs/`)
