"""PHASE 2 SCAN -- which target is actually learnable, and is any of it skill?

Answers three questions the project has never measured together:

  1. For every candidate target: what is the BASE RATE (free, no model), what
     does a walk-forward model achieve, and what is the DELTA. A 62% hit rate
     against a 63% base rate is negative skill; only the delta is a finding.
  2. Does capping size at 1.0x (de-risk only) fix the documented failure --
     inverse-vol levering INTO calm markets that then fall?
  3. Does the squeeze story hold: crowded FII short -> forward up move?

    run:  python -m research.experiments.phase2_scan
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
    evaluate_predictor,
    evaluate_rule,
    return_over_drawdown,
    sharpe,
    walk_forward,
)

BAR = "=" * 78


# ---------------------------------------------------------------------------
# skill = achieved - base rate. The only honest way to quote "accuracy".
# ---------------------------------------------------------------------------


def binary_skill(wf: pd.DataFrame) -> dict:
    """Walk-forward accuracy of a linear-probability model vs always-guess-majority."""
    act = wf.act.to_numpy(float)
    pred = (wf.pred.to_numpy(float) > 0.5).astype(float)
    base_class = 1.0 if act.mean() >= 0.5 else 0.0
    return {
        "n": len(act),
        "base_rate_pct": act.mean() * 100,
        "baseline_acc_pct": (act == base_class).mean() * 100,
        "model_acc_pct": (act == pred).mean() * 100,
        "skill_pp": (act == pred).mean() * 100 - (act == base_class).mean() * 100,
    }


def bucket_table(feature: pd.Series, outcome: pd.Series, n: int = 5) -> pd.DataFrame:
    """Outcome by feature quintile. Zero fitted parameters -- cannot overfit."""
    j = pd.DataFrame({"f": feature, "y": outcome}).dropna()
    j["q"] = pd.qcut(j.f, n, labels=False, duplicates="drop")
    g = j.groupby("q").y
    return pd.DataFrame({"n": g.size(), "mean": g.mean(), "hit_pct": (g.apply(lambda s: (s > 0).mean() * 100))})


def _era_stable(feature: pd.Series, outcome: pd.Series, top_q: float, bottom_q: float) -> str:
    """Does the top-vs-bottom-decile spread hold in BOTH halves and ex-crisis?"""
    j = pd.DataFrame({"f": feature, "y": outcome}).dropna()
    out = []
    slices = {
        "full": j,
        "h1": j.iloc[: len(j) // 2],
        "h2": j.iloc[len(j) // 2 :],
        "ex20+22": j[~j.index.year.isin([2020, 2022])],
    }
    for name, s in slices.items():
        if len(s) < 200:
            out.append(f"{name}:n/a")
            continue
        hi = s[s.f >= s.f.quantile(top_q)].y.mean()
        lo = s[s.f <= s.f.quantile(bottom_q)].y.mean()
        out.append(f"{name}:{hi - lo:+.2f}")
    return "  ".join(out)


def main() -> int:
    frame = data.load()
    print(BAR)
    print("PHASE 2 SCAN -- target learnability, skill over base rate, and two fixes")
    print(BAR)
    print(f"data: {data.describe(frame)}\n")

    X = features.build(frame)

    # -----------------------------------------------------------------------
    # 1. TARGET LEAGUE TABLE -- what is even learnable here
    # -----------------------------------------------------------------------
    print(BAR)
    print("1. TARGET LEAGUE TABLE   (walk-forward, 3 features max, entry t+1 open)")
    print(BAR)

    binary_targets = {
        "direction up (3d)": targets.forward_up(frame, 3),
        "direction up (20d)": targets.forward_up(frame, 20),
        "|move| > 1% (3d)": (targets.forward_abs_move(frame, 3) > 1.0).astype(float),
        "a -2% day within 20d": targets.forward_big_down_day(frame, 20, 2.0),
        "a -3% day within 20d": targets.forward_big_down_day(frame, 20, 3.0),
    }
    feature_sets = {
        "price only": ["realised_vol", "vol_acceleration"],
        "OI only": ["pro_conviction", "positioning_extremity", "book_churn"],
        "mixed": ["realised_vol", "pro_conviction", "positioning_extremity"],
    }

    print(f"{'target':24s} {'features':12s} {'base%':>7s} {'naive%':>7s} "
          f"{'model%':>7s} {'SKILL pp':>9s} {'OOS R2%':>8s}")
    print("-" * 78)
    league = []
    for tname, tser in binary_targets.items():
        for fname, fcols in feature_sets.items():
            try:
                wf = walk_forward(X[fcols], tser.rename("y"), min_train=MIN_TRAIN)
            except ValueError as e:
                print(f"{tname:24s} {fname:12s}  skipped: {e}")
                continue
            s = binary_skill(wf)
            from research.harness import r2 as _r2
            oos = _r2(wf.act, wf.pred)
            league.append((tname, fname, s, oos))
            print(f"{tname:24s} {fname:12s} {s['base_rate_pct']:>7.1f} "
                  f"{s['baseline_acc_pct']:>7.1f} {s['model_acc_pct']:>7.1f} "
                  f"{s['skill_pp']:>+9.1f} {oos:>+8.2f}")

    print("\n  SKILL pp = model accuracy MINUS always-guess-the-majority accuracy.")
    print("  Anything <= 0 is a model that costs money to run and adds nothing.\n")

    # -----------------------------------------------------------------------
    # 2. FULL HARNESS on the best-looking tail target
    # -----------------------------------------------------------------------
    print(BAR)
    print("2. FULL 5-ATTACK HARNESS -- tail risk, the target research-spec ranks #2")
    print(BAR)
    for fname, fcols in feature_sets.items():
        rep = evaluate_predictor(
            frame, fcols,
            targets.forward_big_down_day(frame, 20, 2.0).rename("crash_20d"),
            hypothesis=f"[{fname}] {fcols} -> P(a -2% day within 20 sessions)",
        )
        print(rep)
        print()

    # -----------------------------------------------------------------------
    # 3. SIZING FIX A -- cap at 1.0x so the engine can only ever de-risk
    # -----------------------------------------------------------------------
    print(BAR)
    print("3. SIZING FIX A -- de-risk-only (cap 1.0x). Addresses the documented")
    print("   failure: inverse-vol levers UP into calm markets that then fall.")
    print(BAR)
    ret = targets.one_day_exposure_return(frame, basis="open")
    bench = return_over_drawdown(ret.dropna())
    print(f"  {'variant':30s} {'CAGR%':>8s} {'maxDD%':>8s} {'ret/dd':>7s} "
          f"{'Sharpe':>7s} {'avgSize':>8s}")
    print(f"  {'buy & hold':30s} {bench[0]:>8.2f} {bench[1]:>8.1f} {bench[2]:>7.2f} "
          f"{sharpe(ret):>7.2f} {1.00:>8.2f}")
    variants = {}
    for tv, cap in [(0.8, 2.0), (0.8, 1.0), (0.6, 1.0), (1.0, 1.0), (0.7, 1.0)]:
        s = sizing.position_size(frame.close, target_vol=tv, cap=cap)
        j = pd.DataFrame({"r": ret, "s": s}).dropna()
        c, d, rr = return_over_drawdown(j.r * j.s)
        label = f"tv {tv} cap {cap}x"
        variants[label] = s
        print(f"  {label:30s} {c:>8.2f} {d:>8.1f} {rr:>7.2f} "
              f"{sharpe(j.r * j.s):>7.2f} {j.s.mean():>8.2f}")
    print()

    print("  --- 5 attacks on the de-risk-only variants ---")
    for label in ["tv 0.8 cap 1.0x", "tv 1.0 cap 1.0x"]:
        rep = evaluate_rule(ret, variants[label], hypothesis=f"{label} vs buy & hold")
        print(rep)
        print()

    print("  --- year-by-year drawdown comparison (the attack that fails) ---")
    j = pd.DataFrame({"r": ret, "s2": variants["tv 0.8 cap 2.0x"],
                      "s1": variants["tv 0.8 cap 1.0x"]}).dropna()
    print(f"  {'year':6s} {'B&H ret%':>9s} {'cap2 ret%':>10s} {'cap1 ret%':>10s} "
          f"{'B&H dd%':>9s} {'cap2 dd%':>9s} {'cap1 dd%':>9s}")
    for y, g in j.groupby(j.index.year):
        b = return_over_drawdown(g.r)
        c2 = return_over_drawdown(g.r * g.s2)
        c1 = return_over_drawdown(g.r * g.s1)
        print(f"  {y:<6d} {b[0]:>9.1f} {c2[0]:>10.1f} {c1[0]:>10.1f} "
              f"{b[1]:>9.1f} {c2[1]:>9.1f} {c1[1]:>9.1f}")
    print()

    # -----------------------------------------------------------------------
    # 4. SQUEEZE -- crowded FII short -> forward up move? (never tested)
    # -----------------------------------------------------------------------
    print(BAR)
    print("4. SQUEEZE HYPOTHESIS -- crowded FII short -> forward up move")
    print("   positioning_extremity = pctile of FII short/long RATIO (escapes the")
    print("   zero-sum rank-3 constraint, so it is not a restatement of FII net).")
    print(BAR)
    ext = X.positioning_extremity
    for horizon in (3, 5, 10, 20):
        fwd = targets.forward_return(frame, horizon)
        t = bucket_table(ext, fwd)
        spread = t["mean"].iloc[-1] - t["mean"].iloc[0]
        print(f"\n  horizon {horizon}d   (top quintile crowding minus bottom: {spread:+.2f}%)")
        print(f"    {'quintile':10s} {'n':>5s} {'mean fwd %':>11s} {'hit %':>7s}")
        for q, row in t.iterrows():
            print(f"    Q{int(q) + 1:<9d} {int(row['n']):>5d} {row['mean']:>11.2f} "
                  f"{row['hit_pct']:>7.1f}")
        print(f"    stability (top20% - bottom20%): {_era_stable(ext, fwd, 0.8, 0.2)}")

    print("\n  --- same thing through the full harness (20d horizon) ---")
    rep = evaluate_predictor(
        frame, ["positioning_extremity"],
        targets.forward_return(frame, 20).rename("fwd20"),
        hypothesis="FII short/long crowding -> 20-session forward return (squeeze)",
    )
    print(rep)
    print()

    # -----------------------------------------------------------------------
    # 5. ANALOG MATCHING -- conditional distribution, not a point forecast
    # -----------------------------------------------------------------------
    print(BAR)
    print("5. ANALOG MATCHING -- 'of the K most similar past days, the outcome")
    print("   distribution was ...'. One knob (K). Confidence = sample count.")
    print(BAR)
    anchor = X[["realised_vol", "positioning_extremity", "pro_conviction"]].dropna()
    fwd10 = targets.forward_return(frame, 10)
    z = (anchor - anchor.mean()) / anchor.std()
    K = 50
    rows = []
    idx = z.index
    for i in range(MIN_TRAIN, len(idx)):
        hist = z.iloc[:i]
        d = ((hist - z.iloc[i]) ** 2).sum(axis=1)
        nn = d.nsmallest(K).index
        out = fwd10.reindex(nn).dropna()
        if len(out) < K * 0.6:
            continue
        rows.append({
            "date": idx[i],
            "p20": out.quantile(0.20), "median": out.median(),
            "p80": out.quantile(0.80), "n": len(out),
            "actual": fwd10.iloc[i],
        })
    an = pd.DataFrame(rows).set_index("date").dropna()
    cover = ((an.actual >= an.p20) & (an.actual <= an.p80)).mean() * 100
    uncond_p20 = fwd10.dropna().quantile(0.20)
    uncond_cover = ((an.actual >= uncond_p20)
                    & (an.actual <= fwd10.dropna().quantile(0.80))).mean() * 100
    print(f"  out-of-sample days scored : {len(an)}   K = {K} neighbours")
    print(f"  60% interval coverage     : {cover:.1f}%  (perfect calibration = 60.0%)")
    print(f"  same using a FIXED unconditional interval : {uncond_cover:.1f}%")
    print(f"  mean predicted p20        : {an.p20.mean():+.2f}%   "
          f"actual 20th pctile of outcomes: {an.actual.quantile(0.20):+.2f}%")
    lo, hi = an[an.p20 <= an.p20.quantile(0.2)], an[an.p20 >= an.p20.quantile(0.8)]
    print(f"  days the analog set warned worst (bottom 20% of p20):")
    print(f"      predicted p20 {lo.p20.mean():+.2f}%  ->  realised mean "
          f"{lo.actual.mean():+.2f}%,  realised 20th pctile {lo.actual.quantile(0.2):+.2f}%")
    print(f"  days it was calmest (top 20% of p20):")
    print(f"      predicted p20 {hi.p20.mean():+.2f}%  ->  realised mean "
          f"{hi.actual.mean():+.2f}%,  realised 20th pctile {hi.actual.quantile(0.2):+.2f}%")
    sep = lo.actual.quantile(0.2) - hi.actual.quantile(0.2)
    print(f"  tail separation (worst-warned vs calmest): {sep:+.2f}pp "
          f"-- negative means the warning was real")
    for name, s in [("h1", an.iloc[: len(an) // 2]), ("h2", an.iloc[len(an) // 2 :])]:
        l2, h2 = s[s.p20 <= s.p20.quantile(0.2)], s[s.p20 >= s.p20.quantile(0.8)]
        print(f"      {name}: separation {l2.actual.quantile(0.2) - h2.actual.quantile(0.2):+.2f}pp")
    print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
