"""PHASE 0 GATE -- does the harness correctly kill things we KNOW are wrong?

A validation harness that passes everything is worse than no harness, because it
launders bad ideas. So before it judges anything new, it must judge four claims
whose wrongness is already established, and reject all four.

    H1  FII net level predicts 3-day direction
    H2  FII net level predicts crash risk (a -2% day within 20 sessions)
    H3  Volatility is forecastable from vol features here
    H4  FII delta predicts direction  <-- audits bias_for() in
                                         export_tuesday_summary.py:70

Plus a lookahead detector: the same hypothesis is scored with an honest target
(entry at t+1 open) and a cheating one (entry at today's close, using an OI file
published after that close). If the harness cannot tell them apart, the guard in
targets.py is not doing its job.

    run:  python -m research.experiments.phase0_gate
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from research import data, features, targets  # noqa: E402
from research.harness import evaluate_predictor, r2, walk_forward  # noqa: E402

PCT_WINDOW = 250


def legacy_series(frame: pd.DataFrame) -> dict[str, pd.Series]:
    """The rejected features, rebuilt here so the registry stays clean."""
    fii = frame.fut_FII
    return {
        "fii_net_pctile": fii.rolling(PCT_WINDOW, min_periods=PCT_WINDOW).apply(
            lambda x: (x.iloc[-1] > x).mean(), raw=False
        ),
        "fii_delta_5d": fii.diff(5),
        "fii_delta_1d": fii.diff(1),
    }


def main() -> int:
    frame = data.load()
    print("=" * 78)
    print("PHASE 0 GATE -- the harness on trial")
    print("=" * 78)
    print(f"data: {data.describe(frame)}\n")

    print("DEGREES-OF-FREEDOM BUDGET (why every model here is small)")
    print(features.dof_report(frame).to_string(index=False))
    print()

    legacy = legacy_series(frame)
    reports = []

    # -- H1 -------------------------------------------------------------------
    reports.append(
        evaluate_predictor(
            frame,
            pd.DataFrame({"fii_net_pctile": legacy["fii_net_pctile"]}),
            targets.forward_return(frame, 3).rename("fwd_3d_return"),
            hypothesis="H1  FII net level -> 3-day direction  (EXPECT FAIL)",
        )
    )

    # -- H2 -------------------------------------------------------------------
    reports.append(
        evaluate_predictor(
            frame,
            pd.DataFrame({"fii_net_pctile": legacy["fii_net_pctile"]}),
            targets.forward_big_down_day(frame, 20, 2.0).rename("crash_20d"),
            hypothesis="H2  FII net level -> crash risk  (EXPECT FAIL)",
        )
    )

    # -- H3 -------------------------------------------------------------------
    reports.append(
        evaluate_predictor(
            frame,
            ["realised_vol", "vol_acceleration"],
            targets.forward_vol(frame, 20).rename("fwd_vol_20d"),
            hypothesis="H3  vol features -> forward volatility  (EXPECT FAIL)",
        )
    )

    # -- H4: audit of the shipped bias_for() ---------------------------------
    reports.append(
        evaluate_predictor(
            frame,
            pd.DataFrame(
                {"fii_delta_5d": legacy["fii_delta_5d"],
                 "fii_delta_1d": legacy["fii_delta_1d"]}
            ),
            targets.forward_return(frame, 3).rename("fwd_3d_return"),
            hypothesis="H4  FII delta -> direction  [audits bias_for()]  (EXPECT FAIL)",
        )
    )

    for rep in reports:
        print(rep)
        print()

    # -- lookahead detector ---------------------------------------------------
    print("=" * 78)
    print("LOOKAHEAD DETECTOR -- honest target vs time-travelling target")
    print("=" * 78)
    X = pd.DataFrame({"fii_net_pctile": legacy["fii_net_pctile"]})
    honest = r2(*(lambda w: (w.act, w.pred))(walk_forward(X, targets.forward_return(frame, 3))))
    cheat = r2(*(lambda w: (w.act, w.pred))(walk_forward(X, targets._lookahead_return(frame, 3))))
    print(f"  entry at t+1 open (honest)  : OOS R2 {honest:+.3f}%")
    print(f"  entry at t close  (cheating) : OOS R2 {cheat:+.3f}%")
    print(f"  difference                   : {cheat - honest:+.3f} pts")
    print("  (both should be near zero here -- FII level has no directional edge")
    print("   either way. The guard's value is structural: it makes the cheating")
    print("   version impossible to write by accident.)")
    print()

    # -- gate verdict ---------------------------------------------------------
    print("=" * 78)
    failed_as_expected = [r for r in reports if r.verdict == "FAIL"]
    passed_unexpectedly = [r for r in reports if r.verdict == "PASS"]
    for rep in reports:
        mark = "correctly rejected" if rep.verdict == "FAIL" else "WRONGLY ACCEPTED"
        print(f"  {mark:20s} {rep.hypothesis.split('  ')[0]}  "
              f"({rep.survived}/{len(rep.attacks)} attacks survived)")
    print()
    if passed_unexpectedly:
        print("GATE FAILED: the harness accepted a known-bad hypothesis.")
        print("Do not trust any downstream result until this is fixed.")
        return 1
    print(f"GATE PASSED: all {len(failed_as_expected)} known-bad hypotheses rejected.")
    print("The harness is fit to judge new ideas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
