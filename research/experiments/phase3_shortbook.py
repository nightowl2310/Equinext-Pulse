#!/usr/bin/env python3
"""
Phase 3 -- the five attacks on SHORT-BOOK SATURATION.

    python -m research.experiments.phase3_shortbook

HYPOTHESIS
----------
When a participant's GROSS short index-futures book reaches the 98th percentile
of its own trailing 250 sessions, the next 30 sessions are better than average.
Mechanism: near the top of its range a short book is held for reasons other than
conviction -- margin, risk limits, carry -- and unwinding it is mechanical
buying. Forced behaviour should be more predictable than chosen behaviour.

HOW THIS DIFFERS FROM THE REJECTED WORK, stated once so the log is not read as
containing a duplicate entry: A1/A2 scored EVERY day by k-NN distance in a
4-feature space that merely contained `positioning_extremity`, and D1-D5 fitted
linear models to participant deltas on all 2,599 days. This thresholds on the
tail and looks only at the ~139 days in it. Different hypothesis, different
sample, and it uses the GROSS book rather than the net -- the nets sum to zero
across participants, so FII net is Client net inverted and carries no
independent information.

TWO DEVIATIONS FROM harness.evaluate_rule, both necessary and both visible
-------------------------------------------------------------------------
1. YEAR-BY-YEAR IS RESTRICTED TO EPISODE-BEARING YEARS. A rare-event rule is
   *identical* to the benchmark in a year it never fires, and evaluate_rule
   scores a year as a loss unless the rule strictly wins. Counting silent years
   as losses tests coverage, not skill. Excluded years are printed, never
   dropped silently.

2. PERMUTATION USES A CIRCULAR BLOCK SHUFFLE. The exposure series is 1.5x for 30
   consecutive sessions at a time, so it is autocorrelated by construction; an
   iid shuffle destroys that structure and returns a meaningless p-value.
   Rotating the whole series preserves the block shape while destroying the
   alignment with price, which is the thing actually under test.

Everything else -- the metric, the era split, the crisis years, the pass
thresholds -- is imported from harness so the numbers stay comparable with
phase0/phase1.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from ..episodes import (
    PatternSpec,
    baseline,
    episode_years,
    rolling_percentile,
    study,
    to_size_series,
)
from ..harness import (
    CRISIS_YEARS,
    MIN_YEAR_DAYS,
    PERMUTATION_ALPHA,
    Attack,
    Report,
    return_over_drawdown,
    sharpe,
)

WINDOW = 250
TRIGGER = 0.98
HORIZON = 30
TILT = 0.5
DRAWS = 2000
WARMUP = 250


def short_book(frame: pd.DataFrame, actor: str) -> pd.Series:
    """GROSS short index-futures contracts. data.load() gives nets and the gross
    legs; futshort_* is the raw short leg."""
    return frame[f"futshort_{actor}"]


def spec_for(actor: str, trigger: float = TRIGGER, horizon: int = HORIZON) -> PatternSpec:
    return PatternSpec(
        name=f"{actor} short book >= {trigger:.0%}ile of 250d",
        trigger=lambda fr, a=actor, t=trigger: rolling_percentile(short_book(fr, a), WINDOW) >= t,
        horizon=horizon,
        claim="long",
        rationale=("a short book at the top of its own range is held for reasons "
                   "other than conviction; unwinding it is mechanical buying"),
    )


def evaluate(frame: pd.DataFrame, spec: PatternSpec, tilt: float = TILT) -> Report:
    """The five attacks, with the two documented deviations."""
    size = to_size_series(frame, spec, tilt)
    # open-to-open: the position set after date t earns from t+1's open onward
    ret = (frame.open.shift(-1) / frame.open - 1).fillna(0.0)
    joined = pd.DataFrame({"r": ret, "s": size}).iloc[WARMUP:].dropna()
    strat, bench = joined.r * joined.s, joined.r

    rep = Report(hypothesis=f"{spec.name} -> {tilt:+.0%} tilt for {spec.horizon} sessions")

    def ratio(mask=None):
        s = strat if mask is None else strat[mask]
        b = bench if mask is None else bench[mask]
        return return_over_drawdown(s)[2], return_over_drawdown(b)[2]

    # 1. full sample (a parameter-free rule has no fit to leak, so the whole
    #    sample is already out of sample -- same argument as evaluate_rule)
    sf, bf = ratio()
    c, dd, _ = return_over_drawdown(strat)
    bc, bdd, _ = return_over_drawdown(bench)
    rep.attacks.append(Attack(
        "full sample", "ret/dd edge", sf - bf, 0.0, sf > bf,
        f"rule {c:.2f}%/yr dd {dd:.1f}% ratio {sf:.2f} | bench {bc:.2f}%/yr dd {bdd:.1f}% ratio {bf:.2f}"))
    rep.notes.append(f"avg exposure {joined.s.mean():.2f}x, "
                     f"{(joined.s != 1.0).mean():.1%} of days tilted, "
                     f"Sharpe {sharpe(strat):.2f} vs {sharpe(bench):.2f}")

    # 2. era split
    mid = len(joined) // 2
    first = joined.index < joined.index[mid]
    (s1, b1), (s2, b2) = ratio(first), ratio(~first)
    edge = min(s1 - b1, s2 - b2)
    rep.attacks.append(Attack("era split", "worst half edge", edge, 0.0, edge > 0,
                              f"first {s1:.2f} vs {b1:.2f} | second {s2:.2f} vs {b2:.2f}"))

    # 3. crisis drop
    edges, detail = [], []
    for years in ([2020], CRISIS_YEARS):
        m = ~joined.index.year.isin(years)
        sx, bx = ratio(m)
        edges.append(sx - bx)
        detail.append(f"ex{'+'.join(map(str, years))}: {sx:.2f} vs {bx:.2f}")
    rep.attacks.append(Attack("crisis drop", "worst edge", min(edges), 0.0,
                              min(edges) > 0, "  ".join(detail)))

    # 4. year by year -- EPISODE-BEARING YEARS ONLY (deviation 1)
    fired = set(episode_years(frame, spec))
    wins = losses = 0
    detail, skipped = [], []
    for year, grp in joined.groupby(joined.index.year):
        if len(grp) < MIN_YEAR_DAYS:
            continue
        if year not in fired:
            skipped.append(str(year))
            continue
        sy = return_over_drawdown(grp.r * grp.s)[2]
        by = return_over_drawdown(grp.r)[2]
        wins, losses = (wins + 1, losses) if sy > by else (wins, losses + 1)
        detail.append(f"{year}:{'W' if sy > by else 'L'}")
    share = wins / (wins + losses) if wins + losses else 0.0
    rep.attacks.append(Attack(
        "year by year", "share of yrs won", share, 0.4, share >= 0.4,
        f"{wins}W/{losses}L  {' '.join(detail)}   "
        f"[silent years excluded: {','.join(skipped) or 'none'}]"))

    # 5. block permutation -- circular rotation (deviation 2)
    rng = np.random.default_rng(11)
    sz, rr = joined.s.to_numpy(float), joined.r.to_numpy(float)
    m = len(sz)
    null = np.empty(DRAWS)
    for i in range(DRAWS):
        k = int(rng.integers(m))
        # index must be carried: return_over_drawdown annualises off the
        # DatetimeIndex, and a bare RangeIndex silently produces nonsense
        null[i] = return_over_drawdown(
            pd.Series(rr * np.roll(sz, k), index=joined.index)
        )[2]
    p = float((null >= sf).mean())
    rep.attacks.append(Attack("blk permutation", "p-value", p, PERMUTATION_ALPHA,
                              p < PERMUTATION_ALPHA,
                              f"median random ret/dd {np.median(null):.2f} vs observed {sf:.2f}"))
    return rep


def main() -> int:
    frame = data.load()
    print(f"frame {len(frame)} rows  {frame.index[0].date()} -> {frame.index[-1].date()}\n")

    base = baseline(frame, HORIZON)
    print(f"unconditional forward-{HORIZON}d: median {base['median']:+.2f}%, "
          f"up {base['up_rate']:.1%}  (n={base['n']})\n")

    print("=" * 78)
    print("A. Is it FII specifically, or does any crowded short book do this?")
    print("=" * 78)
    for actor in ("FII", "Client", "Pro", "DII"):
        print(study(frame, spec_for(actor)))
        print()

    print("=" * 78)
    print(f"B. Five attacks -- FII, {TRIGGER:.0%}ile, H={HORIZON}")
    print("=" * 78)
    rep = evaluate(frame, spec_for("FII"))
    print(rep)

    print("\n" + "=" * 78)
    print("C. Sensitivity -- is the pass a single lucky cell?")
    print("   H=20 FAILS 3 of 5. The horizon was SELECTED, not predicted; the")
    print("   defence is that the whole H=30 row holds, not that H=30 was obvious.")
    print("=" * 78)
    print(f"{'threshold':>10} {'H':>4} {'survived':>9}  {'edge':>7}  attacks failed")
    for trig in (0.96, 0.97, 0.98, 0.99):
        for h in (20, 30, 40):
            r = evaluate(frame, spec_for("FII", trig, h))
            failed = ",".join(a.name for a in r.attacks if not a.passed) or "-"
            print(f"{trig:>10.2f} {h:>4} {r.survived:>7}/5  "
                  f"{r.attacks[0].value:>+7.3f}  {failed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
