"""The five attacks. Nothing is a finding until it survives all of them.

WHY THIS FILE EXISTS
--------------------
Three separate results in this project looked convincing and were wrong:

  1. "FII net level predicts direction"   -- gap +1.89% first half, -0.59% second,
                                             -0.06% once 2020 was removed.
  2. "FII net level predicts crash risk"  -- 16.2% vs 9.4% full sample; REVERSED
                                             (7.2% vs 8.7%) once 2020+2022 went.
  3. "Volatility is forecastable here"    -- OOS R2 +25.6% full sample; -17.1% in
                                             the second half, +0.5% ex-2020/22.

Each had a plausible story, a decent sample, and a smooth monotonic table. Each
was one or two crisis years impersonating a decade-long law. These five attacks
are the specific tests that caught them.

THE ATTACKS
-----------
  1. WALK-FORWARD    train on past only, predict genuinely unseen data.
                     Catches memorisation. R2 must be > 0 -- negative means you
                     would do better always guessing the average.
  2. ERA SPLIT       does it hold in BOTH halves? Catches relationships that
                     reverse.
  3. CRISIS DROP     drop 2020, then drop 2020+2022. Catches single-event
                     artifacts. This attack has the highest kill rate.
  4. YEAR BY YEAR    catches lumpy results that average out to something.
  5. PERMUTATION     beat a random signal with the same exposure/shape.
                     Catches "my rule is smart" when the truth is "my rule holds
                     cash a lot".

USAGE
-----
    report = evaluate_predictor(frame, ["realised_vol"], target_series)
    print(report)
    report.verdict        # "PASS" or "FAIL"
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .features import MAX_FEATURES_PER_MODEL, build

CRISIS_YEARS = [2020, 2022]
MIN_TRAIN = 750
PERMUTATION_DRAWS = 2000
PERMUTATION_ALPHA = 0.10
MIN_YEAR_DAYS = 100


# ----------------------------------------------------------------------------
# result containers
# ----------------------------------------------------------------------------


@dataclass
class Attack:
    name: str
    metric: str
    value: float
    threshold: float
    passed: bool
    detail: str = ""

    def __str__(self) -> str:
        mark = "PASS" if self.passed else "FAIL"
        return (
            f"  [{mark}] {self.name:<16s} {self.metric} = {self.value:+8.3f} "
            f"(need {self.threshold:+.3f}){('  ' + self.detail) if self.detail else ''}"
        )


@dataclass
class Report:
    hypothesis: str
    attacks: list[Attack] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        return "PASS" if self.attacks and all(a.passed for a in self.attacks) else "FAIL"

    @property
    def survived(self) -> int:
        return sum(a.passed for a in self.attacks)

    def __str__(self) -> str:
        head = f"{self.hypothesis}\n" + "-" * min(len(self.hypothesis), 78)
        body = "\n".join(str(a) for a in self.attacks)
        note = "\n".join(f"  note: {n}" for n in self.notes)
        tail = f"  VERDICT: {self.verdict}  ({self.survived}/{len(self.attacks)} attacks survived)"
        return "\n".join(x for x in [head, body, note, tail] if x)


# ----------------------------------------------------------------------------
# metrics
# ----------------------------------------------------------------------------


def r2(actual: pd.Series, predicted: pd.Series) -> float:
    """Out-of-sample R2 in %. Negative means worse than guessing the mean."""
    a, p = np.asarray(actual, float), np.asarray(predicted, float)
    denom = ((a - a.mean()) ** 2).sum()
    if denom == 0:
        return 0.0
    return float((1 - ((a - p) ** 2).sum() / denom) * 100)


def return_over_drawdown(returns: pd.Series) -> tuple[float, float, float]:
    """(CAGR %, max drawdown %, CAGR/|drawdown|) for a decimal return series."""
    r = returns.dropna()
    if len(r) < 2:
        return 0.0, 0.0, 0.0
    equity = (1 + r).cumprod()
    years = (r.index[-1] - r.index[0]).days / 365.25
    cagr = (equity.iloc[-1] ** (1 / years) - 1) * 100 if years > 0 else 0.0
    dd = float(((equity / equity.cummax()) - 1).min() * 100)
    return cagr, dd, cagr / abs(dd) if dd else 0.0


def sharpe(returns: pd.Series) -> float:
    r = returns.dropna()
    return float(r.mean() / r.std() * np.sqrt(252)) if r.std() else 0.0


# ----------------------------------------------------------------------------
# attack 1 -- walk-forward
# ----------------------------------------------------------------------------


def walk_forward(
    X: pd.DataFrame, y: pd.Series, min_train: int = MIN_TRAIN
) -> pd.DataFrame:
    """Expanding-window OLS. Returns a frame of out-of-sample (pred, act).

    Refits from scratch at every step using only prior data, so nothing in the
    output has ever seen its own answer.
    """
    joined = X.join(y.rename("__y__"), how="inner").dropna()
    if len(joined) <= min_train + 10:
        raise ValueError(f"need > {min_train + 10} usable rows, got {len(joined)}")

    feats = list(X.columns)
    out = []
    for i in range(min_train, len(joined)):
        train = joined.iloc[:i]
        mu, sd = train[feats].mean(), train[feats].std().replace(0, 1.0)
        design = np.column_stack(
            [np.ones(len(train)), ((train[feats] - mu) / sd).to_numpy(float)]
        )
        beta, *_ = np.linalg.lstsq(design, train["__y__"].to_numpy(float), rcond=None)
        row = ((joined[feats].iloc[i] - mu) / sd).to_numpy(float)
        out.append(
            (joined.index[i], float(np.concatenate([[1.0], row]) @ beta),
             float(joined["__y__"].iloc[i]))
        )
    return pd.DataFrame(out, columns=["date", "pred", "act"]).set_index("date")


# ----------------------------------------------------------------------------
# slicing helpers shared by attacks 2-4
# ----------------------------------------------------------------------------


def _halves(idx: pd.DatetimeIndex) -> tuple[pd.Series, pd.Series]:
    mid = idx[len(idx) // 2]
    return idx < mid, idx >= mid


def _drop_years(frame: pd.DataFrame, years: list[int]) -> pd.DataFrame:
    return frame[~frame.index.year.isin(years)]


# ----------------------------------------------------------------------------
# attack 5 -- permutation
# ----------------------------------------------------------------------------


def permutation_pvalue_predictor(
    wf: pd.DataFrame, draws: int = PERMUTATION_DRAWS, seed: int = 7
) -> float:
    """P(random pairing of these predictions to these actuals scores >= observed).

    Holds the predictions fixed and shuffles the actuals, so it tests whether the
    pred-act association is real rather than whether the numbers look plausible.
    """
    rng = np.random.default_rng(seed)
    observed = r2(wf.act, wf.pred)
    acts = wf.act.to_numpy(float)
    preds = wf.pred.to_numpy(float)
    null = np.empty(draws)
    for i in range(draws):
        null[i] = r2(pd.Series(rng.permutation(acts)), pd.Series(preds))
    return float((null >= observed).mean())


def permutation_pvalue_rule(
    asset_returns: pd.Series,
    size: pd.Series,
    draws: int = 500,
    seed: int = 11,
) -> tuple[float, float]:
    """Shuffle the size series to destroy timing while preserving exposure.

    Returns (p-value on return/drawdown, median random ret/dd). This is the
    attack that revealed an earlier 'signal' was really just holding 61% cash.
    """
    rng = np.random.default_rng(seed)
    joined = pd.DataFrame({"r": asset_returns, "s": size}).dropna()
    observed = return_over_drawdown(joined.r * joined.s)[2]
    sizes = joined.s.to_numpy(float)
    null = np.empty(draws)
    for i in range(draws):
        shuffled = pd.Series(rng.permutation(sizes), index=joined.index)
        null[i] = return_over_drawdown(joined.r * shuffled)[2]
    return float((null >= observed).mean()), float(np.median(null))


# ----------------------------------------------------------------------------
# entry point 1 -- predictive models
# ----------------------------------------------------------------------------


def evaluate_predictor(
    frame: pd.DataFrame,
    features: list[str] | pd.DataFrame,
    target: pd.Series,
    hypothesis: str | None = None,
    min_train: int = MIN_TRAIN,
    enforce_feature_cap: bool = True,
) -> Report:
    """Run all five attacks on "these features predict this target".

    `features` is either a list of names from features.ALL_FEATURES, or a
    pre-built DataFrame -- the latter so that rejected/legacy series can still be
    put on trial without polluting the feature registry.
    """
    n_feats = len(features.columns) if isinstance(features, pd.DataFrame) else len(features)
    if enforce_feature_cap and n_feats > MAX_FEATURES_PER_MODEL:
        raise ValueError(
            f"{n_feats} features requested but the degrees-of-freedom budget "
            f"allows {MAX_FEATURES_PER_MODEL}. Effective n on the slow series is "
            f"~52. Pass enforce_feature_cap=False only to demonstrate a failure."
        )

    label = (
        list(features.columns) if isinstance(features, pd.DataFrame) else list(features)
    )
    name = hypothesis or f"{label} -> {target.name or 'target'}"
    rep = Report(hypothesis=name)

    X = features if isinstance(features, pd.DataFrame) else build(frame, features)
    wf = walk_forward(X, target, min_train=min_train)
    rep.notes.append(f"walk-forward produced {len(wf)} out-of-sample predictions")

    # 1. walk-forward
    full = r2(wf.act, wf.pred)
    rep.attacks.append(
        Attack("walk-forward", "OOS R2 %", full, 0.0, full > 0,
               f"corr={wf.pred.corr(wf.act):+.3f}")
    )

    # 2. era split
    first, second = _halves(wf.index)
    a, b = r2(wf.act[first], wf.pred[first]), r2(wf.act[second], wf.pred[second])
    rep.attacks.append(
        Attack("era split", "min(half) R2 %", min(a, b), 0.0, min(a, b) > 0,
               f"first={a:+.2f} second={b:+.2f}")
    )

    # 3. crisis drop
    ex20 = r2(*[s for s in (_drop_years(wf, [2020]).act, _drop_years(wf, [2020]).pred)])
    both = _drop_years(wf, CRISIS_YEARS)
    ex_both = r2(both.act, both.pred)
    worst = min(ex20, ex_both)
    rep.attacks.append(
        Attack("crisis drop", "worst R2 %", worst, 0.0, worst > 0,
               f"ex2020={ex20:+.2f} ex2020+22={ex_both:+.2f}")
    )

    # 4. year by year
    wins = losses = 0
    detail = []
    for year, grp in wf.groupby(wf.index.year):
        if len(grp) < MIN_YEAR_DAYS:
            continue
        score = r2(grp.act, grp.pred)
        wins, losses = (wins + 1, losses) if score > 0 else (wins, losses + 1)
        detail.append(f"{year}:{score:+.0f}")
    share = wins / (wins + losses) if wins + losses else 0.0
    rep.attacks.append(
        Attack("year by year", "share of yrs > 0", share, 0.5, share > 0.5,
               f"{wins}W/{losses}L  " + " ".join(detail))
    )

    # 5. permutation
    p = permutation_pvalue_predictor(wf)
    rep.attacks.append(
        Attack("permutation", "p-value", p, PERMUTATION_ALPHA, p < PERMUTATION_ALPHA,
               f"{PERMUTATION_DRAWS} shuffles")
    )

    return rep


# ----------------------------------------------------------------------------
# entry point 2 -- trading / sizing rules
# ----------------------------------------------------------------------------


def evaluate_rule(
    asset_returns: pd.Series,
    size: pd.Series,
    hypothesis: str,
    benchmark_size: float = 1.0,
) -> Report:
    """Run all five attacks on "this sizing rule beats holding the asset".

    Metric is return-over-drawdown, not accuracy: a sizing rule has no accuracy.
    """
    rep = Report(hypothesis=hypothesis)
    joined = pd.DataFrame({"r": asset_returns, "s": size}).dropna()
    strat, bench = joined.r * joined.s, joined.r * benchmark_size

    def ratio(mask=None) -> tuple[float, float]:
        s = strat if mask is None else strat[mask]
        b = bench if mask is None else bench[mask]
        return return_over_drawdown(s)[2], return_over_drawdown(b)[2]

    # 1. full sample (the "walk-forward" slot -- a parameter-free rule has no fit
    #    to leak, so the whole sample is already out of sample)
    s_full, b_full = ratio()
    c, d, _ = return_over_drawdown(strat)
    bc, bd, _ = return_over_drawdown(bench)
    rep.attacks.append(
        Attack("full sample", "ret/dd edge", s_full - b_full, 0.0, s_full > b_full,
               f"rule {c:.2f}%/yr dd {d:.1f}% ratio {s_full:.2f} | "
               f"bench {bc:.2f}%/yr dd {bd:.1f}% ratio {b_full:.2f}")
    )
    rep.notes.append(
        f"avg exposure {joined.s.mean():.2f}x, Sharpe {sharpe(strat):.2f} "
        f"vs benchmark {sharpe(bench):.2f}"
    )

    # 2. era split
    first, second = _halves(joined.index)
    (s1, b1), (s2, b2) = ratio(first), ratio(second)
    edge = min(s1 - b1, s2 - b2)
    rep.attacks.append(
        Attack("era split", "worst half edge", edge, 0.0, edge > 0,
               f"first {s1:.2f} vs {b1:.2f} | second {s2:.2f} vs {b2:.2f}")
    )

    # 3. crisis drop
    edges = []
    detail = []
    for years in ([2020], CRISIS_YEARS):
        mask = ~joined.index.year.isin(years)
        sx, bx = ratio(mask)
        edges.append(sx - bx)
        detail.append(f"ex{'+'.join(map(str, years))}: {sx:.2f} vs {bx:.2f}")
    rep.attacks.append(
        Attack("crisis drop", "worst edge", min(edges), 0.0, min(edges) > 0,
               "  ".join(detail))
    )

    # 4. year by year
    wins = losses = 0
    detail = []
    for year, grp in joined.groupby(joined.index.year):
        if len(grp) < MIN_YEAR_DAYS:
            continue
        sy = return_over_drawdown(grp.r * grp.s)[2]
        by = return_over_drawdown(grp.r * benchmark_size)[2]
        wins, losses = (wins + 1, losses) if sy > by else (wins, losses + 1)
        detail.append(f"{year}:{'W' if sy > by else 'L'}")
    share = wins / (wins + losses) if wins + losses else 0.0
    # A sizing rule is allowed to lose in calm years -- it earns its keep in the
    # violent ones -- so this attack passes on a tie rather than a majority.
    rep.attacks.append(
        Attack("year by year", "share of yrs won", share, 0.4, share >= 0.4,
               f"{wins}W/{losses}L  " + " ".join(detail))
    )

    # 5. permutation
    p, med = permutation_pvalue_rule(asset_returns, size)
    rep.attacks.append(
        Attack("permutation", "p-value", p, PERMUTATION_ALPHA, p < PERMUTATION_ALPHA,
               f"median random ret/dd {med:.2f} vs observed {s_full:.2f}")
    )

    return rep
