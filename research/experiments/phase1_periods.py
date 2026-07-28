"""Period-by-period backtest of the production sizing engine.

Answers "what did it do over the last month / 6 months / ... ?" against buy & hold.

READ THE WARNINGS. Short windows are noise: one month is ~21 trading days and
contains at most one drawdown, so a 1M number says nothing about whether the
engine works. They are reported because they were asked for, flagged because
they will mislead otherwise.

Entry basis is open-to-open (the honest one: OI publishes after the close, so the
earliest actionable moment is the next open).

    run:  python -m research.experiments.phase1_periods
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import sizing  # noqa: E402
from research import data, targets  # noqa: E402

# (label, months back, is the window long enough to mean anything?)
WINDOWS = [
    ("Last 1 month", 1, False),
    ("Last 3 months", 3, False),
    ("Last 6 months", 6, False),
    ("Last 1 year", 12, True),
    ("Last 2 years", 24, True),
    ("Last 3 years", 36, True),
    ("Last 5 years", 60, True),
    ("All (2016-2026)", None, True),
]


def stats(returns: pd.Series) -> dict:
    """Cumulative return, max drawdown and CAGR for a window."""
    r = returns.dropna()
    if len(r) < 2:
        return {"total": 0.0, "dd": 0.0, "cagr": 0.0, "days": len(r)}
    equity = (1 + r).cumprod()
    years = (r.index[-1] - r.index[0]).days / 365.25
    return {
        "total": (equity.iloc[-1] - 1) * 100,
        "dd": float(((equity / equity.cummax()) - 1).min() * 100),
        "cagr": (equity.iloc[-1] ** (1 / years) - 1) * 100 if years >= 0.5 else float("nan"),
        "days": len(r),
    }


def main() -> int:
    frame = data.load()
    ret = targets.one_day_exposure_return(frame, basis="open")
    size = sizing.position_size(frame.close)
    joined = pd.DataFrame({"r": ret, "s": size}).dropna()
    end = joined.index[-1]

    print("=" * 92)
    print("PERIOD BACKTEST -- inverse-volatility sizing vs buy & hold")
    print("=" * 92)
    print(f"as of {end.date()}   entry basis: open-to-open   "
          f"rule: size = {sizing.DEFAULT_TARGET_VOL}% / vol_20d, cap {sizing.DEFAULT_CAP}x")
    print(f"fitted parameters: 0\n")

    hdr = (f"  {'window':17s} {'days':>5s} | {'ENGINE':>26s} | {'BUY & HOLD':>26s} | "
           f"{'avg':>5s}")
    print(hdr)
    print(f"  {'':17s} {'':>5s} | {'return':>8s} {'maxDD':>8s} {'ret/dd':>8s} | "
          f"{'return':>8s} {'maxDD':>8s} {'ret/dd':>8s} | {'size':>5s}")
    print("  " + "-" * 88)

    rows = []
    for label, months, meaningful in WINDOWS:
        start = end - pd.DateOffset(months=months) if months else joined.index[0]
        win = joined[joined.index >= start]
        if len(win) < 5:
            continue
        e, b = stats(win.r * win.s), stats(win.r)
        rows.append((label, meaningful, e, b, win.s.mean()))
        flag = "" if meaningful else "  <- too short to mean anything"
        print(f"  {label:17s} {e['days']:>5d} | {e['total']:>+7.2f}% {e['dd']:>+7.2f}% "
              f"{(e['total'] / abs(e['dd']) if e['dd'] else 0):>8.2f} | "
              f"{b['total']:>+7.2f}% {b['dd']:>+7.2f}% "
              f"{(b['total'] / abs(b['dd']) if b['dd'] else 0):>8.2f} | "
              f"{win.s.mean():>5.2f}x{flag}")

    # annualised view, only where the window supports it
    print("\n  ANNUALISED (windows >= 1 year only -- shorter ones are omitted, not hidden)")
    print(f"  {'window':17s} {'engine CAGR':>13s} {'b&h CAGR':>10s} {'engine DD':>11s} {'b&h DD':>9s}")
    print("  " + "-" * 66)
    for label, meaningful, e, b, _ in rows:
        if not meaningful or pd.isna(e["cagr"]):
            continue
        print(f"  {label:17s} {e['cagr']:>+12.2f}% {b['cagr']:>+9.2f}% "
              f"{e['dd']:>+10.2f}% {b['dd']:>+8.2f}%")

    # calendar years -- where the year-by-year attack failure lives
    print("\n  CALENDAR YEARS (this is the attack the engine FAILS -- see it directly)")
    print(f"  {'year':6s} {'engine':>9s} {'b&h':>9s} {'eng DD':>9s} {'b&h DD':>9s}  verdict")
    print("  " + "-" * 60)
    wins = losses = 0
    for year, grp in joined.groupby(joined.index.year):
        if len(grp) < 100:
            continue
        e, b = stats(grp.r * grp.s), stats(grp.r)
        er = e["total"] / abs(e["dd"]) if e["dd"] else 0
        br = b["total"] / abs(b["dd"]) if b["dd"] else 0
        won = er > br
        wins, losses = (wins + 1, losses) if won else (wins, losses + 1)
        print(f"  {year:<6d} {e['total']:>+8.2f}% {b['total']:>+8.2f}% "
              f"{e['dd']:>+8.2f}% {b['dd']:>+8.2f}%  {'WIN' if won else 'loss'}")
    print(f"\n  {wins}W / {losses}L on annual return-over-drawdown.")
    print("  The engine loses most individual years and still wins the full sample:")
    print("  it gives up upside in calm years to cut the drawdowns that dominate")
    print("  long-run compounding. That trade-off is the product, not a bug -- but")
    print("  it is also a genuine attack failure. Both statements are true.")

    print("\n  CURRENT STATE")
    for k, v in sizing.describe(frame.close).items():
        print(f"    {k:20s} {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
