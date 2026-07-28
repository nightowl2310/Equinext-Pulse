"""
research/episodes.py
====================

Event studies on RARE participant states, as opposed to daily scoring.

WHY THIS EXISTS SEPARATELY FROM features.py / harness.evaluate_predictor
-----------------------------------------------------------------------
Everything else in this project asks "does today's state predict tomorrow?" and
scores every one of 2,599 days. That family is comprehensively dead: see
validation-log.md sections A1/A2 (k-NN analogs on futures state) and D1-D5
(linear regression on deltas, 30 features, zero positive in both halves).

This module asks a different question: *when a participant's book reaches an
extreme, what happens next?* It THRESHOLDS on the tail instead of scoring the
middle. That is a different hypothesis on a different sample, not a re-run of a
known rejection -- the distinction matters, or phase-3 results get read as
relitigating A1/A2.

The mechanism it is built around: near the top of its own range a position stops
being chosen and starts being forced -- margin, risk limits, carry. Forced
behaviour is more predictable than discretionary behaviour. Whether that is true
is what the harness decides; this module only measures it honestly.

THREE INVARIANTS, EACH LEARNED THE HARD WAY
-------------------------------------------
1. REGIME-NEUTRAL TRIGGERS ONLY -- rolling percentile or rolling-sigma, never a
   contract count. Lot sizes changed during the sample and FII net futures broke
   structurally after Nov 2024 (pre: mean +22k sd 95k; post: mean -161k, max
   +7,464). An absolute threshold is a units artifact.

2. CONFIDENCE IS EPISODE COUNT WITH DATES, never day count. Trigger days arrive
   in consecutive runs: 139 days of firing is 25 episodes. Quoting the day count
   overstates the evidence roughly 5x.

3. BACKWARD RETURNS SHIP BESIDE FORWARD RETURNS. The first pattern tested here
   (FII flipping from long to short, Sept 2024) looked compelling until the
   backward window showed it trailed the price move by -1.3%. A trigger that
   fires *after* the move cannot forecast the move. Only the side-by-side view
   makes that visible.

ENTRY CONVENTION: participant OI publishes after the close, so a trigger on day
t is actionable at t+1's OPEN at the earliest. Every forward return here is
measured open(t+1) -> close(t+1+h). Using close(t) would be a one-day lookahead.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np
import pandas as pd

# Two runs of the same trigger separated by fewer than this many sessions are
# one episode, not two. Matches the clustering used throughout validation-log.
EPISODE_GAP = 10

CRISIS_YEARS = [2020, 2022]


# ----------------------------------------------------------------------------
# specs and results
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class PatternSpec:
    """A pre-registered pattern. Registered BEFORE running, so the count of
    hypotheses inspected is known and the multiple-comparison discount is
    explicit rather than reconstructed afterwards."""

    name: str
    trigger: Callable[[pd.DataFrame], pd.Series]   # -> bool Series, regime-neutral
    horizon: int
    claim: Literal["long", "short"]
    rationale: str


@dataclass
class Episode:
    start: pd.Timestamp
    end: pd.Timestamp
    sessions: int
    forward: float          # % , open(t+1) -> close(t+1+h)
    backward: float         # % , close(t-10) -> close(t)


@dataclass
class Study:
    spec: PatternSpec
    episodes: list[Episode] = field(default_factory=list)
    slices: dict[str, dict] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return len(self.episodes)

    def __str__(self) -> str:
        head = (f"{self.spec.name}  (claim: {self.spec.claim}, H={self.spec.horizon})\n"
                f"  {self.n} episodes  |  median backward-10d "
                f"{np.median([e.backward for e in self.episodes]):+.2f}%")
        body = "\n".join(
            f"    {k:<14} n={v['n']:>3}  median {v['median']:+6.2f}%  "
            f"up {v['up']}/{v['n']}"
            for k, v in self.slices.items()
        )
        return head + "\n" + body


# ----------------------------------------------------------------------------
# building blocks
# ----------------------------------------------------------------------------


def rolling_percentile(s: pd.Series, window: int = 250) -> pd.Series:
    """Fraction of the trailing `window` (inclusive) that today STRICTLY exceeds.

    Identical by construction to features._rolling_pctile -- `(x[-1] > x).mean()`
    -- and to signals.rolling_percentile, so a dashboard number and a backtest
    number cannot disagree about what "98th percentile" means. Note this is NOT
    pandas' `.rank(pct=True)`, which ranks today's value as 1.0 when it is the
    window maximum instead of (window-1)/window; at a 0.98 threshold that
    one-rank difference silently moves borderline trigger days.

    Implemented as a loop rather than `.rolling().apply()` because the
    sensitivity sweep calls this a few hundred times and `apply` with
    raw=False is ~100x slower.
    """
    v = s.to_numpy(float)
    out = np.full(len(v), np.nan)
    for i in range(window - 1, len(v)):
        w = v[i - window + 1 : i + 1]
        out[i] = np.mean(v[i] > w)
    return pd.Series(out, index=s.index)


def rolling_sigma_move(s: pd.Series, lag: int, window: int = 250) -> pd.Series:
    """Change over `lag` sessions, expressed in trailing standard deviations.

    The regime-neutral way to say "a big move": +150,000 contracts means
    something different in 2017 than in 2026, but 1.5 sigma does not.
    """
    d = s.diff(lag)
    return d / d.rolling(window).std()


def find_episodes(trigger: pd.Series, gap: int = EPISODE_GAP) -> list[list[int]]:
    """Group consecutive trigger days into episodes. Returns positional indices."""
    hits = np.flatnonzero(trigger.fillna(False).to_numpy(bool))
    groups: list[list[int]] = []
    for i in hits:
        if groups and i - groups[-1][-1] <= gap:
            groups[-1].append(int(i))
        else:
            groups.append([int(i)])
    return groups


# ----------------------------------------------------------------------------
# the study
# ----------------------------------------------------------------------------


def study(frame: pd.DataFrame, spec: PatternSpec, back: int = 10) -> Study:
    """Enumerate every episode and its forward/backward return, sliced by era
    and crisis exactly as harness.evaluate_rule slices a sizing rule."""
    op, cl = frame["open"].to_numpy(float), frame["close"].to_numpy(float)
    n = len(frame)
    groups = find_episodes(spec.trigger(frame))

    eps: list[Episode] = []
    for g in groups:
        i = g[0]
        a = i + 1                                   # entry: next session's OPEN
        if a >= n:
            continue
        b = min(a + spec.horizon, n - 1)
        eps.append(Episode(
            start=frame.index[i],
            end=frame.index[b],
            sessions=len(g),
            forward=(cl[b] / op[a] - 1) * 100,
            backward=(cl[i] / cl[max(i - back, 0)] - 1) * 100,
        ))

    st = Study(spec=spec, episodes=eps)
    if not eps:
        return st

    years = np.array([e.start.year for e in eps])
    mid = frame.index[n // 2]
    starts = np.array([e.start for e in eps])
    fwd = np.array([e.forward for e in eps])

    def add(label: str, mask: np.ndarray) -> None:
        v = fwd[mask]
        if len(v):
            st.slices[label] = {"n": len(v), "median": float(np.median(v)),
                                "up": int((v > 0).sum())}

    add("all", np.ones(len(eps), bool))
    add("first half", starts < mid)
    add("second half", starts >= mid)
    add("ex-2020", years != 2020)
    add("ex-2020+22", ~np.isin(years, CRISIS_YEARS))
    return st


def baseline(frame: pd.DataFrame, horizon: int, warmup: int = 250) -> dict:
    """Unconditional forward return on the same entry convention. Without this
    a 'positive median' means nothing -- NIFTY drifts up, so most horizons are
    positive for free."""
    op, cl = frame["open"].to_numpy(float), frame["close"].to_numpy(float)
    n = len(frame)
    v = np.array([(cl[min(i + 1 + horizon, n - 1)] / op[i + 1] - 1) * 100
                  for i in range(warmup, n - horizon - 2)])
    return {"n": len(v), "median": float(np.median(v)), "up_rate": float((v > 0).mean())}


def to_size_series(frame: pd.DataFrame, spec: PatternSpec, tilt: float = 0.5) -> pd.Series:
    """Convert a rare-event pattern into a position series the harness can attack.

    1.0x between episodes and (1 +/- tilt)x for `horizon` sessions after a
    trigger, so the rule is compared against buy-and-hold and is credited only
    for the days it actually claims. Exposure starts the session AFTER the
    trigger, matching the entry convention above.
    """
    size = pd.Series(1.0, index=frame.index)
    direction = 1.0 if spec.claim == "long" else -1.0
    hits = np.flatnonzero(spec.trigger(frame).fillna(False).to_numpy(bool))
    n = len(frame)
    for i in hits:
        size.iloc[i + 1 : min(i + 1 + spec.horizon, n)] = 1.0 + direction * tilt
    return size


def episode_years(frame: pd.DataFrame, spec: PatternSpec) -> list[int]:
    """Years in which the pattern fires at least once.

    harness.evaluate_rule's year-by-year attack scores a year as a LOSS unless
    the rule strictly beats the benchmark -- but a rare-event rule is *identical*
    to the benchmark in a year it never fires, so silent years would count
    against it for reasons unrelated to skill. Callers pass this to restrict the
    attack to years the rule actually had an opinion about, and must report the
    excluded years rather than dropping them quietly.
    """
    return sorted({frame.index[g[0]].year for g in find_episodes(spec.trigger(frame))})
