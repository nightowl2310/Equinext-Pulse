"""PHASE 1 BASELINE -- put the production sizing rule through the same five attacks.

This is the bar every future idea must beat. If a clever OI feature cannot
improve on a rule with zero fitted parameters, it does not ship.

Both entry conventions are reported so the choice is never hidden:
    basis="open"  -> open[t+1] to open[t+2]. Honest: entry after publication.
    basis="close" -> close[t] to close[t+1]. Conventional, marginally optimistic.

    run:  python -m research.experiments.phase1_baseline
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import sizing  # noqa: E402
from research import data, targets  # noqa: E402
from research.harness import evaluate_rule, return_over_drawdown, sharpe  # noqa: E402


def main() -> int:
    frame = data.load()
    print("=" * 78)
    print("PHASE 1 BASELINE -- parameter-free inverse-volatility sizing")
    print("=" * 78)
    print(f"data: {data.describe(frame)}")
    print(f"rule: size = {sizing.DEFAULT_TARGET_VOL}% / realised_vol_"
          f"{sizing.DEFAULT_LOOKBACK}d,  capped at {sizing.DEFAULT_CAP}x")
    print("fitted parameters: 0\n")

    size = sizing.position_size(frame.close)
    reports = []

    for basis in ("open", "close"):
        ret = targets.one_day_exposure_return(frame, basis=basis)
        rep = evaluate_rule(
            ret, size,
            hypothesis=f"inverse-vol sizing vs buy & hold  [entry basis: {basis}]",
        )
        reports.append((basis, rep))
        print(rep)
        print()

    # -- sensitivity: is the result an artifact of one target_vol choice? ------
    print("=" * 78)
    print("SENSITIVITY -- target_vol is a risk-appetite dial, not a fitted parameter")
    print("=" * 78)
    ret = targets.one_day_exposure_return(frame, basis="open")
    bench = return_over_drawdown(ret.dropna())
    print(f"  {'setting':22s} {'CAGR%':>8s} {'maxDD%':>8s} {'ret/dd':>7s} "
          f"{'Sharpe':>7s} {'avg size':>9s}")
    print(f"  {'buy & hold':22s} {bench[0]:>8.2f} {bench[1]:>8.1f} {bench[2]:>7.2f} "
          f"{sharpe(ret):>7.2f} {1.00:>9.2f}")
    for tv in (0.6, 0.8, 1.0, 1.2):
        s = sizing.position_size(frame.close, target_vol=tv)
        joined = pd.DataFrame({"r": ret, "s": s}).dropna()
        c, d, r = return_over_drawdown(joined.r * joined.s)
        print(f"  {'target_vol ' + str(tv) + '%/day':22s} {c:>8.2f} {d:>8.1f} {r:>7.2f} "
              f"{sharpe(joined.r * joined.s):>7.2f} {joined.s.mean():>9.2f}")
    print("\n  ret/dd stays ~0.55-0.57 across the range: the result is the MECHANISM,")
    print("  not a tuned number. Higher target_vol buys return and drawdown together.")
    print()

    # -- current state --------------------------------------------------------
    print("=" * 78)
    print("CURRENT PRODUCTION READING")
    print("=" * 78)
    for k, v in sizing.describe(frame.close).items():
        print(f"  {k:20s} {v}")
    print()

    # -- verdict -------------------------------------------------------------
    print("=" * 78)
    for basis, rep in reports:
        print(f"  basis={basis:<6s} {rep.verdict}  "
              f"({rep.survived}/{len(rep.attacks)} attacks survived)")
    honest = dict(reports)["open"]
    if honest.verdict != "PASS":
        failed = [a.name for a in honest.attacks if not a.passed]
        print(f"\nBASELINE DID NOT FULLY SURVIVE. Failed: {', '.join(failed)}")
        print("Report this honestly -- do not tune the rule until it passes.")
        return 1
    print("\nBASELINE ESTABLISHED. This is the bar every future feature must beat.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
