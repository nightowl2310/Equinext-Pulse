"""PHASE 2d -- the blind-spot overlay. Trim ONLY where the engine is blind.

THE CHAIN OF REASONING THIS FILE TESTS
--------------------------------------
docs/validation-log.md diagnoses the sizing engine's failure precisely:

    "inverse-vol sizing is not downside protection. It levers UP when volatility
     is low. If a calm market then falls without volatility spiking first, the
     engine is LARGER than buy & hold going in and loses more."

phase2_conditional then measured that the OI tail model is nearly orthogonal to
volatility (corr +0.196) and that its lift is LARGEST exactly in the blind spot:

    low vol  base crash 11.4%   OI-high 27.8%  OI-low 2.8%   lift +25.0pp
    mid vol  base crash 27.8%   OI-high 36.9%  OI-low 13.6%  lift +23.3pp
    high vol base crash 48.2%   OI-high 47.2%  OI-low 37.5%  lift  +9.7pp

phase2_overlay applied a GLOBAL top-20% threshold and it failed (edge -0.021).
That is consistent with the table above rather than contradicting it: a global
threshold fires mostly on high-vol days, where the engine is already small and
the lift is weakest. It trims what is already trimmed.

So the construction under test here: trim ONLY when volatility is low-to-mid AND
the OI reading is high. Everything else runs at plain inverse-vol size.

Everything is walk-forward. The model is fitted on data strictly before t, and
BOTH thresholds (the OI percentile and the vol percentile) are expanding-window
quantiles shifted one day, so neither has seen its own answer.

    run:  python -m research.experiments.phase2_blindspot
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import sizing  # noqa: E402
from research import data, features, targets  # noqa: E402
from research.harness import (  # noqa: E402
    MIN_TRAIN,
    evaluate_rule,
    permutation_pvalue_rule,
    return_over_drawdown,
    sharpe,
    walk_forward,
)

BAR = "=" * 78
OI_SET = ["pro_conviction", "positioning_extremity", "book_churn"]


def head_to_head(joined: pd.DataFrame, s: pd.Series, label: str) -> dict:
    """Overlay vs the inverse-vol baseline across every attack slice."""
    strat, bnch = joined.r * s.reindex(joined.index), joined.r * joined.base
    cs, ds, rs = return_over_drawdown(strat)
    cb, db, rb = return_over_drawdown(bnch)
    mid = joined.index[len(joined) // 2]
    slices = {
        "first half": joined.index < mid,
        "second half": joined.index >= mid,
        "ex 2020": joined.index.year != 2020,
        "ex 2020+22": ~joined.index.year.isin([2020, 2022]),
    }
    print(f"\n  {label}")
    print(f"    full sample  {cs:>6.2f}%/yr  dd {ds:>6.1f}%  ret/dd {rs:.2f}  |  "
          f"baseline {cb:.2f}%/yr dd {db:.1f}% ret/dd {rb:.2f}   EDGE {rs - rb:+.3f}")
    edges = []
    for nm, m in slices.items():
        e = return_over_drawdown(strat[m])[2] - return_over_drawdown(bnch[m])[2]
        edges.append(e)
        print(f"    {nm:12s} edge {e:+.3f}   "
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
    print(f"    year by year {wins}W/{losses}L   " + " ".join(yr))
    print(f"    Sharpe {sharpe(strat):.3f} vs baseline {sharpe(bnch):.3f}   "
          f"avg size {s.reindex(joined.index).mean():.3f} vs {joined.base.mean():.3f}")
    return {"edge_full": rs - rb, "edge_worst": min(edges), "wins": wins, "losses": losses,
            "cagr": cs, "dd": ds, "retdd": rs}


def main() -> int:
    frame = data.load()
    X = features.build(frame)
    tail = targets.forward_big_down_day(frame, 20, 2.0).rename("crash20")
    wf = walk_forward(X[OI_SET], tail, min_train=MIN_TRAIN)
    pred = wf.pred

    ret = targets.one_day_exposure_return(frame, basis="open")
    base_size = sizing.position_size(frame.close)
    vol = X.realised_vol

    print(BAR)
    print("PHASE 2d -- blind-spot overlay: trim only where inverse-vol is blind")
    print(BAR)
    print(f"walk-forward window: {wf.index[0].date()} to {wf.index[-1].date()} "
          f"({len(wf)} days)\n")

    # Expanding-window thresholds, shifted -- no threshold sees its own day.
    oi_hi = pred.expanding(250).quantile(0.70).shift(1)
    joined = pd.DataFrame({"r": ret, "base": base_size}).dropna()
    joined = joined.loc[joined.index >= wf.index[0]]

    print(BAR)
    print("BASELINE over the same window (this is the number to beat)")
    print(BAR)
    b = joined.r * joined.base
    cb, db, rb = return_over_drawdown(b)
    bh = return_over_drawdown(joined.r)
    print(f"  buy & hold        {bh[0]:>6.2f}%/yr  dd {bh[1]:>6.1f}%  ret/dd {bh[2]:.2f}")
    print(f"  inverse-vol only  {cb:>6.2f}%/yr  dd {db:>6.1f}%  ret/dd {rb:.2f}  "
          f"Sharpe {sharpe(b):.3f}  avg size {joined.base.mean():.3f}\n")

    print(BAR)
    print("VARIANTS -- 'vol below Nth pctile AND OI above 70th' -> trim")
    print(BAR)
    results = {}
    for vol_pct, trim in [(0.50, 0.5), (0.67, 0.5), (0.67, 0.75), (0.80, 0.5), (None, 0.5)]:
        if vol_pct is None:
            in_blindspot = pd.Series(True, index=vol.index)   # control: no vol condition
            name = f"OI>70th, ANY vol, trim {trim:g}x  (control)"
        else:
            in_blindspot = vol < vol.expanding(250).quantile(vol_pct).shift(1)
            name = f"OI>70th AND vol<{int(vol_pct * 100)}th, trim {trim:g}x"
        flag = ((pred > oi_hi) & in_blindspot.reindex(pred.index)).reindex(
            base_size.index).fillna(False)
        s = sizing.apply_risk_overlay(base_size, flag, trim=trim)
        results[name] = (s, flag)
        fired = flag.reindex(joined.index).mean() * 100
        r = head_to_head(joined, s, f"{name}   [fires {fired:.1f}% of days]")
        results[name] = (s, flag, r)

    # -----------------------------------------------------------------------
    print("\n" + BAR)
    print("FULL 5-ATTACK HARNESS on the best variant, vs BUY & HOLD")
    print("(the same bar the inverse-vol baseline cleared at 4/5)")
    print(BAR)
    best_name = max(results, key=lambda k: results[k][2]["edge_worst"])
    print(f"  best by worst-slice edge: {best_name}\n")
    s_best = results[best_name][0]
    rep = evaluate_rule(ret.loc[joined.index], s_best.reindex(joined.index),
                        hypothesis=f"{best_name} vs buy & hold")
    print(rep)

    print("\n" + BAR)
    print("PERMUTATION vs the BASELINE -- does the TIMING of the trims matter,")
    print("or would trimming the same number of random days do as well?")
    print(BAR)
    for name, (s, flag, r) in results.items():
        rng = np.random.default_rng(3)
        obs = return_over_drawdown(joined.r * s.reindex(joined.index))[2]
        f = flag.reindex(joined.index).to_numpy()
        null = []
        for _ in range(500):
            shuf = pd.Series(rng.permutation(f), index=joined.index)
            sz = joined.base.copy()
            sz[shuf.astype(bool)] *= 0.5
            null.append(return_over_drawdown(joined.r * sz)[2])
        null = np.array(null)
        print(f"  {name:46s} observed {obs:.3f}  random median {np.median(null):.3f}  "
              f"p={(null >= obs).mean():.3f}")

    print("\n" + BAR)
    print("WHAT THE FLAG ACTUALLY CAUGHT -- realised outcome on flagged days")
    print(BAR)
    s, flag, _ = results[best_name]
    f = flag.reindex(wf.index).fillna(False)
    act = wf.act
    print(f"  flagged days      : {int(f.sum())} of {len(f)} ({f.mean() * 100:.1f}%)")
    print(f"  crash rate flagged: {act[f].mean() * 100:.1f}%")
    print(f"  crash rate else   : {act[~f].mean() * 100:.1f}%")
    print(f"  base rate         : {act.mean() * 100:.1f}%")
    fwd = targets.forward_return(frame, 20).reindex(wf.index)
    print(f"  mean fwd 20d return, flagged : {fwd[f].mean():+.2f}%")
    print(f"  mean fwd 20d return, else    : {fwd[~f].mean():+.2f}%")
    print(f"  20th pctile fwd 20d, flagged : {fwd[f].quantile(0.2):+.2f}%")
    print(f"  20th pctile fwd 20d, else    : {fwd[~f].quantile(0.2):+.2f}%")
    for y, g in pd.DataFrame({"f": f, "a": act, "fwd": fwd}).groupby(f.index.year):
        if len(g) < 100:
            continue
        n = int(g.f.sum())
        if n == 0:
            print(f"  {y}  fired {n:>3d} days")
            continue
        print(f"  {y}  fired {n:>3d} days  crash rate on those {g.a[g.f].mean() * 100:>5.1f}% "
              f"vs {g.a[~g.f].mean() * 100:>5.1f}% elsewhere  "
              f"(mean fwd20 {g.fwd[g.f].mean():+.2f}% vs {g.fwd[~g.f].mean():+.2f}%)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
