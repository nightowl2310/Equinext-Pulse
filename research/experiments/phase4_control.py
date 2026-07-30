#!/usr/bin/env python3
"""
Phase 4 -- does the OI signal beat BUYING THE SAME DIP without looking at OI?

    python -m research.experiments.phase4_control

WHY THIS EXISTS
---------------
Phase 3 put short-book saturation through all five attacks and it passed 5/5.
But every one of those attacks used **buy-and-hold** as the benchmark. None of
them asked the question that actually decides whether the OI data earns its
place: a crowded FII short book tends to occur when NIFTY has fallen, and dips
mean-revert -- so is the edge coming from the OI, or from the dip?

That gap is the same shape as the A4 ablation in validation-log.md, which asked
whether the options-ratio candidate was really just realised volatility. It is
the one test a signal can fail that settles the matter, and phase 3 never ran it.

A day-level version of this was probed first and looked alarming: holding dip
depth constant, days with a crowded short book had LOWER forward returns
(-7% dip: +2.97% crowded vs +4.21% not). But that comparison is not fair --
"crowded" days cluster into a handful of episodes while "not crowded" days are
spread across the whole sample, so it compares 151 correlated observations
against 366 differently-correlated ones. This file redoes it properly:

  * MATCHED EPISODE COUNT. The price control's threshold is chosen so it fires
    roughly as often as the OI rule. Comparing an 18-episode rule against a
    114-episode rule confounds selectivity with skill.
  * IDENTICAL MACHINERY. Same clustering (>10 sessions), same entry (t+1 open),
    same hold, same tilt, same ret/dd metric.
  * BENCHMARK IS THE CONTROL, NOT CASH. harness.evaluate_rule takes a scalar
    benchmark; here the benchmark is another SIZE SERIES, so "beats buy-and-hold"
    is replaced by "beats the dip-buyer".
  * THE INCREMENTAL TEST. price-only vs (price AND OI). If adding the OI filter
    to a dip-buyer does not improve it, the OI adds nothing, whatever the
    standalone numbers say.

Read the INCREMENTAL block as the verdict. The standalone block is context.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from ..episodes import find_episodes, rolling_percentile
from ..harness import (
    CRISIS_YEARS,
    MIN_YEAR_DAYS,
    PERMUTATION_ALPHA,
    Attack,
    Report,
    return_over_drawdown,
)

WINDOWS = {"6M": 126, "1Y": 250, "3Y": 750}
OI_TRIGGER = 0.98
HOLD = 30
TILT = 0.5
DRAWS = 2000
WARMUP = 750          # the 3Y window needs it; used for ALL rules so slices match
GAP = 10


# ---------------------------------------------------------------------------
# rule construction
# ---------------------------------------------------------------------------


def oi_trigger(frame: pd.DataFrame, window: int, thr: float = OI_TRIGGER) -> pd.Series:
    return rolling_percentile(frame["futshort_FII"], window) >= thr


def dip_trigger(frame: pd.DataFrame, pct_off: float, window: int = 250) -> pd.Series:
    """NIFTY at least `pct_off`% below its trailing high. The plain dip-buyer."""
    high = frame.close.rolling(window).max()
    return (frame.close / high - 1) * 100 <= -pct_off


def size_from(frame: pd.DataFrame, trig: pd.Series, hold: int = HOLD,
              tilt: float = TILT) -> pd.Series:
    """Episode-clustered exposure: 1+tilt for `hold` sessions after each episode
    start, 1.0 otherwise. Clustering matters -- without it a 100-day-long trigger
    becomes 100 overlapping trades and the exposure profile stops being
    comparable between rules."""
    size = pd.Series(1.0, index=frame.index)
    n = len(frame)
    for g in find_episodes(trig, GAP):
        i = g[0]
        size.iloc[i + 1 : min(i + 1 + hold, n)] = 1.0 + tilt
    return size


def n_episodes(trig: pd.Series) -> int:
    return len(find_episodes(trig, GAP))


def match_dip(frame: pd.DataFrame, target: int) -> tuple[float, int]:
    """Pick the dip depth whose episode count lands closest to `target`."""
    best, best_n, best_err = None, 0, 10 ** 9
    for x in np.arange(1.0, 20.1, 0.5):
        k = n_episodes(dip_trigger(frame, float(x)).iloc[WARMUP:])
        if abs(k - target) < best_err:
            best, best_n, best_err = float(x), k, abs(k - target)
    return best, best_n


# ---------------------------------------------------------------------------
# evaluation -- benchmark is a SERIES, not a scalar
# ---------------------------------------------------------------------------


def evaluate_vs(frame: pd.DataFrame, size: pd.Series, bench: pd.Series,
                hypothesis: str, episode_years: set[int]) -> Report:
    ret = (frame.open.shift(-1) / frame.open - 1).fillna(0.0)
    j = pd.DataFrame({"r": ret, "s": size, "b": bench}).iloc[WARMUP:].dropna()
    strat, bmk = j.r * j.s, j.r * j.b
    rep = Report(hypothesis=hypothesis)

    def ratio(mask=None):
        s = strat if mask is None else strat[mask]
        b = bmk if mask is None else bmk[mask]
        return return_over_drawdown(s)[2], return_over_drawdown(b)[2]

    sf, bf = ratio()
    c, dd, _ = return_over_drawdown(strat)
    bc, bdd, _ = return_over_drawdown(bmk)
    rep.attacks.append(Attack(
        "full sample", "ret/dd edge", sf - bf, 0.0, sf > bf,
        f"rule {c:.2f}%/yr dd {dd:.1f}% ratio {sf:.2f} | ctrl {bc:.2f}%/yr dd {bdd:.1f}% ratio {bf:.2f}"))
    rep.notes.append(f"avg exposure {j.s.mean():.2f}x vs control {j.b.mean():.2f}x")

    mid = len(j) // 2
    first = j.index < j.index[mid]
    (s1, b1), (s2, b2) = ratio(first), ratio(~first)
    e = min(s1 - b1, s2 - b2)
    rep.attacks.append(Attack("era split", "worst half edge", e, 0.0, e > 0,
                              f"first {s1:.2f} vs {b1:.2f} | second {s2:.2f} vs {b2:.2f}"))

    edges, det = [], []
    for yrs in ([2020], CRISIS_YEARS):
        m = ~j.index.year.isin(yrs)
        sx, bx = ratio(m)
        edges.append(sx - bx)
        det.append(f"ex{'+'.join(map(str, yrs))}: {sx:.2f} vs {bx:.2f}")
    rep.attacks.append(Attack("crisis drop", "worst edge", min(edges), 0.0,
                              min(edges) > 0, "  ".join(det)))

    w = l = 0
    det, skip = [], []
    for year, grp in j.groupby(j.index.year):
        if len(grp) < MIN_YEAR_DAYS:
            continue
        if year not in episode_years:
            skip.append(str(year)); continue
        sy = return_over_drawdown(grp.r * grp.s)[2]
        by = return_over_drawdown(grp.r * grp.b)[2]
        w, l = (w + 1, l) if sy > by else (w, l + 1)
        det.append(f"{year}:{'W' if sy > by else 'L'}")
    share = w / (w + l) if w + l else 0.0
    rep.attacks.append(Attack("year by year", "share of yrs won", share, 0.4, share >= 0.4,
                              f"{w}W/{l}L  {' '.join(det)}  [silent: {','.join(skip) or 'none'}]"))

    rng = np.random.default_rng(11)
    sz, rr, bb = j.s.to_numpy(float), j.r.to_numpy(float), j.b.to_numpy(float)
    m = len(sz)
    null = np.empty(DRAWS)
    for i in range(DRAWS):
        k = int(rng.integers(m))
        rot = np.roll(sz, k)
        null[i] = (return_over_drawdown(pd.Series(rr * rot, index=j.index))[2]
                   - return_over_drawdown(pd.Series(rr * bb, index=j.index))[2])
    obs = sf - bf
    p = float((null >= obs).mean())
    rep.attacks.append(Attack("blk permutation", "p-value", p, PERMUTATION_ALPHA,
                              p < PERMUTATION_ALPHA,
                              f"median random edge {np.median(null):+.3f} vs observed {obs:+.3f}"))
    return rep


def years_of(frame: pd.DataFrame, trig: pd.Series) -> set[int]:
    return {frame.index[g[0]].year for g in find_episodes(trig, GAP)}


def main() -> int:
    frame = data.load()
    print(f"frame {len(frame)} rows  {frame.index[0].date()} -> {frame.index[-1].date()}")
    print(f"all rules evaluated from {frame.index[WARMUP].date()} "
          f"(warm-up shared so slices are comparable)\n")

    flat = pd.Series(1.0, index=frame.index)

    for name, W in WINDOWS.items():
        oi = oi_trigger(frame, W).iloc[WARMUP:].reindex(frame.index, fill_value=False)
        k_oi = n_episodes(oi)
        depth, k_dip = match_dip(frame, k_oi)
        dip = dip_trigger(frame, depth).iloc[WARMUP:].reindex(frame.index, fill_value=False)
        both = (oi & dip)

        s_oi, s_dip, s_both = size_from(frame, oi), size_from(frame, dip), size_from(frame, both)

        print("=" * 94)
        print(f"{name} WINDOW ({W}d)   OI: {k_oi} episodes   "
              f"matched dip control: NIFTY <= -{depth:.1f}% off 250d high, {k_dip} episodes   "
              f"OI&dip: {n_episodes(both)} episodes")
        print("=" * 94)

        print("\n-- standalone, each vs BUY & HOLD (what phase 3 measured) --")
        for lbl, s, t in (("OI only", s_oi, oi), ("dip only", s_dip, dip)):
            r = evaluate_vs(frame, s, flat, f"{name} {lbl} vs buy&hold", years_of(frame, t))
            print(f"  {lbl:9} {r.survived}/5   {r.attacks[0].detail}")

        print("\n-- HEAD TO HEAD: OI rule benchmarked against the matched dip-buyer --")
        r = evaluate_vs(frame, s_oi, s_dip, f"{name} OI vs matched dip control", years_of(frame, oi))
        print(r)

        print("\n-- INCREMENTAL (the verdict): does adding OI to a dip-buyer help? --")
        r2 = evaluate_vs(frame, s_both, s_dip, f"{name} dip AND OI vs dip alone", years_of(frame, both))
        print(r2)
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
