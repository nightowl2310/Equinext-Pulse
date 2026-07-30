#!/usr/bin/env python3
"""
Phase 5 -- the PEAK-REVERSAL machine, measured at every duration.

    python -m research.experiments.phase5_machine

THE RULE (user-specified, not scanned)
--------------------------------------
    IDLE   -> ACTIVE  short book reaches 90% of its trailing peak
    ACTIVE -> ARMED   book stops making new highs
    ARMED  -> FIRE    book falls back to 90% of the peak it just made
    a new high while ARMED lifts the peak and moves the fire level with it

Both thresholds are fractions of a peak, not contract counts, so the rule
survives lot-size changes and the Nov-2024 regime break. The "trailing peak" is
taken over the duration the user is looking at: 6M / 1Y / 3Y are three reference
frames for one rule, not three rules.

WHY THIS EXISTS ALONGSIDE phase3_shortbook
------------------------------------------
The percentile rule in phase 3 fires while the book is still BUILDING, which is
the wrong moment -- a rising short book means selling pressure is still
increasing. In March 2026 it entered on the 11th at NIFTY 23,675 and the index
fell a further 6.4% before turning. This machine waits for the roll-over. On the
1Y frame it fires 2026-04-09, the date the user identified by eye.

STATUS: measured, NOT validated. The five attacks have not been run on it, and
neither has the dip-buyer control that the phase-3 rule failed (see
validation-log P2). Numbers below are event studies, nothing more.
"""

from __future__ import annotations

import statistics as st
from collections import Counter

import pandas as pd

import signals
from .. import data

HOLD = signals.MACHINE_HOLD


def main() -> int:
    frame = data.load()
    dates = [d.strftime("%Y-%m-%d") for d in frame.index]
    close = [float(v) for v in frame.close]
    book = [None if pd.isna(v) else float(v) for v in frame["futshort_FII"]]
    n = len(dates)

    print(f"frame {n} rows  {dates[0]} -> {dates[-1]}")
    print(f"rule: activate at {signals.ACTIVATE_FRAC:.0%} of trailing peak, "
          f"fire at {signals.FIRE_FRAC:.0%} of the run peak, hold {HOLD} sessions\n")

    def fwd(i: int) -> float:
        j = min(i + HOLD, n - 1)
        return (close[j] / close[i] - 1) * 100

    half = dates[n // 2]

    for label, W in signals.WINDOWS.items():
        r = signals.peak_reversal_machine(dates, close, book, W)
        ev = [e for e in r["events"] if e["complete"] and e["forwardPct"] is not None]
        base = [fwd(i) for i in range(W, n - HOLD - 1)]

        print("=" * 88)
        print(f"{label} FRAME ({W}-session trailing peak)   "
              f"{len(r['events'])} fires, {len(ev)} complete   state today: {r['states'][-1]}")
        print("=" * 88)
        if not ev:
            print("  no completed events\n")
            continue

        f = [e["forwardPct"] for e in ev]
        f1 = [e["forwardPct"] for e in ev if e["date"] < half]
        f2 = [e["forwardPct"] for e in ev if e["date"] >= half]
        ex = [e["forwardPct"] for e in ev if e["date"][:4] not in ("2020", "2022")]
        g = lambda a: f"{st.median(a):+6.2f}% (n={len(a):>2})" if a else "     --      "

        print(f"  baseline  median {st.median(base):+6.2f}%   "
              f"up {sum(1 for v in base if v > 0)/len(base):.0%}")
        print(f"  all       {g(f)}  up {sum(1 for v in f if v > 0)}/{len(f)}")
        print(f"  1st half  {g(f1)}")
        print(f"  2nd half  {g(f2)}")
        print(f"  ex-crisis {g(ex)}")
        print(f"  years     {dict(sorted(Counter(e['date'][:4] for e in ev).items()))}")
        print(f"\n  {'fired':12}{'peak':>10} {'on':12}{'->':>10} {'off peak':>9}  "
              f"{'NIFTY':>10} {'+' + str(HOLD) + 'd':>10} {'move':>8}")
        for e in r["events"][-10:]:
            fp = e["forwardPct"]
            print(f"  {e['date']:12}{e['peak']:>10,} {e['peakDate']:12}"
                  f"{e['shortBook']:>10,} {e['offPeakPct']:>8.1f}%  "
                  f"{e['niftyAt']:>10,.2f} {e['niftyAfter']:>10,.2f} "
                  f"{fp:>+7.2f}%" + ("" if e["complete"] else "  (partial)"))
        print()

    print("=" * 88)
    print("NIFTY coupling (the user's question: FIIs short when the market is down)")
    print("=" * 88)
    rets = signals.daily_returns(close)
    dbook = [None] + [None if (book[i] is None or book[i-1] is None) else book[i] - book[i-1]
                      for i in range(1, n)]
    print(f"  corr(daily change in short book, NIFTY return)  "
          f"{signals._pearson(dbook, rets):+.3f}")
    print("  FII does add shorts on down days -- but weakly enough that a crowded")
    print("  book is not simply 'the market fell' restated.\n")
    print("STATUS: measured, NOT validated. No five-attack run, no dip-buyer control.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
