"""PRODUCTION: position sizing. The only validated component in this project.

WHAT THIS IS
------------
    size = target_volatility / recent_realised_volatility     (capped)

That is the whole model. Zero fitted parameters, no forecast, no participant OI.

WHY IT IS THE CORE AND NOT AN AFTERTHOUGHT
------------------------------------------
Long-run expectancy = SUM( position size x edge ).

Every attempt in this project to estimate EDGE failed out of sample:
    linear regression on direction  : OOS R2 -2.43%, direction 51.9%
    analog matching on direction    : dies once 2020 + 2022 are removed
    volatility forecasting          : -17.1% second half, +0.5% ex-crisis

SIZE, by contrast, needs no forecast -- only a reaction to what already happened.
Volatility clusters (1-day autocorrelation 0.990), so recent vol is a usable
description of current conditions without predicting anything.

Measured over 2016-2026, entry at t+1 open (research/experiments/phase1_baseline.py):
    buy & hold          11.76%/yr   drawdown -37.8%   ret/dd 0.31   Sharpe 0.75
    inverse-vol sizing  11.59%/yr   drawdown -21.9%   ret/dd 0.53   Sharpe 0.80

Nearly identical return for 42% less drawdown, at 1.08x average exposure -- so it
is NOT a hold-cash artifact. Permutation p = 0.002 against random size series of
the same shape, so the timing carries information, not just the exposure level.

HONEST LIMITATION -- IT SURVIVES 4 OF 5 ATTACKS, NOT 5
------------------------------------------------------
The year-by-year attack FAILS: 3 wins, 8 losses on annual return-over-drawdown
(2018, 2021, 2023 win; the rest lose).

An earlier note in this project claimed "5-for-5". That was wrong -- it conflated
the five era/crisis SLICES (full, both halves, ex-2020, ex-2020+2022, all of which
do pass) with the five ATTACKS. The harness caught the overclaim. It stands
uncorrected in the code so nobody re-inherits the mistake.

What this means in practice: the rule earns its keep on aggregate risk-adjusted
terms and in violent markets, and costs you upside in calm bull years often
enough to lose most individual years. That trade-off is real. Do not deploy this
expecting to beat buy-and-hold annually. Do not tune the threshold to make the
attack pass.

WHAT IS DELIBERATELY ABSENT
---------------------------
No direction call. No participant OI. No fitted coefficient. Any future OI
overlay may only REDUCE size (see apply_risk_overlay) and must first pass all
five attacks in research/harness.py.
"""

from __future__ import annotations

import pandas as pd

import signals

# Constants live in signals.py -- the single definition shared with the export
# path. Re-exported here so existing imports keep working.
DEFAULT_TARGET_VOL = signals.TARGET_VOL
DEFAULT_LOOKBACK = signals.VOL_LOOKBACK
DEFAULT_CAP = signals.SIZE_CAP
MIN_VOL = signals.MIN_VOL


def realised_vol(close: pd.Series, lookback: int = DEFAULT_LOOKBACK) -> pd.Series:
    """Trailing daily return standard deviation, in %."""
    return (close.pct_change() * 100).rolling(lookback).std()


def position_size(
    close: pd.Series,
    target_vol: float = DEFAULT_TARGET_VOL,
    lookback: int = DEFAULT_LOOKBACK,
    cap: float = DEFAULT_CAP,
) -> pd.Series:
    """Multiplier to apply to a full-size long, indexed by date.

    The value at date t uses only closes up to and including t, so it is
    actionable at the open of t+1. Do not remove that property.

    Vectorised twin of signals.position_size; equivalence is asserted by
    research/experiments/test_signal_parity.py so the dashboard and the backtest
    can never quietly disagree.
    """
    vol = realised_vol(close, lookback)
    return (target_vol / vol.clip(lower=MIN_VOL)).clip(upper=cap)


def apply_risk_overlay(
    size: pd.Series, risk_flag: pd.Series, trim: float = 0.5
) -> pd.Series:
    """Reduce size where `risk_flag` is truthy. Can never increase it.

    Asymmetric on purpose: a false negative costs upside, a false positive costs
    capital. Given the evidence quality on OI, only the cheap error is allowed.

    NOT WIRED UP YET. The candidate tail-risk flag failed the era-split attack
    (second half -9.60% -> -16.16%, i.e. OI made crash-risk prediction WORSE in
    the recent era). It must pass all five attacks before it feeds this.
    """
    if not 0 < trim <= 1:
        raise ValueError("trim must be in (0, 1]")
    factor = pd.Series(1.0, index=size.index)
    factor[risk_flag.reindex(size.index).fillna(0).astype(bool)] = trim
    return size * factor


def describe(close: pd.Series, **kwargs) -> dict:
    """Current sizing state, for dashboards and logs."""
    vol = realised_vol(close, kwargs.get("lookback", DEFAULT_LOOKBACK))
    size = position_size(close, **kwargs)
    trailing = vol.dropna().tail(250)
    latest_vol = float(vol.iloc[-1])
    return {
        "date": str(close.index[-1].date()),
        "close": float(close.iloc[-1]),
        "realised_vol_pct": round(latest_vol, 3),
        "vol_percentile_1y": (
            round(float((latest_vol > trailing).mean() * 100), 0)
            if len(trailing) > 50
            else None
        ),
        "size": round(float(size.iloc[-1]), 2),
        "regime": "elevated" if latest_vol > trailing.median() else "calm",
    }
