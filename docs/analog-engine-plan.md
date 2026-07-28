# Plan — Pattern-Analog Engine ("today looks like 2023-03-14")

**The ask:** read each participant's behaviour across index futures, calls and
puts; find when today's pattern last occurred; report what happened next; then
say go long, go short, or stay calm — separately for futures, calls and puts.

**Short answer:** the *retrieval* half is buildable and is genuinely useful. The
*directional recommendation* half is not supportable in the form specified — but
it is closer than it was this morning, and the reason is options data this repo
had written off. Evidence in [validation-log.md](validation-log.md) §2026-07-28.

---

## 1. Does simple regression work here? No — and the reason is not the model

Already settled by [research-spec.md](research-spec.md) §2: eight parameters
against ~52 effective observations, OOS R² **−2.43%**, hit rate 51.9%. Fed seven
purely random drifting series, the same regression produced "significant" features
just as often. It was inside the noise distribution.

The binding constraint is not the estimator. FII net level has autocorrelation
0.986 — a half-life of 50 days — so 2,599 trading days carry **~52 independent
observations**. And the four participants sum to zero by construction, so the
positioning matrix has a **zero eigenvalue**: 2.28 effective dimensions out of 4.
Client is FII with a minus sign (corr −0.92).

Your instinct to reach for analogs instead is right, and the spec independently
ranks analog matching #2 of 9 methods. **Analogs sidestep the parameter budget**
— one knob (neighbourhood size) instead of eight coefficients. That is why this
plan is built on them and not on regression.

---

## 2. What I measured before writing this

Three probes, k=50 neighbours, entry at t+1 open, matching restricted to history
older than the forecast horizon.

**Probe 1 — futures analogs predict direction.** Dead. Hit rate 0.490 / 0.520 /
0.580 at 5 / 10 / 20 days against an always-long base rate of 0.543 / 0.579 /
**0.630**. It loses to buying and holding at every horizon.

**Probe 2 — the fair version.** Probe 1 could be dismissed as "you benchmarked
against drift", so I ranked days by analog return *minus* trailing unconditional
return and measured top-vs-bottom decile spread:

| H | spread | first half | second half |
|---|---|---|---|
| 5d | −0.08% | **+0.26%** | **−0.59%** |
| 20d | +0.37% | **−0.92%** | **+0.96%** |

**The sign flips across the era split at both horizons.** Worse, the confidence
gates do not discriminate: bullish analogs returned +1.87%, bearish +1.20%,
unconditional +1.22%. Firing in opposite directions for the same outcome is the
signature of no signal at all. The futures-based version of your idea is dead.

**Probe 3 — the same machinery on calls and puts.** `features.py` rejects options
data, but it rejects *net* OI, and correctly (Client is a net put seller; the sign
means the opposite of what it looks like). That argument does not cover **ratios**
— the exact construction already used on futures. Built as short/long ratios and
put-call book skew per participant:

State `[FII call short/long, FII put short/long, Pro put-call skew, vol percentile]`

| H | spread | halves | ex-2020 | ex-2020+22 |
|---|---|---|---|---|
| 5d | +0.83% | +0.95 / +0.63 | +0.55 | +0.39 |
| 20d | +2.91% | +4.18 / +1.35 | +1.35 | +1.12 |

**No sign flip in any slice.** This is the first thing in this project to clear
era split and crisis drop together — the two attacks that killed the previous
three findings. The gates discriminate this time: bullish +2.62% vs bearish
+0.26% at H=20.

**But the bearish gate flips across halves (−0.35 / +1.61) while the bullish gate
holds (+3.13 / +1.51).** Read literally: the data supports *long or flat*. It does
not support short. Two weaker options states were also tested and are recorded as
dead/weak in the log so they don't come back as fresh ideas.

**Probe 4 — the ablation, because that state carried `realised_vol`.** Vol is this
project's one established variable, so the spread might be vol in options
clothing. Tested vol alone, and options alone:

| State | H=20 spread | halves | ex-2020 | ex-2020+22 |
|---|---|---|---|---|
| vol only (1 feature) | +0.48% | +0.81 / +0.49 | +0.16 | **−0.56** |
| **options only (3 features)** | **+2.53%** | +4.18 / +1.01 | +0.85 | **+0.72** |
| options + vol (4 features) | +2.91% | +4.18 / +1.35 | +1.35 | +1.12 |

**Vol alone does not reproduce it** — vol-only turns negative once crisis years
come out, at both horizons, while options-only stays positive in every slice. The
spread is genuinely options-driven.

Three things follow, and they change the plan:

1. **Drop to the 3-feature options-only state.** It respects
   `MAX_FEATURES_PER_MODEL = 3` — k-NN in 4 dimensions on ~12 effective episodes
   is exactly the curse that cap exists to prevent, and worse for k-NN than for
   OLS. Vol stays in the trunk (`sizing.py`), where it is established.
2. **The gate is not an options finding.** On vol alone the bullish gate scores
   +1.59% (halves +3.50/+2.18) — *larger* than the 4-feature state's +1.40%. Only
   the excess-spread is distinctly options-driven; the gate is largely
   vol-replicable and will not be presented otherwise.
3. **Crisis dependence is real.** Options-only H=20 spread falls +2.53% → **+0.72%**
   ex-2020+2022. Still positive everywhere — the first thing here to manage that —
   but thin, and it is the same shape that killed three earlier findings.

**Status: survived reconnaissance, not validated.** Year-by-year and permutation —
the attack that exposed an earlier "signal" as merely holding cash — have not run.

---

## 3. The correction this forces

The spec offers *"47 analogs matched"* as the honest way to express confidence.
Measured, it isn't. A k=50 neighbourhood contains a median of **11–13 independent
episodes**; matches arrive in consecutive runs, so the day count overstates the
evidence roughly 4×.

This matters directly to what you asked for. "This pattern last occurred in 2023
and 2024" is the *correct* unit — episodes, with dates. Every surface reports
episodes and names them; the day count is never shown alone. Already appended to
the log as a correction.

---

## 4. What gets built

The retrieval engine, in full. The directional call, only where evidence permits.

```
today's state ─┬─ futures ratios ─┐
               ├─ call ratios     ├─> k-NN over 2,330 days
               ├─ put ratios      │        │
               └─ realised vol ───┘        ▼
                                   ~12 independent episodes
                                   named: 2023-03-14, 2024-06-11, ...
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
            forward distribution    episode agreement       vol / regime
            median, IQR, worst      (how unanimous)         (spec §7 trunk)
                    └──────────────────────┼──────────────────────┘
                                           ▼
                              FUTURES: long / flat  (never short)
                              OPTIONS: magnitude view, not direction
                              size: existing sizing.py, trim-only overlay
```

**On calls vs puts specifically.** Whether to buy a call or a put is a *direction*
question and this data cannot answer it — that is probe 1 and 2. But whether to be
long or short *premium* is a **magnitude** question: P(|move| > x). The spec ranks
that #3 in learnability, well above direction, and it is the honest output for the
options leg. So the options recommendation is framed as buy-premium /
sell-premium / stand-aside, not call vs put.

**"Stay calm" is the default, not the fallback.** You listed it yourself as one of
three outputs. On this data it will be the most frequent answer, and a system that
says *no edge today* on most days is doing its job.

---

## 5. Phases

| # | Work | Gate to pass |
|---|---|---|
| **1** | Promote the three option ratios (`FII_call_sl`, `FII_put_sl`, `Pro_pc_skew`) into `research/features.py`, with the nets-vs-ratios distinction documented so the old rejection isn't misread as covering them. Exactly 3 — the cap is the budget, not a guideline. | Parity with probe numbers |
| **2** | `research/analog.py` — one module: state build, k-NN, **episode grouping**, forward distribution. One knob (k). No fitted parameters. | Deterministic, tested |
| **3** | **All five attacks** on the options-only state. Two build items first: a **block/circular permutation** (H=20 returns on consecutive days overlap 19/20, so an iid shuffle returns a meaningless p-value), and a k-NN entry point — `evaluate_predictor` fits OLS and cannot validate this hypothesis; `evaluate_rule` on the realised position series can. Log the result whichever way it goes. | 5/5 to ship a directional call; <5 ships retrieval only |
| **4** | Magnitude target for the options leg: P(\|move\| > 1%) over the analog set. Five attacks. | 5/5 to ship |
| **5** | Export into `participants_vs_nifty.json` under a new `analog` key, additive, schema-versioned, `validation` block travelling with the numbers per the existing contract. | Parity test, frontend contract unbroken |
| **6** | UI: matched episodes with dates, forward distribution, episode count as confidence. Recommendation rendered **only** for legs that passed phase 3/4. | — |

Phase 3 is the decision point. If A3 fails there, phases 1–2 and 5–6 still ship
and you get the thing you described — *"today most resembles 2023-03-14 and
2024-06-11; across 12 episodes forward 20-day was +1.8% median, −2.1% to +4.4%
interquartile, worst −9%"* — which is honest and is most of the value. What gets
withheld is the sentence that converts it into an instruction.

## 6. Constraints carried forward

1. **The system trades with the OI branch off.** Sizing stays the trunk.
2. **The analog branch may only reduce size**, never increase it —
   `sizing.apply_risk_overlay` already cannot multiply above 1.0.
3. **No short recommendation** from the analog engine. The bearish gate flipped;
   long/flat is what the evidence covers.
4. **Confidence is episode count, with dates.** Never day count, never a
   model-derived percentage. This applies to the evidence behind a gate as well
   as to the retrieval output — the H=20 bullish gate is 26 clusters, not 287 days.
5. Note the live weakness in the trunk: `sizing.py` is 4/5 and has underperformed
   buy-and-hold over 1–2 years (validation-log, period backtest). This plan does
   not fix that, and the analog work should not be read as covering it.

## 7. What would change the answer

Per spec §9, more years will not — the constraint is autocorrelation, so another
decade adds ~20 effective observations. **Intraday or per-expiry-cycle participant
snapshots would**, by attacking the constraint directly. `fii_stats_data/` is on
disk and still unexamined; it may hold FII cash flows, the best available
hedge-vs-directional proxy.
