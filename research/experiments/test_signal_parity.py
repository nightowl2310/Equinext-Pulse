"""Parity test: the pure-Python export path and the pandas research path must agree.

signals.py (stdlib, used by the daily export job) and sizing.py + features.py
(pandas, used by backtests) compute the same quantities twice. Two
implementations of one definition is exactly how a dashboard ends up showing a
number no backtest ever validated.

This test fails loudly if they diverge.

    run:  python -m research.experiments.test_signal_parity
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import signals  # noqa: E402
import sizing  # noqa: E402
from research import data, episodes, features  # noqa: E402

TOL = 1e-9


def _compare(name: str, py_vals, pd_series, tol: float = TOL) -> bool:
    """Compare a pure-Python list against a pandas Series, ignoring warm-up Nones."""
    a = np.array([np.nan if v is None else float(v) for v in py_vals], dtype=float)
    b = pd_series.to_numpy(dtype=float)
    if len(a) != len(b):
        print(f"  FAIL {name}: length {len(a)} vs {len(b)}")
        return False

    both = ~np.isnan(a) & ~np.isnan(b)
    only_py = ~np.isnan(a) & np.isnan(b)
    only_pd = np.isnan(a) & ~np.isnan(b)
    if not both.any():
        print(f"  FAIL {name}: no overlapping non-null values")
        return False

    diff = np.abs(a[both] - b[both])
    worst = float(diff.max())
    ok = worst <= tol
    print(
        f"  {'PASS' if ok else 'FAIL'} {name:24s} compared {both.sum():5d} values, "
        f"max abs diff {worst:.3e}"
        + (f"  [py-only {only_py.sum()}, pd-only {only_pd.sum()}]"
           if (only_py.any() or only_pd.any()) else "")
    )
    return ok


def main() -> int:
    frame = data.load()
    close_list = [float(v) for v in frame.close]

    print("=" * 78)
    print("SIGNAL PARITY -- pure-Python export path vs pandas research path")
    print("=" * 78)
    print(f"data: {data.describe(frame)}\n")

    results = []

    # realised volatility
    results.append(
        _compare(
            "realised_vol",
            signals.realised_vol(close_list),
            sizing.realised_vol(frame.close),
        )
    )

    # position size
    results.append(
        _compare(
            "position_size",
            signals.position_size(signals.realised_vol(close_list)),
            sizing.position_size(frame.close),
            tol=1e-3,  # signals.position_size rounds to 3dp for JSON compactness
        )
    )

    # rolling percentile, checked against the research implementation used by
    # every feature -- this is the number the dashboard will display
    fii = [None if v is None else float(v) for v in frame.fut_FII]
    py_pct = [None if v is None else v / 100.0 for v in signals.rolling_percentile(fii)]
    pd_pct = features._rolling_pctile(frame.fut_FII)
    results.append(_compare("rolling_percentile", py_pct, pd_pct, tol=1e-3))

    # short-book saturation percentile -- the number the saturation panel ranks
    # against, on the GROSS short leg rather than the net
    short_fii = [None if v is None else float(v) for v in frame.futshort_FII]
    results.append(
        _compare(
            "saturation_percentile",
            [None if v is None else v / 100.0
             for v in signals.rolling_percentile(short_fii, signals.SATURATION_WINDOW)],
            episodes.rolling_percentile(frame.futshort_FII, signals.SATURATION_WINDOW),
            tol=1e-3,
        )
    )

    # ...and the EPISODES those percentiles resolve to. Parity on the series is
    # not parity on the trigger: the threshold is a cliff, so a 1e-9 disagreement
    # on a borderline day changes the episode count the dashboard reports as its
    # confidence. Compare the resolved dates, not just the maths.
    py_eps = [e["date"] for e in signals.saturation_episodes(
        [d.strftime("%Y-%m-%d") for d in frame.index], close_list, short_fii)]
    pd_eps = [frame.index[g[0]].strftime("%Y-%m-%d") for g in episodes.find_episodes(
        episodes.rolling_percentile(frame.futshort_FII, signals.SATURATION_WINDOW)
        >= signals.SATURATION_TRIGGER / 100.0)]
    same = py_eps == pd_eps
    print(f"  {'PASS' if same else 'FAIL'} {'saturation_episodes':24s} "
          f"{len(py_eps)} episodes, dates {'identical' if same else 'DIFFER'}")
    if not same:
        print(f"       export-only: {sorted(set(py_eps) - set(pd_eps))}")
        print(f"       research-only: {sorted(set(pd_eps) - set(py_eps))}")
    results.append(same)

    print()
    if all(results):
        print("PARITY HOLDS. The dashboard and the backtest compute the same numbers.")
        return 0
    print("PARITY BROKEN. Do not ship -- the dashboard would display unvalidated maths.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
