# Product Roadmap — Competitive Cyclists and Market Expansion

Companion to `PLAN.md` and `EF-RESEARCH-AND-PLAN.md`. Part A covers what competitive and elite
cyclists will want next. Part B covers how to reach a wider population. Both are shaped by
platform constraints, so those come first. Item ids such as E3 or S13 refer to
`EF-RESEARCH-AND-PLAN.md`; "§14" refers to `PLAN.md`.

Researched 2026-10-04. Market figures and platform terms change; re-check each before acting on it.
Nothing here is legal advice.

---

## 1. Constraints that shape everything

| Constraint                                            | What it says                                                                                                                                                                                                                                                                                                                                                                                               | Effect on this product                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strava API agreement** (in force since 11 Nov 2024) | A user's Strava data may be shown only to that user. It may not be used "for any model training related to artificial intelligence, machine learning or similar applications". Strava says coaching platforms giving feedback to users remain allowed; intervals.icu first announced it would hide Strava activities from coaches, then reported after talking to Strava that coach access could continue. | The master roster shows other athletes' EF derived from Strava streams. That is acceptable for a private group only if Strava agrees; get it in writing before adding users. Per-athlete regressions (N2, K3, D1) may fall under the training clause. Any coach or team product should not depend on Strava as the source. |
| **Strava rate limits**                                | 200 requests per 15 min and 2,000 per day for the whole application; 100 and 1,000 for reads.                                                                                                                                                                                                                                                                                                              | About 1,000 stream fetches a day across all users. Enough for tens of active riders; hundreds need an approved increase or another source.                                                                                                                                                                                 |
| **Garmin Connect Developer Program**                  | Free for approved business developers; provides full FIT files and daily health data. The application form for new access has been unavailable since at least spring 2026, with no reopening date announced. Existing access is unaffected.                                                                                                                                                                | Garmin direct is the most valuable source and currently cannot be applied for. Reach Garmin users through Terra (already integrated), through file upload, or through an aggregator the athlete already uses.                                                                                                              |
| **Wahoo Cloud API**                                   | OAuth, workout summaries, FIT files, webhooks.                                                                                                                                                                                                                                                                                                                                                             | The most accessible direct head-unit source. Verify current terms when building.                                                                                                                                                                                                                                           |
| **Oura API**                                          | Personal and OAuth applications; check the user cap that applies before app review.                                                                                                                                                                                                                                                                                                                        | Confirm before onboarding beyond the current group.                                                                                                                                                                                                                                                                        |
| **Open-Meteo**                                        | Free tier is non-commercial; commercial use needs a paid key.                                                                                                                                                                                                                                                                                                                                              | A small fixed cost appears the moment the product charges money.                                                                                                                                                                                                                                                           |
| **UCI rules**                                         | Devices that capture metabolic values such as glucose or lactate have been banned in competition since 2021.                                                                                                                                                                                                                                                                                               | Glucose features are training-only and must say so.                                                                                                                                                                                                                                                                        |
| **Health-data law**                                   | Health data is a special category under GDPR; several US states have consumer health-data laws.                                                                                                                                                                                                                                                                                                            | Explicit consent, export and delete (phase 9 builds these), a clear retention policy, and no minors without a guardian flow. Required before any public launch.                                                                                                                                                            |
| **Medical-device boundary**                           | Claims to detect or diagnose illness move a product toward regulation.                                                                                                                                                                                                                                                                                                                                     | Illness features (S1) stay worded as wellness observations.                                                                                                                                                                                                                                                                |

**The consequence: direct FIT ingestion is the most important infrastructure item on this
roadmap.** It removes the Strava display and training restrictions for that data, lifts the rate
ceiling, and unlocks fields Strava streams do not carry (R-R intervals, core temperature, left and
right balance, laps, developer fields). Order of approach: manual `.fit` upload first (no partner
approval), then Wahoo, then Garmin when applications reopen, then intervals.icu and TrainingPeaks
as sources athletes already sync to.

---

## 2. Position

| Product       | What it is                                                                           | Price                             | Where it stops                                                                                   |
| ------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| TrainingPeaks | training log, planning, coach marketplace, performance management chart              | free tier; Premium $19.95 a month | EF and decoupling are per-workout numbers with no recovery context and no environmental handling |
| intervals.icu | analysis close to TrainingPeaks Premium, with HRV, sleep and weight fields           | free, donation supported          | wellness data is displayed beside training, not interpreted with it                              |
| WKO5          | power-duration modelling                                                             | $179 one-time                     | desktop, power only                                                                              |
| Xert          | fitness signature, real-time capacity model                                          | subscription                      | power only                                                                                       |
| HRV4Training  | morning HRV with training advice                                                     | low-cost app                      | no power data                                                                                    |
| WHOOP, Oura   | recovery wearables; about 2.5 million members and about 2 million paying subscribers | subscription                      | strain is HR-based; they cannot see power, so they cannot tell fitness from fatigue on the bike  |
| Garmin        | training readiness on the device                                                     | bundled with hardware             | closed, generic, no per-athlete validation                                                       |

**The gap:** nobody interprets cardiac response to measured power against overnight recovery,
adjusted for conditions, with a stated confidence and evidence that the method works for the
individual. That is the product. It is an interpretation layer, not another training log, so it
should feed the tools athletes already use rather than try to replace them.

**What makes it defensible:** the champion/challenger framework and outcome backtests already in
the codebase. Few competitors can show a rider the measured noise of a metric on their own data,
or that a warning preceded a logged illness. Publish those results.

---

## Part A — Competitive and elite cyclists

### A.1 Now (0–3 months): finish the core and remove friction

| Feature                                                                                       | Why an elite rider wants it                                                        | Depends on                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| Stage F and E of the research plan (context capture, steady-block and model-based EF)         | an efficiency number that does not move with session intensity or weather          | —                                      |
| `.fit` upload                                                                                 | works with any head unit, no Strava dependency                                     | new upload endpoint and FIT parser     |
| Athlete profile with FTP history and auto-detected best efforts                               | every reference-intensity metric needs it; riders expect a power-duration curve    | F4                                     |
| Fitness, fatigue and form chart (chronic load, acute load, balance) with HRV and RHR overlaid | the chart every competitive cyclist already reads, with the missing recovery layer | per-user FTP; existing `training_load` |
| One-tap RPE and a note after each ride                                                        | the only input that separates fitness from overreaching (K2)                       | small UI and one column                |
| Reference-block detection                                                                     | a like-for-like reading several times a week for no extra training cost            | E1                                     |
| Morning brief by email or push                                                                | the answer before the ride, without opening a dashboard                            | B1, notification service               |

### A.2 Next (3–9 months): the features that sell it

| Feature                           | Detail                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durability profile**            | best power for 1, 5 and 20 minutes after 10, 20 and 30 kJ/kg of work, plus decoupling by ride duration (E5, S9). This is what separates professional tiers, and no consumer tool presents it with recovery context. |
| **HRV-guided day**                | keep or swap today's hard session from the 7-day HRV band (S13). The one recommendation protocol with randomized-trial support in cyclists.                                                                         |
| **Overreaching watch**            | the K2 classifier with load, RPE, best efforts and peak-HR suppression (S8).                                                                                                                                        |
| **Heat block tracker**            | personal heat penalty per degree and how it shrinks across a heat block (S11); core-temperature field when present.                                                                                                 |
| **Altitude camp mode**            | home-altitude baseline, the 4% exercise-HR rule, night RHR and SpO₂ where the wearable provides it (S10).                                                                                                           |
| **Race and taper mode**           | target events on the timeline, freshening view, post-race recovery kinetics (S14, S4).                                                                                                                              |
| **W′ balance and critical power** | A2; also enables match-counting in races.                                                                                                                                                                           |
| **Coach and team view**           | triage list ("who needs attention today"), comments on flags, squad comparison against each rider's own baseline. Built only on data sources whose terms allow it. Needs the organisation model in §4.              |
| **Export and API**                | CSV and a read API for the athlete's own derived data; push the daily state into TrainingPeaks or intervals.icu notes.                                                                                              |
| **Season comparison**             | this block against the same block last year, by training phase.                                                                                                                                                     |

### A.3 Later (9–18 months)

| Feature                        | Detail                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| In-ride HRV thresholds         | aerobic threshold from DFA-α1 on R-R data in FIT files (S16); tracks threshold drift without lab tests.                                   |
| Planned-workout awareness      | read the calendar from TrainingPeaks or intervals.icu and attach readiness advice to the specific session.                                |
| Lab and blood data             | lactate curves, VO₂ tests and blood markers entered or imported as dated events, shown against the trends.                                |
| Glucose in training            | CGM overlay on drift and fuelling (S18), training-only.                                                                                   |
| Women's health mode            | cycle-aware baselines and phase-specific insight (S15).                                                                                   |
| Travel and jet-lag             | sleep-timing shift and expected recovery lag around travel.                                                                               |
| Narrative weekly review        | generated text grounded only in the computed statistics. This is the first feature with a recurring per-use cost; the D2b cautions apply. |
| Mobile app and device presence | home-screen widget; a Connect IQ data field that runs the reference block and marks it in the file.                                       |
| Team privacy controls          | medical-staff roles, per-field consent, audit log, data residency.                                                                        |

---

## Part B — Broadening the user base

### B.1 Segments

| Segment                                                                         | Size signal                                                                                              | What must change                                                                                                                                  | Fit                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Runners and triathletes**                                                     | the largest adjacent group; running dominates activity platforms (Strava reports over 180 million users) | pace:HR with grade-adjusted pace, the running form of the same analytic; decoupling for long runs; multi-sport load                               | High. Same engine, new deriver family. Friel's method was defined for both. |
| **Indoor-only riders**                                                          | every smart-trainer owner has power                                                                      | trainer-first onboarding; indoor is the most repeatable setting, so readings are cleanest here                                                    | High. Lowest support burden.                                                |
| **Cyclists without a power meter**                                              | most recreational riders                                                                                 | climb-based proxy: ascent rate ÷ HR on repeated climbs, or speed ÷ HR on repeated flat segments in similar wind; lower confidence, stated as such | Medium. Needs segment matching (D2a).                                       |
| **Wearable-first athletes** (WHOOP, Oura, Garmin, Apple Watch owners who train) | millions of paying subscribers who are told their recovery but not whether training is working           | more daily-metric sources through Terra, Apple Health and Health Connect; simplified language                                                     | High. The recovery half of the product already exists for them.             |
| **Coaches and small teams**                                                     | pay per seat; bring athletes with them                                                                   | organisation model, consent, compliant sources, triage view                                                                                       | High value, gated by §1.                                                    |
| **Masters and returning athletes**                                              | growing; motivated by health as well as performance                                                      | return-from-illness and return-from-injury monitoring; conservative defaults; monthly rather than daily framing                                   | Medium.                                                                     |
| **Fitness-minded general users**                                                | very large; one market report puts fitness apps at $8.1 billion in 2023                                  | a single "aerobic fitness trend" with plain-language explanations; no jargon; walking and easy-run support                                        | Medium. Different product voice; do not dilute the core.                    |
| **Other power sports**                                                          | rowing, Nordic skiing, virtual racing communities                                                        | sport-specific derivers                                                                                                                           | Low for now.                                                                |
| **Clinical and cardiac rehab**                                                  | —                                                                                                        | regulated                                                                                                                                         | Explicit non-goal.                                                          |

Recommended order: indoor-only riders and wearable-first cyclists (no new analytics), then
runners and triathletes (one new deriver family), then coaches and teams (once a compliant source
exists), then the general-fitness tier.

### B.2 What the product needs in order to widen

- **Onboarding that works in a day, not a month.** The classifier needs 28 days of baseline.
  Backfill history at connect time (Terra does 90 days; Strava history through F5), and show
  useful single-metric views while baselines fill.
- **Plain-language layer.** Every state has a one-sentence explanation and a "why" drawer with the
  numbers. Expert detail is one click away, never the default for new segments.
- **Honest confidence.** K4 everywhere. A wider audience is less able to discount a noisy flag.
- **Sport abstraction.** `activity_efforts` assumes power. Generalise to an "external load" and
  "internal load" pair so pace, ascent rate and rowing power fit without a second schema.
- **Units, languages, accessibility.** Imperial units, localisation, and WCAG AA on the charts.

### B.3 Go-to-market

| Lever                          | Detail                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrations as distribution   | be visible where athletes already are: a daily note pushed into TrainingPeaks and intervals.icu, a Connect IQ field, a Zwift or MyWhoosh companion flow                                        |
| Evidence as marketing          | publish the validation results: metric noise, leakage before and after adjustment, backtests. "Shows its working" is a position none of the large products hold.                               |
| Open-source the scoring engine | the package is already pure and separable. Opening it buys credibility with the technical audience and with sports scientists, at the cost of making the method copyable. Decide deliberately. |
| Coaches as channel             | free coach seat, paid athlete seats; a coach brings 10–30 athletes                                                                                                                             |
| Club and team pilots           | development teams, university squads, local race teams; three pilots give outcome data for backtests                                                                                           |
| Academic partnership           | a sports-science group gets a data platform; the product gets a validation study and ground-truth events                                                                                       |
| Content                        | plain explanations of EF, decoupling, durability and HRV, each ending in the tool                                                                                                              |

### B.4 Pricing hypotheses (to test, not to assume)

- Free: connect sources, see single-metric trends and the daily state.
- Athlete, about $6–10 a month: adjusted EF, durability, HRV-guided day, heat and altitude modes,
  history beyond 90 days, export. intervals.icu being free sets the ceiling for charts alone, so
  the paid tier must be interpretation, not visualisation.
- Coach or team, per athlete seat: triage, comments, squad views, roles and audit.
- Unit cost to watch: stream processing and storage per ride, weather calls, any generated-text
  feature. Everything else stays near zero per user under the §13 design.

---

## 4. Architecture implications

| Need                  | Change                                                                                                                                             | PLAN reference |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Coaches and teams     | replace the binary `user` / `master` role with organisations, memberships and per-athlete consent grants; RBAC stays server-side on every endpoint | §2, §12        |
| Many sources per role | FIT upload and more adapters behind the existing `ProviderAdapter` interface; source precedence already exists                                     | §6             |
| Hundreds of users     | queue-based ingest instead of webhook-inline processing; Strava rate-limit increase; the §14 scaling path                                          | §14            |
| Multi-sport           | external and internal load abstraction in `activity_efforts`; sport-specific deriver registries                                                    | §8.8           |
| Notifications         | email and push service, quiet hours, per-user preferences                                                                                          | new            |
| Mobile                | a responsive web app first; native only when notifications and widgets justify it                                                                  | §9             |
| Compliance            | consent records, retention policy, data-processing agreements with each provider, regional hosting                                                 | §12            |

---

## 5. Sequenced roadmap with gates

| Stage                     | Build                                                                                                                   | Gate to pass before the next stage                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Trust the number (now) | research-plan phases 10–14; `.fit` upload; per-user profile; RPE                                                        | a challenger deriver beats `peak20_v1` on noise and intensity leakage for most current users over 8 weeks       |
| 2. Daily usefulness       | morning brief; fitness and fatigue chart with recovery overlay; HRV-guided day; illness and non-training-stress signals | most current users open the brief on most days for a month; thumbs-up rate on flags above 70%                   |
| 3. Elite depth            | durability, heat, altitude, taper, overreaching watch, W′ balance                                                       | at least three competitive riders outside the current group use it through a full training block and log events |
| 4. Compliant multi-user   | Wahoo direct, Garmin when available, organisation model, coach view, consent                                            | written confirmation of data terms for every source shown to a coach; security review passed                    |
| 5. Open the door          | indoor-only and wearable-first onboarding; pricing test; public validation write-up                                     | conversion and four-week retention measured on a first cohort of about 100                                      |
| 6. Adjacent sports        | running and triathlon derivers; sport abstraction                                                                       | running EF meets the same noise and leakage bars as cycling                                                     |
| 7. Broad tier             | plain-language fitness trend, localisation, mobile                                                                      | retention of non-competitive users within reach of the core segment                                             |

Each gate is a measurement the system can already produce or will produce after phase 14, which
is the reason to build the comparison metrics early.

---

## 6. Risks

| Risk                                                   | Mitigation                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| A platform changes terms or closes access again        | no single source carries the product; FIT upload always works                                                          |
| The analytic is persuasive but wrong for an individual | per-user validation, confidence on every state, abstain rather than guess (already a design rule)                      |
| Alert fatigue                                          | standard-error-aware thresholds (K0), stability metric in the promotion rule                                           |
| Health-data breach                                     | existing token encryption and logging rules; add consent, retention limits and an external review before public launch |
| Scope spread across segments                           | one segment per stage, each behind a gate                                                                              |
| Large incumbents add a similar feature                 | they are unlikely to expose per-user evidence or run open comparisons; lead with that                                  |
| Free competitor sets price expectations                | charge for interpretation and coach workflow, not for charts                                                           |

---

## Sources

- [Strava API agreement changes, quoted and analysed (DC Rainmaker, Nov 2024)](https://www.dcrainmaker.com/2024/11/stravas-changes-to-kill-off-apps.html)
- [Strava rate limits](https://developers.strava.com/docs/rate-limits/)
- [Garmin Connect Developer Program overview](https://developer.garmin.com/gc-developer-program/overview) and [status of new applications (Terra, 2026)](https://tryterra.co/blog/garmin-connect-developer-program-pause)
- [Wahoo Cloud API summary](https://apis.io/providers/wahoo/)
- [Open-Meteo historical weather API](https://open-meteo.com/en/docs/historical-weather-api)
- [Continuous glucose monitors and the UCI in-competition ban (Fast Talk Labs)](https://fasttalklabs.com/articles/continuous-glucose-monitors-for-athletes)
- [Comparison of training platforms (Fast Talk Labs)](https://fasttalklabs.com/training/a-comparison-of-different-training-platforms)
- [WKO5 vs TrainingPeaks pricing and features](https://ctyeh.com/articles/958?lang=en)
- [WHOOP company profile (Sacra)](https://sacra.com/c/whoop/)
- [Strava user figures (TechCrunch, Oct 2025)](https://techcrunch.com/2025/10/12/strava-eyes-ipo-as-gen-z-trades-dating-apps-for-running-clubs/)
- [Durability in professional cyclists: a field study](https://investiga.upo.es/documentos/63b2efbd7109c1657f644816)
- [HRV-guided training in cyclists (TrainingPeaks summary)](https://www.trainingpeaks.com/blog/new-study-widens-hrv-evidence-for-more-athletes/)
- [DFA-α1 and the aerobic threshold (Frontiers in Physiology)](https://frontiersin.org/journals/physiology/articles/10.3389/fphys.2020.596567/text)
