"""The six engineered features -- and the reasons the obvious ones are absent.

WHY ONLY SIX
------------
Measured on this dataset:

    futures net matrix eigenvalues : 2.392 / 0.895 / 0.713 / 0.000
    effective dimensions           : 2.28 out of 4 participants
    FII net LEVEL   autocorr 0.986 -> effective n =   52 -> affords ~3.5 params
    FII net 5d chg  autocorr 0.847 -> effective n =  621 -> affords ~41  params

The fourth eigenvalue is 0.000 because the four participants sum to zero by
construction. You cannot engineer information into a rank-3 matrix. Thirty
features spanning 2.3 dimensions are thirty rephrasings of the same 2.3 facts,
and near-collinear features are exactly what makes coefficients flip sign out
of sample.

So: six candidates, and no model may use more than three of them at once.

REJECTED, with reasons -- do not re-add these without new evidence:
  * any Client series      -- corr(Client, FII) = -0.92. Same feature, minus sign.
  * all four participants  -- eigenvalue 0.000 is exact collinearity.
  * options net OI         -- Client is a net put SELLER (long 1.71M / short
                              1.98M), FII a net buyer. The sign means the
                              opposite of what it looks like, and contract
                              counts are not exposure.
  * interaction terms      -- each costs a parameter from a budget of ~3.5.
  * FII net level alone    -- 52 effective samples. Not tradeable evidence.

FEATURE NAMING: every function returns a Series aligned to `frame.index`,
computed only from data up to and including each date t. Combined with the
t+1-open entry enforced in targets.py, that makes the whole pipeline
publication-safe.
"""

from __future__ import annotations

import pandas as pd

PCTILE_WINDOW = 250  # ~1 trading year


def _rolling_pctile(s: pd.Series, window: int = PCTILE_WINDOW) -> pd.Series:
    """Fraction of the trailing window that today's value exceeds, in [0, 1].

    Ranks are the single highest-value transformation on this dataset: "-2,70,847"
    is uninterpretable, "2nd percentile of the last year" is actionable.
    """
    return s.rolling(window, min_periods=window).apply(
        lambda x: (x.iloc[-1] > x).mean(), raw=False
    )


def _zscore(s: pd.Series, window: int = PCTILE_WINDOW) -> pd.Series:
    m = s.rolling(window, min_periods=window).mean()
    sd = s.rolling(window, min_periods=window).std()
    return (s - m) / sd.replace(0, pd.NA)


# ----------------------------------------------------------------------------
# 1. Pro conviction -- the headline candidate
# ----------------------------------------------------------------------------


def pro_conviction(frame: pd.DataFrame) -> pd.Series:
    """Rolling z-score of Pro-desk net index futures.

    Pro is the most informative participant precisely because it is the fastest:
    autocorr 0.908 -> effective n = 363, versus FII's 0.986 -> 52. Seven times
    more independent observations. Corroborated independently: propct carried the
    strongest t-statistic (-3.48) of any feature tested. Everyone watches FII;
    the data says watch Pro.
    """
    return _zscore(frame.fut_Pro)


# ----------------------------------------------------------------------------
# 2. Pro-FII divergence -- the one genuinely orthogonal axis
# ----------------------------------------------------------------------------


def pro_fii_divergence(frame: pd.DataFrame) -> pd.Series:
    """z(Pro) - z(FII): are prop desks leaning against the foreigners?

    Client is useless as a second opinion (corr -0.92 with FII -- a mirror).
    Pro correlates only -0.50, so this spread carries information the FII series
    alone does not.
    """
    return _zscore(frame.fut_Pro) - _zscore(frame.fut_FII)


# ----------------------------------------------------------------------------
# 3. Book churn -- spends the cheapest degrees of freedom available
# ----------------------------------------------------------------------------


def book_churn(frame: pd.DataFrame, window: int = 20) -> pd.Series:
    """Mean absolute daily change in FII net, normalised by its own history.

    Built on the 1-day change series (autocorr 0.142 -> effective n = 2603, the
    richest series in the dataset). Measures how violently the book is being
    reworked rather than which way it points -- activity, not opinion.
    """
    churn = frame.fut_FII.diff().abs().rolling(window).mean()
    return _rolling_pctile(churn)


# ----------------------------------------------------------------------------
# 4. Positioning extremity -- survives the zero-sum constraint
# ----------------------------------------------------------------------------


def positioning_extremity(frame: pd.DataFrame) -> pd.Series:
    """Percentile of the FII short/long ratio.

    A ratio rather than a net. Nets are locked by the zero-sum identity; the
    short-to-long ratio is not, and it captures crowding -- which is the fuel
    behind a squeeze. On 2026-05-11 this read 7.6x short-heavy, 72nd percentile.
    """
    ratio = frame.futshort_FII / frame.futlong_FII.replace(0, pd.NA)
    return _rolling_pctile(ratio)


# ----------------------------------------------------------------------------
# 5-6. price-derived features (no OI) -- the strongest things measured
# ----------------------------------------------------------------------------


def realised_vol(frame: pd.DataFrame, window: int = 20) -> pd.Series:
    """Daily return standard deviation over the trailing window, in %.

    The single most useful variable found anywhere in this project. Volatility
    clusters (autocorr 0.990), which is why REACTING to it works even though
    FORECASTING it did not.
    """
    return (frame.close.pct_change() * 100).rolling(window).std()


def vol_acceleration(frame: pd.DataFrame, fast: int = 5, slow: int = 60) -> pd.Series:
    """Short-window vol divided by long-window vol. Regime-transition detector.

    >1 means energy is building, <1 means it is bleeding out. Nearly free in
    degrees of freedom because it is a ratio of two things already computed.
    """
    r = frame.close.pct_change() * 100
    return r.rolling(fast).std() / r.rolling(slow).std()


# ----------------------------------------------------------------------------
# registry
# ----------------------------------------------------------------------------

OI_FEATURES = {
    "pro_conviction": pro_conviction,
    "pro_fii_divergence": pro_fii_divergence,
    "book_churn": book_churn,
    "positioning_extremity": positioning_extremity,
}

PRICE_FEATURES = {
    "realised_vol": realised_vol,
    "vol_acceleration": vol_acceleration,
}

ALL_FEATURES = {**PRICE_FEATURES, **OI_FEATURES}

MAX_FEATURES_PER_MODEL = 3  # enforced by harness.evaluate_predictor


def build(frame: pd.DataFrame, names: list[str] | None = None) -> pd.DataFrame:
    """Compute the named features (default: all) as a DataFrame."""
    chosen = names or list(ALL_FEATURES)
    unknown = set(chosen) - set(ALL_FEATURES)
    if unknown:
        raise KeyError(f"unknown feature(s): {sorted(unknown)}")
    return pd.DataFrame({n: ALL_FEATURES[n](frame) for n in chosen}, index=frame.index)


# ----------------------------------------------------------------------------
# diagnostics -- the DoF budget, so it is always visible
# ----------------------------------------------------------------------------


def effective_sample_size(s: pd.Series) -> tuple[float, float, float]:
    """Return (autocorrelation, half-life in days, effective sample size).

    A series with 1-day autocorrelation 0.986 repeats itself for ~50 days, so
    2,600 rows carry ~52 independent observations. This function is why every
    model here is small.
    """
    import numpy as np

    s = s.dropna()
    ac = s.autocorr(1)
    if not (0 < ac < 1):
        return ac, 1.0, float(len(s))
    half_life = np.log(0.5) / np.log(ac)
    return ac, half_life, len(s) / max(half_life, 1.0)


def dof_report(frame: pd.DataFrame) -> pd.DataFrame:
    """Table of autocorr / half-life / effective n / affordable params."""
    rows = []
    for name, fn in ALL_FEATURES.items():
        ac, hl, n = effective_sample_size(fn(frame))
        rows.append(
            {
                "feature": name,
                "autocorr": round(ac, 3),
                "half_life_days": round(hl, 1),
                "effective_n": int(n),
                "affordable_params": round(n / 15, 1),
            }
        )
    return pd.DataFrame(rows).sort_values("effective_n", ascending=False)
