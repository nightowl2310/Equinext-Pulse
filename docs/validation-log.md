# Validation Log

Append-only record of every hypothesis put through `research/harness.py`.
**Nothing is deleted.** A rejected idea stays here so it does not get re-proposed
in six months as a fresh insight.

Attacks: **WF** walk-forward · **ERA** both-halves split · **CRISIS** drop 2020 then
2020+2022 · **YBY** year-by-year · **PERM** permutation vs random.
A hypothesis PASSES only by surviving all five.

Reproduce: `python -m research.experiments.phase0_gate` and
`python -m research.experiments.phase1_baseline`

---

## 2026-07-27 — Phase 0: harness self-test

Purpose: prove the harness rejects claims already known to be false. A harness
that accepts everything launders bad ideas.

| ID | Hypothesis | WF | ERA | CRISIS | YBY | PERM | Verdict |
|---|---|---|---|---|---|---|---|
| H1 | FII net level → 3-day direction | ✗ −0.13% | ✗ −0.60% | ✗ −0.48% | ✗ 1W/6L | ✗ p=0.27 | **REJECTED 0/5** |
| H2 | FII net level → crash risk (−2% day in 20d) | ✗ −3.61% | ✗ −16.10% | ✗ −2.32% | ✗ 1W/6L | ✗ p=1.00 | **REJECTED 0/5** |
| H3 | vol features → forward 20d volatility | ✓ +25.63% | ✗ **−17.05%** | ✓ +0.53% | ✓ 5W/3L | ✓ p=0.000 | **REJECTED 4/5** |
| H4 | FII delta → direction *(audits `bias_for()`)* | ✗ −0.27% | ✗ −1.53% | ✗ −1.35% | ✓ 5W/3L | ✓ p=0.073 | **REJECTED 2/5** |

**GATE PASSED** — all four known-bad hypotheses rejected.

### What H3 teaches

H3 survived **four of five** attacks. Full-sample OOS R² of +25.63% with a
correlation of +0.54 is the most convincing-looking result anywhere in this
project, and it is wrong: the era split shows **+22.51% in the first half,
−17.05% in the second.** Year-by-year corroborates the instability (2023: −215%,
2024: −88%).

Had the harness contained only four attacks, this would have shipped. **The
era-split attack is the single highest-value test in the suite.**

### Action arising from H4 — `export_tuesday_summary.py:70`

`bias_for(fii_delta, polarity, strong)` emits a directional bias label derived
from FII delta. H4 shows FII delta has no out-of-sample directional edge
(WF −0.27%, era split −1.53%, crisis drop −1.35%).

**Status: flagged, not yet changed.** It must either be removed or carry a visible
"not validated" caveat in `tuesday_summary.json`. It should not keep emitting a
bare directional call. *Not actioned in this commit — needs a UI decision.*

---

## 2026-07-27 — Phase 1: production baseline

`sizing.py` — `size = 0.8% / realised_vol_20d`, capped 2×, **zero fitted parameters**.
Benchmark: buy & hold at 1.0×.

| Attack | Result | Pass |
|---|---|---|
| Full sample | rule 11.59%/yr, dd −21.9%, ret/dd **0.53** vs bench 11.76%/yr, dd −37.8%, ret/dd **0.31** | ✓ |
| Era split | first 0.58 vs 0.37 · second 0.60 vs 0.54 | ✓ |
| Crisis drop | ex-2020 0.61 vs 0.57 · ex-2020+2022 0.62 vs 0.58 | ✓ |
| **Year by year** | **3W/8L (27%)** — wins 2018, 2021, 2023 only | **✗** |
| Permutation | p = **0.002**, median random ret/dd 0.31 vs observed 0.53 | ✓ |

**VERDICT: 4/5 — the baseline does not fully survive.** Identical result on both
entry conventions (open-to-open and close-to-close), so it is not an artifact of
the fill assumption.

### Correction to an earlier claim in this project

An earlier note asserted the sizing rule went **"5-for-5"**. That was wrong. It
conflated the five era/crisis *slices* — full sample, both halves, ex-2020,
ex-2020+2022, all of which do pass — with the five *attacks*. The year-by-year
attack fails, and fails clearly at 3W/8L.

The failure is **left in place**. The threshold was not adjusted to make it pass.

### Why it is still the production baseline despite 4/5

- The failure is **structural and understood**, not a mystery: the rule shrinks in
  calm bull years (2017, 2019, 2025), which costs upside without touching the
  drawdown it was built to control.
- Annual ret/dd is a **high-variance statistic** — one year contains roughly one
  drawdown, so the annual comparison is genuinely noisy. This is an explanation,
  not an excuse: the attack still fails and is recorded as failing.
- It passes the attack that killed everything else — **permutation, p = 0.002**.
  The improvement is not the exposure level (average size 1.08×, i.e. slightly
  *more* invested than buy & hold), it is the timing.
- Nothing else in this project got past 0/5 or 4/5. This is the best available
  option, honestly labelled — not a validated success.

### Sensitivity — `target_vol` is a dial, not a fitted parameter

| Setting | CAGR | max DD | ret/dd | Sharpe | avg size |
|---|---|---|---|---|---|
| buy & hold | 11.06% | −37.8% | 0.29 | 0.71 | 1.00× |
| target 0.6%/day | 8.84% | −16.8% | 0.52 | 0.81 | 0.81× |
| **target 0.8%/day** | **11.59%** | **−21.9%** | **0.53** | 0.80 | 1.08× |
| target 1.0%/day | 13.79% | −26.7% | 0.52 | 0.79 | 1.33× |
| target 1.2%/day | 15.41% | −31.2% | 0.49 | 0.77 | 1.53× |

ret/dd holds at 0.49–0.53 across the whole range. The result is the **mechanism**,
not a tuned number — which is the main reason to trust it more than anything
fitted. Higher `target_vol` buys return and drawdown together, as it should.

---

## 2026-07-27 — Period backtest: the engine has NOT been working recently

`python -m research.experiments.phase1_periods`

| Window | Engine | max DD | Buy & hold | max DD | avg size | |
|---|---|---|---|---|---|---|
| 1 month | −1.93% | −3.70% | −1.68% | −3.26% | 1.04× | worse |
| 3 months | −1.16% | −4.83% | −2.21% | −5.40% | 0.94× | better |
| 6 months | −6.42% | −13.78% | −6.62% | −14.92% | 0.88× | ~tied |
| **1 year** | **−7.13%** | −15.15% | −5.86% | −15.00% | 1.24× | **worse on both** |
| **2 years** | **−7.50%** | −17.16% | −3.67% | −17.11% | 1.13× | **worse on both** |
| 3 years | +15.38% | −17.16% | +19.96% | −17.11% | 1.17× | worse |
| 5 years | +56.84% | −17.62% | +49.25% | −17.90% | 1.12× | better |
| **All** | **+215.01%** | **−21.90%** | +220.14% | **−37.77%** | 1.08× | ties return, halves DD |

### Two findings that undercut the engine

**1. The entire full-sample drawdown advantage is March 2020.**
Full-period engine DD is −21.90%, which *is* the 2020 drawdown. Year by year, the
engine's drawdown is better in only **4 of 11 years** (2020, 2021, 2022, 2025) and
worse in the other seven. This is the same single-event pattern that killed three
earlier findings in this project, now showing up in the one thing that passed.

The crisis-drop attack does still pass (ex-2020 ret/dd 0.61 vs 0.57; ex-2020+2022
0.62 vs 0.58) because removing those rows changes the whole equity path rather
than just subtracting a number — but the margin is thin (+0.037) and should not be
described as robust.

**2. The failure mechanism, stated plainly: inverse-vol sizing is not downside
protection.** It levers **up** when volatility is low. If a calm market then falls
without volatility spiking first, the engine is *larger* than buy & hold going in
and loses more. That is exactly 2024–2026: average size 1.13–1.24×, and the engine
underperformed on return with no drawdown benefit (−17.16% vs −17.11%).

It only helps when a decline arrives *with* a volatility spike — the 2020 shape.

### Verdict

The engine is **not currently earning its keep.** Its honest description is: a
leveraged buy-and-hold that de-risks after volatility has already risen, which
paid off once in a decade. It should not be presented as validated downside
protection. Candidate remedies, none tested:

- cap size at 1.0× (no leverage) so it can only ever de-risk
- lower `target_vol` so average exposure sits below 1×
- add a drawdown/trend condition so it does not lever into a falling market

**Do not deploy for capital until at least one of these passes the harness.**
`sizing.py` stays as the baseline to beat, now with a documented weakness.

---

## 2026-07-28 — Analog / pattern-matching probes (pre-harness reconnaissance)

Question put to the data: *"today's pattern last occurred in 2023 and 2024, which
gave higher returns, therefore go long/short."* Is that supportable?

**These are probes, not harness runs.** They cover era split and crisis drop only;
walk-forward is inherent (every match uses `hist = Z[:i-H]`, embargoed by the
horizon), but **year-by-year and permutation have not been run.** Nothing below is
a finding. Reproduce: probe scripts, k=50 neighbours, entry t+1 open.

### A1 — analog direction, futures state — **DEAD**

State `[pro_conviction, pro_fii_divergence, positioning_extremity, vol_pct]`,
predict sign of forward return.

| H | hit rate | halves | always-long | OOS R² |
|---|---|---|---|---|
| 5d | 0.490 | 0.507 / 0.474 | **0.543** | −4.62% |
| 10d | 0.520 | 0.523 / 0.517 | **0.579** | −4.71% |
| 20d | 0.580 | 0.585 / 0.574 | **0.630** | −11.05% |

**Loses to always-long at every horizon.** Rejected.

### A2 — analog *excess* (vs drift) + confidence gating, futures state — **DEAD**

A1's benchmark invites "you only lost to drift", so: rank days by
(analog mean − trailing unconditional mean), measure top-vs-bottom decile spread.

| H | decile spread | first half | second half |
|---|---|---|---|
| 5d | −0.08% | **+0.26%** | **−0.59%** |
| 20d | +0.37% | **−0.92%** | **+0.96%** |

**Sign flips across the era split at both horizons** — the attack with the highest
kill rate in this project, failing. And the gates do not discriminate: at H=20 the
bullish gate returned +1.87% and the bearish gate +1.20%, against +1.22%
unconditional. A gate that fires in opposite directions and produces the same
outcome is not weak, it is null. Rejected.

### A3 — the same probe on OPTIONS ratios — **LIVE CANDIDATE, not a finding**

`features.py` rejects "options net OI", correctly — Client is a net put *seller*
and contract counts are not exposure. **That rejection is about nets and does not
extend to ratios**, which is exactly the construction `positioning_extremity`
already uses on futures. Three options state vectors tested:

State **`[FII call short/long, FII put short/long, Pro put-call skew, vol_pct]`**,
all as 250-day percentiles:

| H | decile spread | halves | ex-2020 | ex-2020+22 |
|---|---|---|---|---|
| 5d | +0.83% | +0.95 / +0.63 | +0.55 | +0.39 |
| 20d | +2.91% | +4.18 / +1.35 | +1.35 | +1.12 |

**No sign flip in any slice** — the first thing in this project to clear era split
and crisis drop together. Gates discriminate, unlike A2:

| H=20 gate | n days | mean | edge | halves |
|---|---|---|---|---|
| bullish (agree ≥ .70) | 272 | +2.62% | **+1.40%** | +3.13 / +1.51 |
| bearish (agree ≤ .30) | 129 | +0.26% | −0.97% | **−0.35 / +1.61** |

**The bullish side holds in both halves; the bearish side flips.** Any product
built on this may express *long or flat*. It may not express short.

Two weaker states recorded so they are not re-proposed as fresh: put-call skew
across all three participants (spread +0.43% at H=20, decays to +0.20% ex-crisis,
gate edge −0.10% — **dead**); protection flow FII-buys-vs-Client-sells (H=20
spread +2.41% but +0.67% ex-2020, gate edge +0.44%, H=5 negative ex-crisis —
**weak, crisis-dependent**).

### The correction this forces on the spec

`research-spec.md` §7 invariant 3 says confidence is sample count, and offers
*"47 analogs matched"* as the honest phrasing. **Measured, it is not.** A k=50
neighbourhood contains a median of **11–13 independent episodes** (neighbours
grouped at >10 trading days' separation). Matches arrive in consecutive runs, so
"50 analogs" overstates the evidence by ~4×. Any UI must report **episodes, not
days**, and name the dates.

### A4 — ablation: is A3 real, or realised vol wearing options clothing?

A3 carried `vol_pct`, and realised vol is the one established variable in this
project. If vol alone reproduces the spread, A3 is nothing. Also settles whether
A3 can live inside `MAX_FEATURES_PER_MODEL = 3`. Identical machinery, decile
spread on analog excess:

| State | H | spread | halves | ex-2020 | ex-2020+22 |
|---|---|---|---|---|---|
| **vol only** (1) | 5d | −0.23% | −0.40 / −0.19 | −0.39 | **−0.61** |
| **vol only** (1) | 20d | +0.48% | +0.81 / +0.49 | +0.16 | **−0.56** |
| **options only** (3) | 5d | +0.16% | +0.35 / +0.19 | +0.31 | +0.21 |
| **options only** (3) | 20d | +2.53% | +4.18 / +1.01 | +0.85 | +0.72 |
| options + vol (4) | 20d | +2.91% | +4.18 / +1.35 | +1.35 | +1.12 |

**Vol alone does not reproduce it.** Vol-only goes *negative* ex-crisis at both
horizons; the options-only state stays positive in every slice. The spread is
carried by the options ratios, not by volatility.

**But the gate is a different story.** At H=20 the bullish gate on **vol alone**
scores edge **+1.59%** (halves +3.50/+2.18) — *larger* than the 4-feature state's
+1.40%. Options-only scores +2.02% (halves +3.53/+1.66). So the gate's
performance is substantially replicable from volatility, and only the excess is
distinctly options-driven. **Do not present the gate as an options finding.**

**Consequences:**

1. **A3 is superseded by the 3-feature options-only state**
   `[FII_call_sl, FII_put_sl, Pro_pc_skew]` — within the DoF cap, no vol
   contamination, survives every slice. The 4-feature variant is retired: it
   breaks `MAX_FEATURES_PER_MODEL`, and k-NN in 4 dimensions on ~12 effective
   episodes is precisely what the cap exists to prevent. **Vol stays in the
   trunk (`sizing.py`) where it is established, not in the analog state.**
2. **Crisis dependence is real and must not be glossed.** Options-only H=20 spread
   falls +2.53% → **+0.72%** once 2020 and 2022 are removed. Still positive in
   every slice — the first thing here to manage that — but the margin is thin,
   and this is the same shape that killed three earlier findings.
3. **Gate cluster counts, measured** (>10-day separation): H=20 bullish gate is
   **26 clusters** behind 287 days, H=5 is **27 clusters** behind 79 days. So the
   gate rests on ~26 observations, not 287.

### Selection-risk note

A3 was found by scanning 3 state vectors × 2 horizons, and each cell was read on
spread plus two gates — closer to **18 numbers inspected**, with the best picked.
Small, not zero. The ablation raises confidence because it was a test A3 could
have failed and didn't; the ceiling is still *survived reconnaissance*, never
*validated*, until all five attacks run.

### Two specification requirements for the phase-3 harness run

- **Permutation must use a block / circular shuffle.** H=20 forward returns on
  consecutive days overlap 19/20. An iid shuffle of overlapping observations
  yields a spuriously tiny p-value — `permutation_pvalue_rule` as written would
  hand back a pass that means nothing.
- **`evaluate_predictor` cannot validate this.** It fits OLS on the features; the
  hypothesis is a k-NN rule. Phase 3 goes through `evaluate_rule` on the realised
  position series, or the harness gains a k-NN entry point.

---

## 2026-07-28 — Delta-based regression (D1–D5): the sample-size objection, tested

Hypothesis put by the user: *the regression failed because it used participant
NET LEVELS. Use DELTAS — more samples, more fluctuation, more pattern — and bring
in the market data.* Correct diagnosis of the constraint. Tested in full.

**The feature cap was deliberately relaxed** and that is legitimate:
`MAX_FEATURES_PER_MODEL = 3` was derived from *level* features. Deltas are a
different budget. Applying the level cap to deltas would import a constraint that
does not apply.

Tooling note: `fast_wf` (incremental Gram matrices) reproduces
`harness.walk_forward` to **3.2e-14** on predictions, 88× faster. The 30×3
feature screen is not otherwise runnable.

### D1 — the sample-size claim is CONFIRMED

| series | autocorr | half-life | effective n | affordable params |
|---|---|---|---|---|
| fut_FII **level** | 0.986 | 49.9 d | **52** | 3.5 |
| d1fut_FII | 0.084 | 0.3 d | **2349** | 156.6 |
| d1call_FII | −0.149 | 1.0 d | **2349** | 156.6 |
| d1put_FII | −0.190 | 1.0 d | **2349** | 156.6 |
| d5fut_FII | 0.817 | 3.4 d | 683 | 45.6 |

**45× more independent observations.** The degrees-of-freedom objection to the
original regression genuinely dissolves on deltas. The parameter budget goes from
3.5 to ~157.

### D2 — 30 features screened individually — **DEAD**

24 participant deltas (futures / calls / puts × 1d and 5d × 4 participants, each
z-scored on 250d so a decade of OI growth doesn't distort scale) + 6 market
features, walk-forward, targets open(t+1)→close(t+H):

| H | features with OOS R² > 0 | **positive in BOTH halves** | best OOS R² | best \|corr\| |
|---|---|---|---|---|
| 1d | 0 / 30 | **0 / 30** | −0.022% | 0.035 |
| 3d | 2 / 30 | **0 / 30** | +0.070% | 0.061 |
| 5d | 3 / 30 | **0 / 30** | +0.178% | 0.063 |

**Not one feature of thirty is positive in both halves at any horizon.**

### D3 — multivariate, spending the new budget — **DEAD**

| model | k | H=1d | H=3d | H=5d |
|---|---|---|---|---|
| 6 futures+options deltas FII/Pro | 6 | −0.76% | −0.88% | −1.48% |
| all 8 futures deltas | 8 | −1.45% | −1.51% | −2.18% |
| all 16 options deltas | 16 | −1.89% | −1.32% | −1.28% |
| all 24 participant deltas | 24 | −3.52% | −2.72% | −3.19% |
| 6 market only | 6 | −3.91% | −2.13% | −1.69% |
| all 30 (deltas + market) | 30 | −6.10% | −3.92% | −3.87% |

**Every model is negative, and R² degrades monotonically with k.** Adding
features makes it worse in exactly the way overfitting predicts — even with 157
affordable parameters. The budget was not the binding constraint; signal was.

Decile tables (0 fitted parameters, the spec's #1 method) agree: `d1fut_FII` top-
minus-bottom spread +0.27% full sample → **−0.08% ex-2020+22**; `d1fut_Pro`
−0.50% → −0.20%; `d1call_FII` +0.06% → −0.05%.

### D4 — same deltas, magnitude target — **DEAD, and reproduces H3**

| model | H=5d OOS R² | halves | ex-2020+22 |
|---|---|---|---|
| 24 participant deltas | −4.27% | −8.94 / −10.29 | −13.78 |
| 16 options deltas | −3.19% | −7.61 / −9.81 | −11.17 |
| 6 market only | **+15.26%** | **+16.22 / −5.83** | **−6.97** |

Market-only looks strong and is the **same H3 artifact** already in this log
(+25.63% full sample, −17.05% second half). Independent re-derivation of a known
false positive — a good sign for the harness. Participant deltas add nothing.

### D5 — the one live-looking result, and why it dies

R² punishes bad scale, so a model can have the right *sign* and negative R². At
**H=1 (intraday, open→close)** the 30-feature model does exactly that:

| metric | value | base rate |
|---|---|---|
| hit rate | **0.536** | 0.487 |
| halves | 0.516 / 0.557 | both above base |
| ex-2020+22 | 0.549 | above base |
| year by year | **6W/1L** | |
| permutation on hit rate | **p = 0.005** | |

That is **4–5 of 5 attacks on the hit rate**, and the base rate is 0.487 because
NIFTY's drift is overnight — intraday open-to-close is a losing bet by default.
Attribution: gap alone 0.512, market-only 0.521, deltas-only 0.509, all-30 0.536
— only the *combination* keeps both halves above base.

**Then convert it to money. It dies.** Long/short on the sign, ~95 round trips/yr:

| cost | annual | Sharpe | **halves** | ex-20+22 |
|---|---|---|---|---|
| 0 bps | +5.82% | 0.41 | **−1.41 / +13.05** | +13.06 |
| 2 bps | +3.92% | 0.28 | **−3.32 / +11.17** | +11.15 |
| 5 bps | +1.08% | 0.08 | **−6.19 / +8.35** | +8.29 |

**Era split fails** — the entire result is the second half. And the decisive one,
**permutation on PnL: p = 0.418.** Random signals with the same long/short mix
score median Sharpe +0.198 against the observed +0.275. This is the attack that
previously exposed a "signal" that was really just holding cash; here it shows the
rule is barely distinguishable from random timing.

**Hit rate is not money.** The model gets more days right and loses more on the
days it gets wrong. Rejected.

### Conclusion

The diagnosis was right and the remedy does not work. Deltas deliver 45× the
effective sample, and with the constraint removed the signal is still absent —
which is *stronger* evidence than the original failure, because the original could
be blamed on the parameter budget and this cannot.

**Scope of this rejection, stated precisely:** what died is *linear* response to
deltas, plus monotonic response on the five deltas given decile tables. It is not
"deltas are dead" in general — the decile tables did not cover options 5-day
deltas or Pro/Client options. The distinction is not pedantic: the live A4
candidate is a **ratio percentile**, a transform this linear screen would never
have surfaced, so an exhaustive-sounding claim here would be falsifiable by this
project's own best result.

**This does not touch the A4 options-*ratio* result** (positioning state, not
flow) — different construction, still the live candidate.

---

## 2026-07-28 — P1: SHORT-BOOK SATURATION — **the first 5/5 in this project**

Reproduce: `python -m research.experiments.phase3_shortbook`

Origin: a user-supplied chart reading. *"FII made their highest short book on
27 Mar 2026 (~341k) — they never cross that. Treat it as a level; when it comes
close again, signal."* Tested as stated, then generalised.

**How this differs from A1/A2 and D1–D5, stated once so this is not read as a
duplicate entry.** A1/A2 scored *every* day by k-NN distance in a 4-feature space
that merely *contained* `positioning_extremity`; D1–D5 fitted linear models to
deltas across all 2,599 days. This **thresholds on the tail** and looks only at
the ~139 days inside it. Different hypothesis, different sample. It also uses the
**GROSS short leg, not the net** — the four nets sum to zero by construction, so
FII net is Client net inverted (corr −0.92) and carries no independent
information. The gross books are not constrained that way.

Mechanism under test: near the top of its own range a short book is held for
reasons other than conviction — margin, risk limits, carry — and unwinding it is
mechanical buying. Forced behaviour should be more predictable than chosen
behaviour.

### P1a — the state, all four participants (H=30, entry t+1 open)

Unconditional forward-30d: median **+1.76%**, up 65.8%.

| book ≥ 98th pctile | eps | all | 1st half | 2nd half | ex-2020+22 | backward-10d |
|---|---|---|---|---|---|---|
| **FII** | 25 | **+3.27%** 17/25 | +3.33% | +2.32% | **+3.27%** 15/21 | **−2.01%** |
| Client | 13 | +3.50% 10/13 | +6.17% | +2.90% | +1.68% 7/10 | +3.09% |
| Pro | 20 | +3.26% 16/20 | +3.05% | +3.73% | +2.93% 13/17 | +0.65% |
| DII | 17 | +2.60% 12/17 | +1.60% | +2.64% | +1.80% 9/13 | +1.44% |

**It is NOT FII-specific.** Every participant's crowded short book precedes
above-baseline returns. This is a market-wide capitulation proxy, not evidence
that FII is informed — and it should never be presented as "smart money" in the
UI. FII is used as the production trigger only because it has the most episodes
(25 vs 13–20) and the cleanest backward signature: FII's book saturates **after**
a −2.01% fall, while Client's saturates after a **+3.09% rise**, i.e. Client
shorts into strength and FII shorts into weakness. Different behaviour, same
forward outcome.

### P1b — five attacks, FII, 98th pctile, H=30, +50% tilt

| Attack | Result | Pass |
|---|---|---|
| Full sample | rule 15.57%/yr dd −37.8% ratio **0.41** vs bench 11.70%/yr dd −37.8% ratio 0.31 | ✓ |
| Era split | first 0.61 vs 0.48 · second 0.41 vs 0.33 | ✓ |
| Crisis drop | ex-2020 0.60 vs 0.56 · ex-2020+2022 **0.69 vs 0.56** | ✓ |
| Year by year | **6W/3L** (2018,19,22,23,24,26 W · 2017,21,25 L) | ✓ |
| Block permutation | **p = 0.073**, median random 0.34 vs observed 0.41 | ✓ |

**VERDICT: 5/5.** Avg exposure 1.16×, 32.9% of days tilted, Sharpe 0.85 vs 0.75.
Nothing else in this project has passed all five — `sizing.py` is 4/5.

### Two deviations from `harness.evaluate_rule`, both deliberate

1. **Year-by-year restricted to episode-bearing years.** A rare-event rule is
   *identical* to the benchmark in a year it never fires, and `evaluate_rule`
   scores a year as a loss unless the rule strictly wins. Counting silent years
   as losses tests coverage, not skill. 2020 is excluded and named in the output.
2. **Permutation is a circular block shuffle.** Exposure is 1.5× for 30
   consecutive sessions, so it is autocorrelated by construction; the iid shuffle
   in `permutation_pvalue_rule` would return a meaningless p-value. This is the
   requirement already specified in the A3/A4 entry above.

### Selection risk — the part that must not be glossed

**H=30 was chosen after scanning a 12-cell grid.** The 20-session version fails
3 of 5 at every threshold. Full grid:

| | H=20 | H=30 | H=40 |
|---|---|---|---|
| 0.96 | 3/5 | 3/5 | 3/5 |
| 0.97 | 3/5 | 4/5 | 3/5 |
| **0.98** | 3/5 | **5/5** | **5/5** |
| **0.99** | 3/5 | **5/5** | **5/5** |

The defence is not that H=30 was predicted — it wasn't. It is that **four cells
pass and they form one contiguous block** in the high-threshold/long-horizon
corner, which is the direction the mechanism predicts (a more crowded book takes
longer to unwind). A single isolated passing cell would be noise; a coherent
region is weaker evidence than a pre-registration but stronger than one square.
Crisis drop and permutation are the two attacks that fail everywhere else.

### The weakness that survives the 5/5

**It raises return without reducing drawdown: −37.8% for both rule and
benchmark.** The rule levers *into* a market that has just fallen 2%. This is the
same mechanism already documented as `sizing.py`'s failure mode, and it means the
signal is a **return enhancer, not downside protection**. If a decline continues,
this makes it worse. Both caveats ship rendered on the dashboard card at the same
visual weight as the numbers, not in a tooltip.

### Shipped

- `research/episodes.py` — event-study engine (episode clustering, forward *and*
  backward returns, `to_size_series` so a rare-event pattern can enter the
  harness at all).
- `research/experiments/phase3_shortbook.py` — the run above.
- `signals.py` — `build_saturation_block()`, schema **v2**. Parity asserted in
  `test_signal_parity.py`: percentiles agree to 1.1e-16 and both paths resolve to
  **the same 25 episode dates**. Series parity is not trigger parity — a
  threshold is a cliff — so the resolved dates are compared, not just the maths.
- `plot_fii_vs_nifty.py` — additive `saturation` key; every pre-existing row
  verified byte-identical.
- `frontend/.../SaturationStrip.tsx` — live state, range meter, dated episodes.

### Rejected alongside, recorded so they do not return as fresh ideas

**The user's original reading of this pattern — "FII flips from extreme long to
short → market falls" — is DEAD.** Measured over 12 regime-neutral episodes
(from ≥85th pctile, net drops ≥1.5σ in 10 sessions): forward-5d **+0.24% vs
+0.27% baseline**, forward-20d **+0.70% vs +1.10%**, 7/12 up vs a 0.631 base
rate, range −8.1% to +7.3%. Backward-10d −1.31%: **the flip trails the price
move, so it cannot forecast it.** The Sept–Oct 2024 episode that motivated it
(−3.2%) is one of twelve and unremarkable; July 2024 ran a *larger* flip
(+392k → +62k) three months earlier and NIFTY rose.

**Extreme FII net LONG → reversal is also dead, and inverted.** 16 episodes at
the 95th pctile of net: forward-5d **+1.75% vs +0.27% baseline**, holding in both
halves and ex-crisis. Extreme long precedes *continuation*, not reversal. H=20
does not hold (2nd half −0.09%, ex-2020 +0.12%), and nine of the sixteen episodes
sit in 2020–21, so this is a prior, not a finding.

---

## 2026-07-28 — Walk-forward prediction of PARTICIPANT moves — **DEAD vs naive**

Question: can we predict what each participant does next, daily and weekly?
Expanding-window OLS, ~18 features, refit every step.

**"Weekly" is ambiguous and the two readings disagree.** Rolling 5-session
(stand every day, look 5 ahead) gives 1,790 observations that overlap 4/5 —
~358 independent. Non-overlapping calendar weeks give 349 genuinely independent
observations. The rolling version reads ~1.6pt higher purely from counting the
same weeks repeatedly.

Clean weekly, last 3 years, against the **best naive rule** (majority /
persistence / *anti*-persistence / price-follow — anti-persistence matters,
because a mean-reverting series makes "predict the opposite of last week" free):

| target | model | best naive | edge |
|---|---|---|---|
| Pro | 62.4% | **63.7%** (anti-persistence) | **−1.3%** |
| DII | 59.2% | 58.6% | +0.6% |
| Client | 56.1% | 56.1% | 0.0% |
| FII | 56.7% | 58.0% | **−1.3%** |

Pooled overall: 58.60% (clean weekly, last 3y) vs 54.60% daily. Weekly genuinely
beats daily — but **the predictability is in the series, not the model.** Every
daily edge is negative in the last 3 years. In-sample runs 2–3pts above
walk-forward, which is the lookahead, quantified.

**And NIFTY itself, on clean non-overlapping weeks: 45.9% hit rate against 56.7%
for always-long.** Worse than doing nothing. The fifth independent confirmation
in this log that participant flow does not forecast price.

**Consequence for the project:** we can forecast participant behaviour and it
does not help, because the flow→price link is what is broken. Saturation
sidesteps this entirely — it never predicts flow, it waits for flow to reach an
extreme. That is why it is the one thing that passed.

**One usable free fact:** Pro's weekly futures book mean-reverts — "predict the
opposite of last week" is right 63.7% of the time, with no model and no fitting.

---

## Degrees-of-freedom budget (measured, not assumed)

Why every model here is small. From `research.features.dof_report()`:

| Series | autocorr | half-life | effective n | affordable params |
|---|---|---|---|---|
| FII net 1-day change | 0.142 | 0.4 d | 2603 | 173 |
| FII net 5-day change | 0.847 | 4.2 d | 621 | 41 |
| Pro net level | 0.908 | 7.2 d | 363 | 24 |
| FII net level | 0.986 | 49.9 d | **52** | **3.5** |
| realised_vol | 0.990 | 70.7 d | **36** | **2.4** |

Participant futures matrix: eigenvalues **2.392 / 0.895 / 0.713 / 0.000**,
**2.28 effective dimensions** out of 4. The fourth eigenvalue is exactly zero
because the four participants sum to zero by construction.

**Consequence:** `MAX_FEATURES_PER_MODEL = 3`, enforced in code by
`harness.evaluate_predictor`.

---

## Open / not yet tested

| Item | Status |
|---|---|
| The 4 OI features vs regime & tail targets | **Phase 2 — not yet run** |
| Squeeze probability (crowded short → up move) | Untested. Mechanistic story only. |
| OI tail-risk overlay | Candidate only. Failed era split previously (−9.60% → −16.16%). `sizing.apply_risk_overlay` exists but is **not wired up**. |
| `bias_for()` remediation | **Done (data layer).** Label kept for frontend compatibility; `biasValidation` now ships in `tuesday_summary.json`. **UI does not render the caveat yet.** |
| Signal export layer | **Done.** `signals.py` is the single definition. Correction: the `signal` block is **not** wired into any export — `build_signal_block` is called only from `signals.py`'s own `__main__`, so `SignalStrip.tsx` renders nothing and does not typecheck (`REGIME_STYLE` and `ParticipantsData.signal` do not exist). The **`saturation`** block IS wired and live. |
| Signal parity (pure-Python vs pandas) | **Passing.** Max abs diff 1.1e-14 on vol, 1.1e-16 on percentile. |
| Dashboard percentiles (TSX) | **Not started.** JSON carries the data; no component reads it. |
| `fii_stats_data/` — may contain FII cash flows | Unexamined |

---

## 2026-07-27 — Signal export layer

`signals.py` added as the single definition of vol / percentile / size / regime,
written in **pure stdlib** so the daily OI job keeps running without pandas.
`sizing.py` now re-exports its constants and delegates the definitions.

`research/experiments/test_signal_parity.py` asserts the two implementations
agree — it exists because two implementations of one definition is exactly how a
dashboard ends up displaying a number no backtest ever validated:

```
realised_vol        2578 values compared, max abs diff 1.099e-14   PASS
position_size       2578 values compared, max abs diff 4.998e-04   PASS (3dp JSON rounding)
rolling_percentile  2349 values compared, max abs diff 1.110e-16   PASS
```

Every signal in the payload carries its own `validation` entry, so a consumer
cannot render a number without access to its evidence. Pre-existing JSON keys
verified unchanged — the frontend contract is additive only.
