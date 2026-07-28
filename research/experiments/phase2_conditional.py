"""PHASE 2c -- is the OI tail flag SEPARATE information, or a restatement of vol?

phase2_overlay established two facts that look contradictory:

    * the OI tail model ranks crash risk genuinely (top decile 36.1% vs bottom
      8.2%, and the lift survives the era split -- the first thing in this
      project that ever has), yet
    * using it to trim position size makes the engine WORSE (edge -0.021 full,
      -0.066 ex-crisis, 3W/4L year by year).

Both can be true only if the flag knows roughly what realised vol already knows.
The inverse-vol rule is ALREADY de-risking on the same days, so the trim is
double-counting, and on the days the flag is wrong it just costs return.

This file tests exactly that:

    1. how correlated is the flag with realised vol?
    2. does the flag add lift WITHIN vol buckets -- i.e. two days of identical
       volatility, one with crowded/aggressive positioning and one without: do
       they actually differ? That is the only version of this signal that is
       worth showing a trader.
    3. the second-best target from the league table, |move| > 1%, which is a
       straddle question rather than a direction question.

    run:  python -m research.experiments.phase2_conditional
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from research import data, features, targets  # noqa: E402
from research.harness import MIN_TRAIN, r2, walk_forward  # noqa: E402

BAR = "=" * 78
OI_SET = ["pro_conviction", "positioning_extremity", "book_churn"]


def main() -> int:
    frame = data.load()
    X = features.build(frame)
    tail = targets.forward_big_down_day(frame, 20, 2.0).rename("crash20")
    wf = walk_forward(X[OI_SET], tail, min_train=MIN_TRAIN)

    vol = X.realised_vol.reindex(wf.index)
    w = wf.join(vol.rename("vol")).dropna()

    print(BAR)
    print("1. IS THE OI FLAG JUST VOLATILITY WEARING A HAT?")
    print(BAR)
    print(f"  corr(OI crash prediction, realised_vol)      : {w.pred.corr(w.vol):+.3f}")
    print(f"  corr(OI crash prediction, vol_acceleration)  : "
          f"{w.pred.corr(X.vol_acceleration.reindex(w.index)):+.3f}")
    for f in OI_SET:
        print(f"  corr({f:24s}, realised_vol) : {X[f].corr(X.realised_vol):+.3f}")
    print()

    # -----------------------------------------------------------------------
    # 2. conditional lift -- the question that decides whether to ship it
    # -----------------------------------------------------------------------
    print(BAR)
    print("2. CONDITIONAL LIFT -- within each volatility tercile, does a high OI")
    print("   reading still separate crash days from calm days?")
    print(BAR)
    w["volq"] = pd.qcut(w.vol, 3, labels=["low vol", "mid vol", "high vol"])
    print(f"  {'vol bucket':10s} {'n':>5s} {'base crash%':>12s} "
          f"{'OI top 1/3':>11s} {'OI bot 1/3':>11s} {'lift pp':>8s}")
    for b, g in w.groupby("volq", observed=True):
        hi = g[g.pred >= g.pred.quantile(2 / 3)]
        lo = g[g.pred <= g.pred.quantile(1 / 3)]
        print(f"  {str(b):10s} {len(g):>5d} {g.act.mean() * 100:>12.1f} "
              f"{hi.act.mean() * 100:>11.1f} {lo.act.mean() * 100:>11.1f} "
              f"{(hi.act.mean() - lo.act.mean()) * 100:>+8.1f}")

    print("\n  --- same, restricted to the recent era (second half only) ---")
    w2 = w.iloc[len(w) // 2 :]
    for b, g in w2.groupby("volq", observed=True):
        if len(g) < 40:
            print(f"  {str(b):10s} n={len(g)} -- too few to read")
            continue
        hi = g[g.pred >= g.pred.quantile(2 / 3)]
        lo = g[g.pred <= g.pred.quantile(1 / 3)]
        print(f"  {str(b):10s} {len(g):>5d} {g.act.mean() * 100:>12.1f} "
              f"{hi.act.mean() * 100:>11.1f} {lo.act.mean() * 100:>11.1f} "
              f"{(hi.act.mean() - lo.act.mean()) * 100:>+8.1f}")

    print("\n  --- head to head: vol ALONE vs vol + OI, same target, same window ---")
    common = X[["realised_vol", "vol_acceleration"] + OI_SET].dropna().index
    common = common.intersection(tail.dropna().index)
    for name, cols in [("vol only", ["realised_vol", "vol_acceleration"]),
                       ("OI only", OI_SET),
                       ("vol + best OI", ["realised_vol", "pro_conviction",
                                          "positioning_extremity"])]:
        sub = walk_forward(X.loc[common, cols], tail.loc[common], min_train=MIN_TRAIN)
        h1, h2 = sub.iloc[: len(sub) // 2], sub.iloc[len(sub) // 2 :]
        exc = sub[~sub.index.year.isin([2020, 2022])]
        print(f"  {name:14s} full {r2(sub.act, sub.pred):>+7.2f}%  "
              f"h1 {r2(h1.act, h1.pred):>+7.2f}%  h2 {r2(h2.act, h2.pred):>+7.2f}%  "
              f"ex20+22 {r2(exc.act, exc.pred):>+7.2f}%")
    print()

    # -----------------------------------------------------------------------
    # 3. the volatility-of-move target -- a straddle question, not a direction one
    # -----------------------------------------------------------------------
    print(BAR)
    print("3. '|move| > 1% over 3 sessions' -- the best SKILL score in the league")
    print("   table (+4.1pp price-only). Direction discarded; energy kept.")
    print(BAR)
    big = (targets.forward_abs_move(frame, 3) > 1.0).astype(float).rename("bigmove")
    for name, cols in [("price only", ["realised_vol", "vol_acceleration"]),
                       ("OI only", OI_SET),
                       ("mixed", ["realised_vol", "pro_conviction", "positioning_extremity"])]:
        sub = walk_forward(X[cols], big, min_train=MIN_TRAIN)
        act, pred = sub.act.to_numpy(float), (sub.pred > 0.5).astype(float).to_numpy()
        base_class = 1.0 if act.mean() >= 0.5 else 0.0
        h1, h2 = sub.iloc[: len(sub) // 2], sub.iloc[len(sub) // 2 :]
        exc = sub[~sub.index.year.isin([2020, 2022])]

        def acc(s):
            a = s.act.to_numpy(float)
            p = (s.pred > 0.5).astype(float).to_numpy()
            bc = 1.0 if a.mean() >= 0.5 else 0.0
            return (a == p).mean() * 100 - (a == bc).mean() * 100

        print(f"\n  {name}")
        print(f"    base rate {act.mean() * 100:.1f}%  naive {(act == base_class).mean() * 100:.1f}%  "
              f"model {(act == pred).mean() * 100:.1f}%  SKILL {acc(sub):+.1f}pp")
        print(f"    skill by slice: h1 {acc(h1):+.1f}pp  h2 {acc(h2):+.1f}pp  "
              f"ex20+22 {acc(exc):+.1f}pp")
        print(f"    OOS R2: full {r2(sub.act, sub.pred):+.2f}%  h1 {r2(h1.act, h1.pred):+.2f}%  "
              f"h2 {r2(h2.act, h2.pred):+.2f}%  ex20+22 {r2(exc.act, exc.pred):+.2f}%")
        d = sub.copy()
        d["q"] = pd.qcut(d.pred, 5, labels=False, duplicates="drop")
        rates = d.groupby("q").act.mean() * 100
        print("    quintile actual big-move rate: " +
              "  ".join(f"Q{int(q) + 1} {v:.0f}%" for q, v in rates.items()))
        yrs = []
        for y, g in d.groupby(d.index.year):
            if len(g) < 100:
                continue
            yrs.append(f"{y}:{acc(g):+.0f}")
        print("    skill by year: " + " ".join(yrs))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
