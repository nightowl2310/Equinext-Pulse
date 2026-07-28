"""Prediction targets -- and the ONLY place the lookahead guard lives.

THE GUARD
---------
NSE publishes participant OI after the close (~6pm) of date t. So a feature
computed from date t is not actionable until the OPEN of t+1.

Therefore every target in this module starts from `open.shift(-1)`. No target
may start from `close[t]`, because buying at today's close using today's OI
file is time travel, and it manufactures edge that does not exist. If you add a
target here, it starts at t+1 open or it does not go in.

There is exactly one deliberately-cheating function, `_lookahead_return`, used
only by the Phase 0 gate to prove the harness can detect the difference.
"""

from __future__ import annotations

import pandas as pd

# ----------------------------------------------------------------------------
# directional targets (the ones that did not survive -- kept for the record)
# ----------------------------------------------------------------------------


def forward_return(frame: pd.DataFrame, sessions: int = 3) -> pd.Series:
    """% move: enter at open of t+1, exit at close of t+`sessions`."""
    entry = frame.open.shift(-1)
    exit_ = frame.close.shift(-sessions)
    return (exit_ / entry - 1) * 100


def forward_return_open_to_open(frame: pd.DataFrame, sessions: int = 3) -> pd.Series:
    """% move: enter at open of t+1, exit at open of t+1+`sessions`."""
    entry = frame.open.shift(-1)
    return (frame.open.shift(-1 - sessions) / entry - 1) * 100


def forward_up(frame: pd.DataFrame, sessions: int = 3) -> pd.Series:
    """1 if the forward move was positive. Binary version of direction."""
    return (forward_return(frame, sessions) > 0).astype(float)


# ----------------------------------------------------------------------------
# magnitude / risk targets (the ones worth researching)
# ----------------------------------------------------------------------------


def _daily_returns(frame: pd.DataFrame) -> pd.Series:
    return frame.close.pct_change() * 100


def forward_vol(frame: pd.DataFrame, sessions: int = 20) -> pd.Series:
    """Realised daily volatility over t+1 .. t+sessions."""
    r = _daily_returns(frame).shift(-1)
    return r.rolling(sessions).std().shift(-(sessions - 1))


def forward_worst_dip(frame: pd.DataFrame, sessions: int = 20) -> pd.Series:
    """Deepest close-to-entry drawdown over t+1 .. t+sessions, in %."""
    entry = frame.open.shift(-1)
    trough = frame.low.shift(-1).rolling(sessions).min().shift(-(sessions - 1))
    return (trough / entry - 1) * 100


def forward_big_down_day(
    frame: pd.DataFrame, sessions: int = 20, threshold: float = 2.0
) -> pd.Series:
    """1 if ANY single day in t+1 .. t+sessions fell more than `threshold`%."""
    r = _daily_returns(frame).shift(-1)
    worst = r.rolling(sessions).min().shift(-(sessions - 1))
    return (worst < -threshold).astype(float)


def forward_abs_move(frame: pd.DataFrame, sessions: int = 3) -> pd.Series:
    """Size of the move, direction discarded. The predictable half of returns."""
    return forward_return(frame, sessions).abs()


# ----------------------------------------------------------------------------
# exposure series for backtesting sizing rules
# ----------------------------------------------------------------------------


def one_day_exposure_return(frame: pd.DataFrame, basis: str = "open") -> pd.Series:
    """Return earned by a position sized at date t and held one session.

    basis="open"  -> open[t+1] to open[t+2]. Honest: entry after publication.
    basis="close" -> close[t] to close[t+1]. Conventional daily-rebalance
                     assumption, marginally optimistic. Both are reported so the
                     choice is never hidden.
    """
    if basis == "open":
        return frame.open.shift(-2) / frame.open.shift(-1) - 1
    if basis == "close":
        return frame.close.shift(-1) / frame.close - 1
    raise ValueError("basis must be 'open' or 'close'")


# ----------------------------------------------------------------------------
# deliberately wrong -- used only to prove the harness works
# ----------------------------------------------------------------------------


def _lookahead_return(frame: pd.DataFrame, sessions: int = 3) -> pd.Series:
    """CHEATING. Enters at close[t] using data published after close[t].

    Exists so the Phase 0 gate can show the harness distinguishes a real target
    from a time-travelling one. Never use this for anything else.
    """
    return (frame.close.shift(-sessions) / frame.close - 1) * 100
