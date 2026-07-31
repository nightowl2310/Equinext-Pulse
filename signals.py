#!/usr/bin/env python3
"""
signals.py
==========

THE single definition of every derived signal number in this project.

Five scripts write seven JSON files into frontend/public/data/. Before this
module existed there was no shared place to compute "percentile" or "size", so
the next person to add a signal field would have computed it slightly
differently somewhere else. Everything imports from here instead.

    signals.py   <- pure-Python core. THE definition. No dependencies.
      |
      +-- sizing.py                    (pandas wrappers, research/backtests)
      +-- plot_fii_vs_nifty.py         (participants_vs_nifty.json)
      +-- export_tuesday_summary.py    (validation caveat)

Deliberately dependency-free: the daily OI job runs on stdlib only (see
requirements.txt), and adding pandas to that path would be a regression.

WHAT THE NUMBERS MEAN
---------------------
percentile  fraction of the trailing 250 sessions today's value exceeds, 0-100.
            "-2,70,847" is uninterpretable; "2nd percentile" is actionable. This
            is the highest-value transformation available on this dataset.

vol         trailing 20-session standard deviation of daily % returns.

size        target_vol / vol, capped. The validated production output. See
            docs/validation-log.md -- it survives 4 of 5 harness attacks
            (year-by-year fails, 3W/8L, recorded and not tuned away).

REGIME LABELS ARE DESCRIPTIVE, NOT PREDICTIVE. "elevated" means volatility has
recently been high, not that anything is about to happen. Participant OI was
measured to be a COINCIDENT indicator of stress, not a leading one.
"""

from __future__ import annotations

import math

# --- sizing constants: risk-appetite choices, NOT fitted parameters -----------
# ret/dd holds at 0.49-0.53 across target_vol 0.6-1.2, so the result is the
# mechanism rather than a tuned number.
TARGET_VOL = 0.8      # %/day we are willing to run (~12.7%/yr)
VOL_LOOKBACK = 20     # sessions
SIZE_CAP = 2.0        # never lever beyond this
MIN_VOL = 0.15        # floor, so a freakishly calm patch cannot demand absurd size
PCTILE_WINDOW = 250   # ~1 trading year

Num = float | int | None


# ----------------------------------------------------------------------------
# core maths -- pure Python, matches pandas .std(ddof=1) and the research code
# ----------------------------------------------------------------------------


def daily_returns(close: list[Num]) -> list[Num]:
    """Percent change, first element None."""
    out: list[Num] = [None]
    for i in range(1, len(close)):
        a, b = close[i], close[i - 1]
        out.append(None if a is None or b is None or b == 0 else (a / b - 1) * 100)
    return out


def _sample_std(vals: list[float]) -> float | None:
    n = len(vals)
    if n < 2:
        return None
    mean = sum(vals) / n
    return math.sqrt(sum((v - mean) ** 2 for v in vals) / (n - 1))


def realised_vol(close: list[Num], lookback: int = VOL_LOOKBACK) -> list[Num]:
    """Trailing daily-return standard deviation, in %. None until warm."""
    rets = daily_returns(close)
    out: list[Num] = []
    for i in range(len(rets)):
        window = rets[max(0, i - lookback + 1) : i + 1]
        clean = [r for r in window if r is not None]
        out.append(_sample_std(clean) if len(clean) == lookback else None)
    return out


def rolling_percentile(
    values: list[Num], window: int = PCTILE_WINDOW
) -> list[Num]:
    """Percent of the trailing `window` (inclusive of today) that today exceeds.

    Matches research.features._rolling_pctile exactly, so a dashboard number and
    a backtest number can never disagree.
    """
    out: list[Num] = []
    for i in range(len(values)):
        today = values[i]
        if today is None or i + 1 < window:
            out.append(None)
            continue
        hist = [v for v in values[i - window + 1 : i + 1] if v is not None]
        if len(hist) < window:
            out.append(None)
            continue
        out.append(round(sum(1 for v in hist if today > v) / len(hist) * 100, 1))
    return out


def position_size(
    vol: list[Num],
    target_vol: float = TARGET_VOL,
    cap: float = SIZE_CAP,
    min_vol: float = MIN_VOL,
) -> list[Num]:
    """target_vol / vol, floored and capped. None where vol is unknown."""
    out: list[Num] = []
    for v in vol:
        if v is None:
            out.append(None)
        else:
            out.append(round(min(target_vol / max(v, min_vol), cap), 3))
    return out


def regime_label(vol_pctile: Num) -> str:
    """Descriptive volatility bucket. Says what IS, never what is coming."""
    if vol_pctile is None:
        return "unknown"
    if vol_pctile >= 80:
        return "stressed"
    if vol_pctile >= 55:
        return "elevated"
    if vol_pctile >= 25:
        return "normal"
    return "calm"


def positioning_label(pctile: Num) -> str:
    """Plain-English gloss for a positioning percentile. Descriptive only."""
    if pctile is None:
        return "insufficient history"
    if pctile <= 2:
        return "most bearish in ~2 years"
    if pctile <= 10:
        return "extremely short vs own history"
    if pctile <= 30:
        return "leaning short"
    if pctile >= 98:
        return "most bullish in ~2 years"
    if pctile >= 90:
        return "extremely long vs own history"
    if pctile >= 70:
        return "leaning long"
    return "mid-range"


# ----------------------------------------------------------------------------
# export payloads
# ----------------------------------------------------------------------------

# Bumped whenever the shape below changes, so the frontend can detect drift
# instead of silently rendering a missing field as blank.
SIGNAL_SCHEMA_VERSION = 2   # v2 adds the `saturation` block

VALIDATION = {
    "machine": {
        "status": "measuring",
        "note": (
            "Peak-reversal state machine: ACTIVE once the FII short book reaches "
            "90% of its trailing peak, ARMED when it stops making new highs, FIRE "
            "when it falls back to 90% of that peak. Entry on the reversal rather "
            "than on the extreme, because a still-rising short book means selling "
            "pressure is still building. Backtest numbers are reported per "
            "duration on the card; see docs/validation-log.md before acting on it."
        ),
    },
    "saturation": {
        "status": "NOT VALIDATED",
        "attacksSurvived": "5/5 vs buy & hold, 4/5 vs dip control",
        "failed": ["block permutation vs a matched dip-buyer (p=0.139)"],
        "note": (
            "FII gross short index-futures book at the 98th percentile of its "
            "trailing 250 sessions, held 30 sessions; 25 episodes across 9 of 11 "
            "years. It survives all five attacks against BUY & HOLD (15.83%/yr vs "
            "12.08%, ret/dd 0.42 vs 0.32, permutation p=0.099) -- but that is the "
            "wrong benchmark. A crowded short book tends to occur after NIFTY has "
            "fallen, and dips mean-revert, so the real question is whether it "
            "beats buying the SAME DIP without looking at OI. Tested in "
            "phase4_control: against an episode-count-matched dip-buyer it scores "
            "4/5 at the 1Y and 3Y windows and 2/5 at 6M, failing block "
            "permutation both times (p=0.139, p=0.136) -- its edge over a "
            "dip-buyer is not distinguishable from randomly-timed exposure. "
            "Adding the OI filter to a dip-buyer scores 1/5 at 3Y. The 5/5 is "
            "also start-date sensitive: evaluating from 2019 instead of 2017 "
            "gives 4/5. Honest description: a dip-buying rule with an "
            "OI-flavoured trigger, whose OI component has not been shown to "
            "contribute. Do not trade from it. See docs/validation-log.md P2."
        ),
    },
    "size": {
        "status": "validated",
        "attacksSurvived": "4/5",
        "failed": ["year-by-year (3W/8L)"],
        "note": (
            "Parameter-free inverse-volatility sizing. Nearly identical return to "
            "buy & hold for 42% less drawdown (ret/dd 0.53 vs 0.31), permutation "
            "p=0.002 at 1.08x average exposure. Loses most individual years: it "
            "shrinks in calm bull markets. See docs/validation-log.md."
        ),
    },
    "percentile": {
        "status": "descriptive",
        "note": "A factual rank against trailing history. Makes no forecast.",
    },
    "regime": {
        "status": "descriptive",
        "note": (
            "Volatility bucket describing recent conditions. Participant OI was "
            "measured to be COINCIDENT with stress, not leading it."
        ),
    },
    "bias": {
        "status": "NOT VALIDATED",
        "attacksSurvived": "2/5",
        "note": (
            "Directional bias read off FII delta. Tested as hypothesis H4: "
            "walk-forward OOS R2 -0.27%, era split -1.53%, crisis drop -1.35%. "
            "FII delta has no measurable directional edge out of sample. Display "
            "with a caveat; do not trade from it. See docs/validation-log.md."
        ),
    },
    "cycles": {
        "status": "descriptive",
        "note": (
            "Peak/trough turns in each participant's net long-futures book, "
            "confirmed by a zigzag rule (>=20% retracement of the leg's own "
            "range, held >=3 sessions), with an OI-change-weighted average "
            "NIFTY close across each leg. A derived positioning summary, not "
            "a backtested trading signal -- no forward-return claim is made."
        ),
    },
}


def build_signal_block(
    close: list[Num],
    participant_nets: dict[str, list[Num]] | None = None,
) -> dict:
    """Per-date signal arrays aligned to the caller's date axis, plus `latest`.

    participant_nets: {"FII": [...], "Pro": [...]} of net index-futures values.
    Only FII and Pro are ranked -- Client correlates -0.92 with FII (a mirror,
    not a second opinion) and DII barely moves.
    """
    vol = realised_vol(close)
    vol_pctile = rolling_percentile(vol)
    size = position_size(vol)

    block: dict = {
        "schemaVersion": SIGNAL_SCHEMA_VERSION,
        "targetVol": TARGET_VOL,
        "volLookback": VOL_LOOKBACK,
        "sizeCap": SIZE_CAP,
        "percentileWindow": PCTILE_WINDOW,
        "vol": [None if v is None else round(v, 3) for v in vol],
        "volPercentile": vol_pctile,
        "size": size,
        "regime": [regime_label(p) for p in vol_pctile],
        "positioningPercentile": {},
        "validation": VALIDATION,
    }

    for actor, nets in (participant_nets or {}).items():
        if actor in ("FII", "Pro"):
            block["positioningPercentile"][actor] = rolling_percentile(nets)

    block["latest"] = _latest(close, vol, vol_pctile, size, block["positioningPercentile"])
    return block


def _latest(close, vol, vol_pctile, size, pos_pctiles) -> dict:
    i = len(close) - 1
    return {
        "close": None if close[i] is None else round(float(close[i]), 2),
        "vol": None if vol[i] is None else round(vol[i], 3),
        "volPercentile": vol_pctile[i],
        "size": size[i],
        "regime": regime_label(vol_pctile[i]),
        "positioning": {
            actor: {
                "percentile": series[i],
                "label": positioning_label(series[i]),
            }
            for actor, series in pos_pctiles.items()
        },
    }


# ----------------------------------------------------------------------------
# short-book saturation -- the one rule that survives all five attacks
# ----------------------------------------------------------------------------
#
# A participant's GROSS short book (not the net) is ranked against its own
# trailing year. Near the top of that range, positions stop being chosen and
# start being forced: margin, risk limits, and the sheer cost of carrying the
# book. Unwinding a crowded short is mechanical buying, and mechanical
# behaviour is more predictable than discretionary behaviour.
#
# Why GROSS and not NET: the four participants' nets sum to zero by
# construction, so FII net is Client net with a minus sign (corr -0.92) and
# carries no independent information. The gross books are not constrained that
# way. It also survives the Nov-2024 structural break in FII net futures --
# net has not printed positive since, but the gross short book still ranges.
#
# The threshold is a PERCENTILE, never a contract count. Lot sizes changed
# during the sample; an absolute threshold is a units artifact that would
# either never fire again or fire constantly.

SATURATION_WINDOW = 250        # ~1 trading year, matches PCTILE_WINDOW
SATURATION_TRIGGER = 98.0      # percentile at which the rule fires
SATURATION_ARMED = 90.0        # percentile at which it is worth watching
SATURATION_HORIZON = 30        # sessions the historical edge was measured over
SATURATION_ACTOR = "FII"       # the only book the rule was validated on
EPISODE_GAP = 10               # sessions of separation that make two runs distinct


def _pctile_of(window: list[float], q: float) -> float:
    """Value at the q-th percentile of `window`, nearest-rank.

    This is the inverse of `rolling_percentile`: that maps a value to its rank,
    this maps a rank back to a value. Needed so the UI can show HOW FAR the
    book is from firing in contracts, not just that it hasn't.
    """
    ordered = sorted(window)
    k = min(len(ordered) - 1, max(0, int(round(q / 100 * (len(ordered) - 1)))))
    return float(ordered[k])


def saturation_state(pctile: Num) -> str:
    """QUIET / ARMED / FIRING. Three states, because two would hide the approach."""
    if pctile is None:
        return "unknown"
    if pctile >= SATURATION_TRIGGER:
        return "firing"
    if pctile >= SATURATION_ARMED:
        return "armed"
    return "quiet"


def saturation_episodes(
    dates: list[str],
    close: list[Num],
    short_book: list[Num],
    window: int = SATURATION_WINDOW,
    trigger: float = SATURATION_TRIGGER,
    horizon: int = SATURATION_HORIZON,
    gap: int = EPISODE_GAP,
) -> list[dict]:
    """Every historical firing, grouped into EPISODES with its forward outcome.

    Confidence in this project is episode count with dates, never day count:
    trigger days arrive in consecutive runs, so 139 days is really 25 episodes
    and quoting the day count overstates the evidence ~5x.

    The forward return is measured from the trigger day's close, which is the
    last price you could act on -- the OI figures publish after the close.
    """
    pctiles = rolling_percentile(short_book, window)
    fired = [i for i, p in enumerate(pctiles) if p is not None and p >= trigger]

    groups: list[list[int]] = []
    for i in fired:
        if groups and i - groups[-1][-1] <= gap:
            groups[-1].append(i)
        else:
            groups.append([i])

    out: list[dict] = []
    for g in groups:
        i = g[0]
        j = min(i + horizon, len(close) - 1)
        a, b = close[i], close[j]
        out.append({
            "date": dates[i],
            "peakPercentile": max(pctiles[k] for k in g),
            "sessions": len(g),
            "niftyAt": None if a is None else round(float(a), 2),
            "niftyAfter": None if b is None else round(float(b), 2),
            "forwardPct": None if (a is None or b is None or a == 0)
                          else round((b / a - 1) * 100, 2),
            "complete": (i + horizon) < len(close),
        })
    return out


def build_saturation_block(
    dates: list[str],
    close: list[Num],
    short_books: dict[str, list[Num]],
    actor: str = SATURATION_ACTOR,
) -> dict | None:
    """Live state of the short-book saturation rule, plus every past episode.

    `short_books` is {"FII": [...], ...} of GROSS short index-futures contracts.
    Returns None when the actor is absent or history is too short to rank.
    """
    book = short_books.get(actor)
    if not book or len(book) < SATURATION_WINDOW:
        return None

    pctiles = rolling_percentile(book, SATURATION_WINDOW)
    i = len(book) - 1
    today, pct = book[i], pctiles[i]
    if today is None or pct is None:
        return None

    hist = [v for v in book[i - SATURATION_WINDOW + 1 : i + 1] if v is not None]
    trigger_level = _pctile_of(hist, SATURATION_TRIGGER)
    gap = trigger_level - today

    episodes = saturation_episodes(dates, close, book)
    done = [e for e in episodes if e["complete"] and e["forwardPct"] is not None]
    ups = sum(1 for e in done if e["forwardPct"] > 0)

    return {
        "schemaVersion": SIGNAL_SCHEMA_VERSION,
        "actor": actor,
        "window": SATURATION_WINDOW,
        "horizon": SATURATION_HORIZON,
        "triggerPercentile": SATURATION_TRIGGER,
        "armedPercentile": SATURATION_ARMED,
        "latest": {
            "date": dates[i],
            "shortBook": int(today),
            "percentile": pct,
            "state": saturation_state(pct),
            "triggerLevel": int(round(trigger_level)),
            "gapContracts": int(round(gap)),
            "gapPercent": round(gap / today * 100, 1) if today else None,
            "rangeLow": int(min(hist)),
            "rangeHigh": int(max(hist)),
        },
        "episodes": episodes,
        "episodeCount": len(episodes),
        "episodesUp": ups,
        "episodesComplete": len(done),
        "validation": VALIDATION["saturation"],
    }


# --- position cycles: OI-weighted avg price across each peak<->trough leg ----
CYCLE_MIN_RETRACEMENT_PCT = 30.0   # a reversal must retrace this % of the leg's own range
CYCLE_MIN_HOLD_SESSIONS = 10       # ...and hold for this many sessions to confirm
CYCLE_ACTORS = ["Client", "DII", "FII", "Pro"]


def detect_turns(
    dates: list[str],
    values: list[Num],
    min_retracement_pct: float = CYCLE_MIN_RETRACEMENT_PCT,
    min_hold_sessions: int = CYCLE_MIN_HOLD_SESSIONS,
) -> list[dict]:
    """Zigzag turning points in `values` (a participant's futuresLong series).

    A pending extreme is confirmed as a peak/trough only once price retraces
    at least `min_retracement_pct` of the CURRENT leg's own range (the leg
    from the last confirmed turn to the pending extreme) AND the reversal
    persists for `min_hold_sessions` consecutive sessions -- no session in
    that confirmation window retraces back past the bar that triggered the
    retracement check. Both conditions guard against single-day whipsaws
    that a threshold-only or duration-only rule would each miss.

    The leg before the first confirmed turn and after the last confirmed turn
    are never reported by `cycle_legs` -- a legitimate leg needs both
    endpoints confirmed, so a still-pending swing at either end of the series
    is deliberately left out.
    """
    idxs = [i for i, v in enumerate(values) if v is not None]
    if len(idxs) < 2:
        return []

    turns: list[dict] = []
    anchor_i = idxs[0]
    anchor_v = values[anchor_i]
    extreme_i = anchor_i
    extreme_v = anchor_v
    direction: str | None = None

    def _record(i: int, kind: str) -> None:
        turns.append({"date": dates[i], "type": kind, "value": values[i], "index": i})

    pos = 1
    while pos < len(idxs):
        i = idxs[pos]
        v = values[i]

        if direction is None:
            if v > extreme_v:
                extreme_v, extreme_i, direction = v, i, "up"
            elif v < extreme_v:
                extreme_v, extreme_i, direction = v, i, "down"
            pos += 1
            continue

        if direction == "up":
            if v >= extreme_v:
                extreme_v, extreme_i = v, i
                pos += 1
                continue
            leg_range = extreme_v - anchor_v
            retrace = 0.0 if leg_range <= 0 else (extreme_v - v) / leg_range * 100
            if retrace >= min_retracement_pct:
                window = idxs[pos : pos + min_hold_sessions]
                holds = len(window) >= min_hold_sessions and all(
                    values[k] <= v for k in window
                )
                if holds:
                    _record(extreme_i, "peak")
                    anchor_i, anchor_v = extreme_i, extreme_v
                    extreme_v, extreme_i, direction = v, i, "down"
            pos += 1
            continue

        # direction == "down"
        if v <= extreme_v:
            extreme_v, extreme_i = v, i
            pos += 1
            continue
        leg_range = anchor_v - extreme_v
        retrace = 0.0 if leg_range <= 0 else (v - extreme_v) / leg_range * 100
        if retrace >= min_retracement_pct:
            window = idxs[pos : pos + min_hold_sessions]
            holds = len(window) >= min_hold_sessions and all(
                values[k] >= v for k in window
            )
            if holds:
                _record(extreme_i, "trough")
                anchor_i, anchor_v = extreme_i, extreme_v
                extreme_v, extreme_i, direction = v, i, "up"
        pos += 1

    return turns


def cycle_legs(
    turns: list[dict], dates: list[str], close: list[Num], values: list[Num]
) -> list[dict]:
    """One record per leg between consecutive turns, with the OI-weighted avg
    NIFTY close across that leg:

        avgPrice = sum(close[t] * |values[t] - values[t-1]|) / sum(|values[t] - values[t-1]|)

    for t in (legStart, legEnd] -- i.e. weighted by how much the position
    actually moved each day, not by session count. `type` is "accumulation"
    for a trough->peak leg (long being built) and "distribution" for a
    peak->trough leg (long being sold down). A completed accumulation
    immediately followed by a distribution also gets `spread` on the
    distribution leg = its avgPrice minus the accumulation leg's avgPrice.
    """
    legs: list[dict] = []
    for a, b in zip(turns, turns[1:]):
        start_i, end_i = a["index"], b["index"]
        weighted_sum = 0.0
        weight_sum = 0.0
        for t in range(start_i + 1, end_i + 1):
            prev, cur = values[t - 1], values[t]
            px = close[t]
            if prev is None or cur is None or px is None:
                continue
            w = abs(cur - prev)
            weighted_sum += float(px) * w
            weight_sum += w
        avg_price = round(weighted_sum / weight_sum, 2) if weight_sum > 0 else None
        leg_type = "accumulation" if a["type"] == "trough" else "distribution"
        legs.append({
            "type": leg_type,
            "startDate": a["date"],
            "endDate": b["date"],
            "avgPrice": avg_price,
            "oiStart": int(a["value"]),
            "oiEnd": int(b["value"]),
            "niftyStart": None if close[start_i] is None else round(float(close[start_i]), 2),
            "niftyEnd": None if close[end_i] is None else round(float(close[end_i]), 2),
            "durationSessions": end_i - start_i,
        })

    for leg, nxt in zip(legs, legs[1:]):
        if leg["type"] == "accumulation" and nxt["type"] == "distribution" \
                and leg["avgPrice"] is not None and nxt["avgPrice"] is not None:
            nxt["spread"] = round(nxt["avgPrice"] - leg["avgPrice"], 2)

    return legs


def build_cycles_block(
    dates: list[str],
    close: list[Num],
    long_books: dict[str, list[Num]],
    actors: list[str] = CYCLE_ACTORS,
) -> dict | None:
    """Confirmed peak/trough turns and per-leg avg price, for every actor with
    enough history to find at least one full leg. `long_books` is
    {"FII": [...], ...} of GROSS long index-futures contracts (futuresLong).
    Returns None when no actor has any legs yet.
    """
    result: dict[str, list[dict]] = {}
    for actor in actors:
        book = long_books.get(actor)
        if not book:
            continue
        turns = detect_turns(dates, book)
        legs = cycle_legs(turns, dates, close, book)
        if legs:
            result[actor] = legs

    if not result:
        return None

    return {
        "schemaVersion": SIGNAL_SCHEMA_VERSION,
        "minRetracementPct": CYCLE_MIN_RETRACEMENT_PCT,
        "minHoldSessions": CYCLE_MIN_HOLD_SESSIONS,
        "legs": result,
        "validation": VALIDATION["cycles"],
    }


# ----------------------------------------------------------------------------
# short-book PEAK-REVERSAL machine  (the tradable form of the saturation idea)
# ----------------------------------------------------------------------------
#
# The percentile version above fires while the short book is still BUILDING,
# which is the wrong moment: a rising short book means selling pressure is still
# increasing. In Mar 2026 it entered on the 11th at NIFTY 23,675 and the index
# fell a further 6.4% before turning.
#
# This machine waits for the roll-over instead. Four states:
#
#   IDLE      book is nowhere near its peak; nothing to watch
#   ACTIVE    book has climbed to >= ACTIVATE_FRAC of its trailing peak and is
#             still making new highs -- shorts are still being added
#   ARMED     book has stopped making new highs; the build may be topping
#   FIRED     book has fallen back to <= FIRE_FRAC of the peak it just made.
#             The crowded position is being covered. Go long futures.
#
# Both thresholds are FRACTIONS OF A PEAK, not percentile ranks, so they survive
# the two things that break absolute levels: lot-size changes and the Nov-2024
# regime break. A new high while ARMED lifts the peak and moves the fire level
# with it -- the reference is not fixed, which is the whole point.
#
# WINDOW is the duration the user is looking at: the "past peak" for a 1Y view is
# the 1Y high, for a 3Y view the 3Y high. Same rule, different reference frame.

ACTIVATE_FRAC = 0.90    # of the trailing peak -> start watching
FIRE_FRAC = 0.90        # of the run peak      -> the reversal is confirmed
MACHINE_HOLD = 30       # sessions the long is held after a fire
WINDOWS = {"1M": 21, "3M": 63, "6M": 126, "1Y": 250, "3Y": 750, "ALL": 10**9}


def _trailing_peak(vals: list[Num], i: int, window: int) -> float | None:
    lo = max(0, i - window + 1)
    hist = [v for v in vals[lo:i + 1] if v is not None]
    return max(hist) if hist else None


def peak_reversal_machine(
    dates: list[str],
    close: list[Num],
    short_book: list[Num],
    window: int,
    activate: float = ACTIVATE_FRAC,
    fire: float = FIRE_FRAC,
    hold: int = MACHINE_HOLD,
) -> dict:
    """Run the four-state machine over the whole history.

    Returns per-day states plus every FIRE event with its forward outcome. Only
    information available on the day is used -- `run_peak` is the running maximum
    so far, never the eventual maximum, because you cannot know a top is a top
    until the book stops rising.
    """
    n = len(short_book)
    states: list[str] = []
    events: list[dict] = []
    state = "idle"
    run_peak = 0.0
    peak_date = None
    cooldown = 0

    for i in range(n):
        b = short_book[i]
        ref = _trailing_peak(short_book, i, window)
        if b is None or ref is None or ref <= 0:
            states.append("idle")
            continue

        if state == "fired":
            cooldown -= 1
            # stay out until the book has clearly left the zone, so one long
            # unwind is one signal rather than a burst of them
            if cooldown <= 0 and b < activate * ref:
                state = "idle"
            states.append(state)
            continue

        if state == "idle":
            if b >= activate * ref:
                state, run_peak, peak_date = "active", b, dates[i]

        elif state == "active":
            if b >= run_peak:
                run_peak, peak_date = b, dates[i]      # still building
            else:
                state = "armed"                        # first lower print

        elif state == "armed":
            if b >= run_peak:
                run_peak, peak_date = b, dates[i]      # new high: peak moves up
                state = "active"
            elif b <= fire * run_peak:
                j = min(i + hold, n - 1)
                a, z = close[i], close[j]
                events.append({
                    "date": dates[i],
                    "peakDate": peak_date,
                    "peak": int(run_peak),
                    "fireLevel": int(round(fire * run_peak)),
                    "shortBook": int(b),
                    "offPeakPct": round((b / run_peak - 1) * 100, 1),
                    "niftyAt": None if a is None else round(float(a), 2),
                    "niftyAfter": None if z is None else round(float(z), 2),
                    "forwardPct": None if (a is None or z is None or a == 0)
                                  else round((z / a - 1) * 100, 2),
                    "complete": (i + hold) < n,
                })
                state, cooldown = "fired", hold

        states.append(state)

    return {"states": states, "events": events}


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    pairs = [(a, b) for a, b in zip(xs, ys) if a is not None and b is not None]
    if len(pairs) < 3:
        return None
    n = len(pairs)
    mx = sum(a for a, _ in pairs) / n
    my = sum(b for _, b in pairs) / n
    num = sum((a - mx) * (b - my) for a, b in pairs)
    den = (sum((a - mx) ** 2 for a, _ in pairs) * sum((b - my) ** 2 for _, b in pairs)) ** 0.5
    return round(num / den, 3) if den else None


def build_machine_block(
    dates: list[str],
    close: list[Num],
    short_books: dict[str, list[Num]],
    actor: str = SATURATION_ACTOR,
) -> dict | None:
    """Live state of the peak-reversal machine at every duration, plus the
    NIFTY coupling the user asked to see alongside it."""
    book = short_books.get(actor)
    if not book or len(book) < min(WINDOWS.values()):
        return None

    # how the short book moves against NIFTY, day to day and in levels
    rets = daily_returns(close)
    dbook: list[Num] = [None] + [
        None if (book[i] is None or book[i - 1] is None) else book[i] - book[i - 1]
        for i in range(1, len(book))
    ]

    out: dict = {
        "schemaVersion": SIGNAL_SCHEMA_VERSION,
        "actor": actor,
        "activateFraction": ACTIVATE_FRAC,
        "fireFraction": FIRE_FRAC,
        "hold": MACHINE_HOLD,
        "correlation": {
            "dailyChangeVsReturn": _pearson(dbook, rets),
            "levelVsClose": _pearson(book, close),
        },
        "durations": {},
        "validation": VALIDATION["machine"],
    }

    for label, W in WINDOWS.items():
        if len(book) < W:
            continue
        r = peak_reversal_machine(dates, close, book, W)
        i = len(book) - 1
        ref = _trailing_peak(book, i, W) or 0
        state = r["states"][i] if r["states"] else "idle"
        # reconstruct the live reference levels for the card
        run_peak = ref
        for ev in reversed(r["events"]):
            if ev["date"] <= dates[i]:
                break
        done = [e for e in r["events"] if e["complete"] and e["forwardPct"] is not None]
        out["durations"][label] = {
            "window": W,
            "state": state,
            "shortBook": int(book[i]) if book[i] is not None else None,
            "trailingPeak": int(ref),
            "activateLevel": int(round(ACTIVATE_FRAC * ref)),
            "pctOfPeak": round(book[i] / ref * 100, 1) if ref else None,
            "fireLevelIfPeakNow": int(round(FIRE_FRAC * run_peak)),
            "events": r["events"][-8:],
            "eventCount": len(r["events"]),
            "eventsUp": sum(1 for e in done if e["forwardPct"] > 0),
            "eventsComplete": len(done),
        }
    return out


def ordinal(n: Num) -> str:
    """1 -> 1st, 2 -> 2nd, 13 -> 13th. Used in user-facing percentile text."""
    if n is None:
        return "n/a"
    i = int(round(n))
    if 10 <= i % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(i % 10, "th")
    return f"{i}{suffix}"


def summarise(latest: dict) -> str:
    """One-line human summary, for CLI output and dashboard subtitles."""
    parts = []
    if latest.get("volPercentile") is not None:
        parts.append(
            f"vol {latest['vol']:.2f}%/day ({ordinal(latest['volPercentile'])} pctile) "
            f"-> {latest['regime']}"
        )
    if latest.get("size") is not None:
        parts.append(f"size {latest['size']:.2f}x")
    for actor, info in (latest.get("positioning") or {}).items():
        if info["percentile"] is not None:
            parts.append(
                f"{actor} {ordinal(info['percentile'])} pctile ({info['label']})"
            )
    return "  |  ".join(parts) if parts else "insufficient history"


if __name__ == "__main__":
    import sqlite3

    conn = sqlite3.connect("file:nse_data.db?mode=ro", uri=True)
    rows = conn.execute(
        "SELECT date, close FROM index_prices WHERE symbol='NIFTY 50' ORDER BY date"
    ).fetchall()
    nets = dict(
        conn.execute(
            "SELECT date, future_index_long - future_index_short FROM participant_oi "
            "WHERE participant_type='FII' ORDER BY date"
        ).fetchall()
    )
    pro = dict(
        conn.execute(
            "SELECT date, future_index_long - future_index_short FROM participant_oi "
            "WHERE participant_type='Pro' ORDER BY date"
        ).fetchall()
    )
    conn.close()

    dates = [r[0] for r in rows]
    block = build_signal_block(
        [r[1] for r in rows],
        {"FII": [nets.get(d) for d in dates], "Pro": [pro.get(d) for d in dates]},
    )
    print(f"as of {dates[-1]}")
    print(summarise(block["latest"]))
