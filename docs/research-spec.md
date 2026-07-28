# Research Spec — Equinext Pulse Signal Engine

**Question:** given only participant-wise OI and NIFTY prices, what is the
statistically strongest framework that can realistically be built?

**Answer:** a position-*sizing* engine, not a prediction engine. The reasoning
below is the evidence for that, and the code implements exactly it.

Companion: [validation-log.md](validation-log.md) holds every measured result.
Prior narrative: [signal-extraction.md](signal-extraction.md).

---

## 1. The binding constraint

Not the model. Not the features. **The effective sample size.**

```
FII net level   autocorr 0.986  half-life 49.9d  ->  effective n =  52
realised_vol    autocorr 0.990  half-life 70.7d  ->  effective n =  36
```

2,604 trading days of history contain roughly **36–52 independent observations**
of the slow-moving series. At the conventional 15 samples per parameter, the
entire budget is **~3 parameters.**

And the information does not get richer by adding columns:

```
participant futures matrix eigenvalues : 2.392 / 0.895 / 0.713 / 0.000
effective dimensions                   : 2.28 out of 4 participants
```

The fourth eigenvalue is **exactly zero** — the four participants sum to zero by
construction, so the matrix is rank 3. Client correlates −0.92 with FII: it is the
same series with a minus sign.

**You cannot engineer information into a rank-3 matrix.** Thirty features spanning
2.3 dimensions are thirty rephrasings of the same 2.3 facts, and near-collinearity
is precisely what makes coefficients flip sign out of sample.

Everything below is a consequence of this section.

---

## 2. Why the original linear regression failed

**It was over budget before it ran.** Eight parameters against ~52 effective
observations. It was structurally guaranteed to memorise.

**Proof it was fitting noise:** the same regression was fed seven purely random
slow-drifting series, 200 times. It produced 1.17 "significant" features on
average, hit 4-or-more significant in 4% of trials, and reached in-sample R² up to
1.92%. The real model scored 4 significant features and R² = 1.13% — **inside the
distribution that pure noise generates.**

**Why the OOS R² was negative (−2.43%):** the fitted coefficients encoded
relationships that *reversed* in the test window. Being confidently wrong costs
more than being uncommitted, so the errors exceeded those of always guessing the
mean. Observed directly: gap +1.89% first half → −0.59% second half.

**Why the t-statistics lied:** the t-stat formula assumes independent
observations. With autocorrelation 0.986, each row is ~98.6% a repeat of the
previous one. Every t-stat in that table was inflated by roughly √(2444/52) ≈ 6.9×.

### Was it the tool or the target? — The target.

The naive answer ("linear is wrong, use trees") is refuted by our own data: every
bucket table produced was **monotonic**. Monotonic response is exactly where trees,
forests and boosting buy nothing — linear was the right functional form.

The real diagnosis is signal-to-noise:

```
raw sd of 3-day returns          : 1.59%
residual sd after the model       : 1.58%     -> 0.6% of variance removed
```

No estimator recovers signal that is not there.

**The proof — same features, same estimator, different target:**

```
target = direction        : OI's contribution survived 0 of 4 robustness cuts
target = "a -2% day soon" : OI's contribution survived 3 of 4
```

The question was the bottleneck, never the tool.

---

## 3. What to predict instead

Ranked by learnability on *this* dataset:

1. **Regime label (stress / calm)** — a description of the present, not a
   forecast. Volatility clusters, so state persists.
2. **P(a >2% down day within N sessions)** — tail *frequency* is far more stable
   than tail *timing*; binary targets discard the magnitude noise that swamped
   the regression.
3. **P(|move| > 1%)** — drops the hardest thing (sign), keeps the predictable
   thing (energy).
4. **Conditional return distribution** (quantiles) — honest, and directly usable
   for sizing.
5. **Squeeze probability** — mechanistic (crowded shorts must cover). *Untested.*
6. ~~**Direction**~~ — **abandoned.** OOS R² −2.43%, hit rate 51.9%.

Implemented in `research/targets.py`, which is also the **single home of the
lookahead guard**: NSE publishes OI after the close, so every target starts at
`open.shift(-1)`. One deliberately-cheating function exists (`_lookahead_return`)
purely so the Phase 0 gate can prove the harness detects the difference.

---

## 4. Feature design — six candidates, three per model

`research/features.py`. The non-obvious pick leads:

| Feature | Why |
|---|---|
| **`pro_conviction`** | Pro desks turn their book over in days: autocorr 0.908 → **effective n = 363 vs FII's 52**. Seven times more independent information. Corroborated: `propct` carried the strongest t-stat (−3.48) of anything tested. **Everyone watches FII; the data says watch Pro.** |
| `pro_fii_divergence` | Pro correlates only −0.50 with FII, so this is a genuinely orthogonal axis. Client (−0.92) is not. |
| `book_churn` | Built on the 1-day change series — autocorr 0.142, **effective n = 2603**, the richest series available. Measures activity, not opinion. |
| `positioning_extremity` | A short/long **ratio**, not a net, so it escapes the zero-sum constraint. Captures crowding. |
| `realised_vol` | The most useful variable found anywhere in this project. |
| `vol_acceleration` | Regime-transition detector; nearly free in degrees of freedom. |

**Rejected, with reasons recorded in the module** so they are not re-proposed:
Client series (−0.92 mirror), all four participants (eigenvalue 0.000 = exact
collinearity), options net OI (Client is a net put *seller*; contract counts are
not exposure), interaction terms (each costs a parameter from a budget of 3.5),
FII net level alone (52 effective samples).

`MAX_FEATURES_PER_MODEL = 3`, enforced in code — `evaluate_predictor` raises
rather than warns.

---

## 5. One model, or one per regime?

**Regime-conditional *prediction* is unaffordable, and the arithmetic is not close:**

```
52 effective samples / 4 regimes  =  ~13 per regime
13 / 15 samples-per-parameter     =  0.87 parameters affordable per regime
```

You cannot fit a single parameter per regime. Splitting multiplies parameters by
the number of regimes while *dividing* effective sample by the same factor — a
quadratic hit to power, and seductive because in-sample fit always improves.

This is not theoretical. The dead "FII high vs low" finding **was** an accidental
regime model: it had fitted the crisis regime and been mistaken for a general law.

**The resolution: regime is an output, not a switch.**

- ❌ detect regime → fit a separate model per regime
- ✅ detect regime → **change position size**, same parameter-free rule everywhere

If you ever must split, split only on fast features (`fii_delta_5d`, effective
n = 621 → ~310 per half). **Two regimes on fast features is defensible; six
regimes on level features is self-deception.**

---

## 6. Method ranking for this dataset

Criterion: parameters demanded vs effective samples available, plus whether the
method's inductive bias matches a **monotonic** response.

1. **Probability tables** — ~0 fitted parameters; cannot overfit what it does not fit.
2. **Analog / similar-day matching** — one knob (neighbourhood size); produced the only defensible trade in this project.
3. **Bayesian with sceptical priors** — the correct formal tool for tiny effective n. Shrinkage is exactly the correction the OLS lacked.
4. **Logistic regression, 2–3 features** — right estimator for the right target; calibrated probabilities.
5. **HMM, 2 states** — regime genuinely *is* a latent state. Use it to label the present, not to forecast; its transition matrix is unstable on 52 samples.
6. **Linear regression** — diagnostic only. Demonstrated −2.43% OOS.
7. **Shallow tree (depth ≤2)** — tolerable as a regime labeller; as a predictor its only advantage (non-linearity) is unusable on monotonic response.
8. **Random Forest** — hundreds of effective parameters against 52 samples.
9. **Gradient Boosting** — worst available choice: maximum overfit capacity, minimum effective data, monotonic response.

**Ranked by sophistication this list is almost exactly inverted.** On this dataset
model capacity is a liability, not a feature.

---

## 7. Architecture

The obvious pipeline routes everything through prediction, making the weakest link
load-bearing. Inverted:

```
                    ┌─ PRIMARY (parameter-free, 4/5 attacks) ─────────┐
 price ──> realised vol ──> regime ──> POSITION SIZE ──> EXECUTE
                                            ▲
                                            │ trim only, never increase
 participant OI ──> 6 features ──> tail-risk flag (NOT WIRED UP)
                         │
                         └──> analog distribution ──> HUMAN CONTEXT
                                                        confidence = sample count
```

Three invariants:

1. **The system trades with the OI branch switched off.** Sizing is the trunk.
2. **OI may only reduce size.** A false negative costs upside; a false positive
   costs capital. Only the cheap error is permitted — enforced by
   `sizing.apply_risk_overlay`, which cannot multiply above 1.0.
3. **Confidence is sample count**, never model certainty. "47 analogs matched" is
   honest; "73% confident" from 52 samples is not.

---

## 8. Expectancy vs accuracy

```
long-run expectancy = Σ ( position size × edge )
```

- **Edge:** every attempt to estimate it failed out of sample. **No reliable control.**
- **Size:** requires no forecast, fully controllable, and measurably improves outcomes.

Regression optimises squared error on a point estimate. Expectancy depends on the
**shape of the loss distribution** — specifically the left tail. A model can
improve its R² while making the tail worse, and R² will never tell you. That is
optimising the wrong metric, on the term you cannot control, while ignoring the
term you can.

**Nothing multiplied by better sizing is still nothing — but everything we have is
in the sizing term.**

---

## 9. Data that would change this answer

**More years will not.** The constraint is autocorrelation, not calendar length:
another decade adds ~20 effective observations on the level features.

| Data | Why | Impact |
|---|---|---|
| Intraday / higher-frequency participant snapshots | Attacks the constraint directly — `fii_delta_5d` already shows n=621 vs 52 | **Very high** |
| Per-expiry-cycle snapshots | Separates real repositioning from mechanical rollover | High |
| Client *count* alongside contracts | Distinguishes one whale from 10,000 retail traders | High |
| FII cash-market flows — **check `fii_stats_data/`, may already be on disk** | Best available hedge-vs-directional proxy | Medium-high |
| More history | ~20 extra effective samples | Low |

All within the no-external-data constraint.

---

## 10. Status

| Phase | State |
|---|---|
| 0 — validation harness | **Done.** Gate passed: 4/4 known-bad hypotheses rejected. |
| 1 — production sizing baseline | **Done, 4/5 attacks.** Year-by-year fails 3W/8L; recorded, not tuned away. |
| Signal export layer | **Done.** `signals.py` single definition; parity-tested against the pandas path. |
| `bias_for()` remediation | **Data layer done** — `biasValidation` ships in the JSON. UI caveat not rendered yet. |
| 2 — feature research | Not started |
| 3 — promotion gate | Not started |
| 4 — OI overlay | Blocked on Phase 3 |
| Dashboard percentiles (TSX) | Not started — JSON carries the data, no component reads it |

### Signal contract

`participants_vs_nifty.json` gained one additive key, `signal`, with per-date
arrays on the existing date axis:

```
signal.vol[]                     trailing 20d daily vol, %
signal.volPercentile[]           rank vs trailing 250 sessions
signal.size[]                    PRODUCTION output: target_vol / vol, capped 2x
signal.regime[]                  calm | normal | elevated | stressed  (descriptive)
signal.positioningPercentile.FII[]   FII net futures rank
signal.positioningPercentile.Pro[]   Pro net futures rank
signal.latest                    scalar snapshot + plain-English labels
signal.validation                per-signal status + the evidence behind it
signal.schemaVersion             bumped on shape change, so drift is detectable
```

Only FII and Pro are ranked: Client is a −0.92 mirror of FII, and DII barely
moves. `validation` travels **with** the numbers by design — a consumer cannot
render a signal without also holding the evidence for it.

**The house rule:** a pattern you have not attacked is not a finding, it is a
hypothesis. Three confident findings died in this project's first pass. The
harness exists so the fourth does not survive by luck — including when the claim
is mine.
