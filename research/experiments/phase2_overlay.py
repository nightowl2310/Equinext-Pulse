"""PHASE 2b -- the one survivor, taken all the way to a production decision.

phase2_scan found exactly one thing that passes the era-split attack (the test
that killed every previous finding in this project):

    [OI only] pro_conviction + positioning_extremity + book_churn
        -> P(a -2% day within the next 20 sessions)
        walk-forward +8.28%  era split +1.61/+4.43  crisis drop +3.95  perm 0.000

Accuracy at a 0.5 threshold is the WRONG way to read it -- the base rate is 29%,
so nothing ever crosses 0.5 and the classifier degenerates to "never". The value
is in the RANKING. This file measures the ranking directly:

    1. decile lift  -- how much more often does the top decile actually crash?
    2. overlay      -- does trimming size on a high reading beat plain inverse-vol
                       through all five attacks? This is the production question.
                       sizing.apply_risk_overlay may only ever REDUCE size.

    run:  python -m research.experiments.phase2_overlay
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import sizing  # noqa: E402
from research import data, features, targets  # noqa: E402
from research.harness import MIN_TRAIN, evaluate_rule, return_over_drawdown, sharpe, walk_forward  # noqa: E402

BAR = "=" * 78
OI_SET = ["pro_conviction", "positioning_extremity", "book_churn"]


def main() -> int:
    frame = data.load()
    X = features.build(frame)
    tail = targets.forward_big_down_day(frame, 20, 2.0).rename("crash20")

    print(BAR)
    print("PHASE 2b -- OI tail-risk model: lift, then the overlay decision")
    print(BAR)
    print(f"features: {OI_SET}")
    print(f"target  : P(any single -2% day within the next 20 sessions)\n")

    wf = walk_forward(X[OI_SET], tail, min_train=MIN_TRAIN)
    print(f"walk-forward out-of-sample predictions: {len(wf)}  "
          f"({wf.index[0].date()} to {wf.index[-1].date()})")
    print(f"unconditional crash rate (base rate)  : {wf.act.mean() * 100:.1f}%\n")

    # -----------------------------------------------------------------------
    # 1. DECILE LIFT -- the honest way to read a probability model
    # -----------------------------------------------------------------------
    print(BAR)
    print("1. DECILE LIFT -- out-of-sample. Does a high reading mean anything?")
    print(BAR)
    w = wf.copy()
    w["d"] = pd.qcut(w.pred, 10, labels=False, duplicates="drop")
    print(f"  {'decile':8s} {'n':>5s} {'model P%':>9s} {'ACTUAL crash%':>14s} "
          f"{'lift vs base':>13s}")
    base = w.act.mean()
    for d, g in w.groupby("d"):
        print(f"  D{int(d) + 1:<7d} {len(g):>5d} {g.pred.mean() * 100:>9.1f} "
              f"{g.act.mean() * 100:>14.1f} {g.act.mean() / base:>12.2f}x")

    top, bot = w[w.d == w.d.max()], w[w.d == w.d.min()]
    print(f"\n  top decile {top.act.mean() * 100:.1f}% vs bottom decile "
          f"{bot.act.mean() * 100:.1f}%  -> spread {(top.act.mean() - bot.act.mean()) * 100:+.1f}pp")

    print("\n  --- same split, but per era / ex-crisis (does the lift survive?) ---")
    for name, s in [("first half", w.iloc[: len(w) // 2]),
                    ("second half", w.iloc[len(w) // 2 :]),
                    ("ex 2020", w[w.index.year != 2020]),
                    ("ex 2020+2022", w[~w.index.year.isin([2020, 2022])])]:
        t = s.pred >= s.pred.quantile(0.9)
        b = s.pred <= s.pred.quantile(0.1)
        print(f"  {name:14s} top10% {s.act[t].mean() * 100:>5.1f}%  "
              f"bottom10% {s.act[b].mean() * 100:>5.1f}%  "
              f"spread {(s.act[t].mean() - s.act[b].mean()) * 100:>+6.1f}pp  "
              f"(base {s.act.mean() * 100:.1f}%)")

    print("\n  --- per year ---")
    for y, g in w.groupby(w.index.year):
        if len(g) < 100:
            continue
        t = g.pred >= g.pred.quantile(0.9)
        b = g.pred <= g.pred.quantile(0.1)
        print(f"  {y}  n={len(g):>3d}  base {g.act.mean() * 100:>5.1f}%  "
              f"top10% {g.act[t].mean() * 100:>5.1f}%  bottom10% {g.act[b].mean() * 100:>5.1f}%  "
              f"spread {(g.act[t].mean() - g.act[b].mean()) * 100:>+6.1f}pp")
    print()

    # -----------------------------------------------------------------------
    # 2. THE OVERLAY -- the actual production question
    # -----------------------------------------------------------------------
    print(BAR)
    print("2. OVERLAY -- trim inverse-vol size when the flag is high.")
    print("   apply_risk_overlay can only REDUCE size. Baseline to beat:")
    print("   plain inverse-vol, 4/5 attacks, ret/dd 0.53.")
    print(BAR)

    ret = targets.one_day_exposure_return(frame, basis="open")
    base_size = sizing.position_size(frame.close)

    # The flag is walk-forward: at date t it uses only a model fitted on < t, and
    # the percentile threshold is also computed from prior predictions only. No
    # part of it has seen its own answer.
    pred = wf.pred
    expanding_q = pred.expanding(250).quantile(0.80).shift(1)

    bench = return_over_drawdown(ret.dropna())
    plain = pd.DataFrame({"r": ret, "s": base_size}).dropna()
    c, d, r = return_over_drawdown(plain.r * plain.s)
    print(f"  {'variant':34s} {'CAGR%':>8s} {'maxDD%':>8s} {'ret/dd':>7s} "
          f"{'Sharpe':>7s} {'avgSize':>8s} {'%trimmed':>9s}")
    print(f"  {'buy & hold':34s} {bench[0]:>8.2f} {bench[1]:>8.1f} {bench[2]:>7.2f} "
          f"{sharpe(ret):>7.2f} {1.00:>8.2f} {0.0:>9.1f}")
    print(f"  {'inverse-vol only (baseline)':34s} {c:>8.2f} {d:>8.1f} {r:>7.2f} "
          f"{sharpe(plain.r * plain.s):>7.2f} {plain.s.mean():>8.2f} {0.0:>9.1f}")

    overlays = {}
    for pct, trim in [(0.80, 0.5), (0.80, 0.75), (0.90, 0.5), (0.70, 0.75), (0.90, 0.25)]:
        thresh = pred.expanding(250).quantile(pct).shift(1)
        flag = (pred > thresh).reindex(base_size.index).fillna(False)
        s = sizing.apply_risk_overlay(base_size, flag, trim=trim)
        j = pd.DataFrame({"r": ret, "s": s}).dropna()
        cc, dd, rr = return_over_drawdown(j.r * j.s)
        label = f"overlay top{round((1 - pct) * 100)}% trim to {trim:g}x"
        overlays[label] = s
        print(f"  {label:34s} {cc:>8.2f} {dd:>8.1f} {rr:>7.2f} "
              f"{sharpe(j.r * j.s):>7.2f} {j.s.mean():>8.2f} "
              f"{flag.reindex(j.index).mean() * 100:>9.1f}")
    print()

    print("  --- 5 attacks: overlay vs BUY & HOLD (same bar the baseline cleared) ---")
    best = "overlay top20% trim to 0.5x"
    rep = evaluate_rule(ret, overlays[best], hypothesis=f"{best} vs buy & hold")
    print(rep)
    print()

    print("  --- 5 attacks: overlay vs the INVERSE-VOL BASELINE (the real bar) ---")
    print("      benchmark is no longer 1.0x -- it is the existing engine.")
    print("      RESTRICTED to the walk-forward window: before 2020-03-03 the model")
    print("      does not exist, so including those years dilutes both sides equally")
    print("      and hides whether the overlay does anything.")
    joined = pd.DataFrame({"r": ret, "base": base_size}).dropna()
    joined = joined.loc[joined.index >= wf.index[0]]
    for label in [best, "overlay top10% trim to 0.5x"]:
        s = overlays[label].reindex(joined.index)
        strat = joined.r * s
        bnch = joined.r * joined.base
        cs, ds, rs = return_over_drawdown(strat)
        cb, db, rb = return_over_drawdown(bnch)
        print(f"\n  {label}")
        print(f"    full sample   overlay {cs:.2f}%/yr dd {ds:.1f}% ret/dd {rs:.2f}  |  "
              f"baseline {cb:.2f}%/yr dd {db:.1f}% ret/dd {rb:.2f}   "
              f"edge {rs - rb:+.3f}")
        mid = joined.index[len(joined) // 2]
        for nm, m in [("first half", joined.index < mid), ("second half", joined.index >= mid),
                      ("ex 2020", joined.index.year != 2020),
                      ("ex 2020+22", ~joined.index.year.isin([2020, 2022]))]:
            e = return_over_drawdown(strat[m])[2] - return_over_drawdown(bnch[m])[2]
            print(f"    {nm:13s} edge {e:+.3f}   "
                  f"({return_over_drawdown(strat[m])[2]:.2f} vs {return_over_drawdown(bnch[m])[2]:.2f})")
        wins = losses = 0
        yr = []
        for y, g in joined.groupby(joined.index.year):
            if len(g) < 100:
                continue
            a = return_over_drawdown(g.r * s.reindex(g.index))[2]
            b = return_over_drawdown(g.r * g.base)[2]
            wins, losses = (wins + 1, losses) if a > b else (wins, losses + 1)
            yr.append(f"{y}:{'W' if a > b else 'L'}")
        print(f"    year by year  {wins}W/{losses}L   " + " ".join(yr))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
