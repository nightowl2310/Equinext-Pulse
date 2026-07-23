#!/usr/bin/env python3
"""
analysis.py
===========

Reads the SQLite database (never the CSV files) and writes a short BRIEF:
who moved, by how much, and what that positioning adds up to.

THREE COMPARISONS, all anchored to the latest date in the database ("current"):

  DAILY    current vs the previous trading day.       <- the primary brief
  WEEKLY   current vs the last weekly EXPIRY before today.
  MONTHLY  current vs the previous month's monthly EXPIRY.

HOW MOVES ARE CHOSEN (this is the important bit)
------------------------------------------------
Open interest is a QUANTITY (number of contracts), so size is what matters:
we pick the biggest fluctuations by ABSOLUTE change only. The percentage is
printed next to each line as context -- it never decides what gets shown.
Why: a participant going 154 -> 274 contracts is +77.9%, which would top any
percentage list, but it is only +120 contracts -- noise next to a +493,863 move.

The result is NOT a leaderboard. Lines are grouped by ACTOR (participant), so
the brief reads like "here is what each player did".

WHICH ACTORS APPEAR
-------------------
* BASE_ACTORS (FII, DII, Pro) are always eligible, and the brief always shows
  at least MIN_ACTORS (3) of them -- if the biggest moves all belong to one or
  two actors, we pull in each missing actor's own biggest move.
* EXTRA_ACTORS (Client) only appear when they move notably for THEMSELVES.
  This has to be measured as a DEVIATION, not a fixed number of contracts,
  because the actors trade at wildly different scales. In this archive the
  median biggest daily move is ~960,000 contracts for Client but only ~40,000
  for DII, so any fixed threshold would either let Client in every single day
  or shut DII out forever.

THE DIRECTIONAL READ
--------------------
A rules-based, NON-ADVISORY summary of what the INDEX positioning implies
(see directional_read() for the exact rules). It is derived only from the
numbers in the data -- nothing is invented.

    python analysis.py                      # all three comparisons
    python analysis.py --daily
    python analysis.py --weekly --as-of 2026-04-02
    python analysis.py --all --json
    python analysis.py --check-calendar
"""

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median

import db_loader
import trading_calendar as tc


# --------------------------------------------------------------------------- #
# Settings you may want to tweak -- all in one place                           #
# --------------------------------------------------------------------------- #

# How many lines the brief aims for. The spec is "5-7 biggest fluctuations";
# the actor-coverage rule below may push it slightly over, which is fine.
TARGET_LINES = 6

# Optional cap on how many lines one actor may take. Default None = no cap,
# because absolute change is meant to be the SOLE selector: if one player really
# did make the biggest moves, the brief should say so. The MIN_ACTORS rule below
# is what guarantees the brief never collapses onto a single player.
# Set to a number (e.g. 2) if you would rather force an even spread.
MAX_LINES_PER_ACTOR = None

# The brief must always show at least this many different actors.
MIN_ACTORS = 3

# Always eligible: the professional/institutional players.
BASE_ACTORS = ("FII", "DII", "Pro")

# Only shown when they move notably for themselves (see EXTRA_ACTOR_DEVIATION).
EXTRA_ACTORS = ("Client",)

# An extra actor qualifies when its biggest move is at least this many times its
# OWN typical (median) biggest move over the same horizon. 1.0 = "an average day
# for them", so 1.5 means "half again bigger than they usually manage".
EXTRA_ACTOR_DEVIATION = 1.5

# How many past trading days to measure that "typical" move over.
DEVIATION_LOOKBACK = 60

# Ignore anything smaller than this many contracts -- pure noise floor.
MIN_ABS_CHANGE = 1000

# The total_long_contracts / total_short_contracts columns are SUMS of all the
# other fields, so they are always the biggest numbers on the page. If they
# compete for places, every line of the brief becomes "so-and-so's book grew"
# and you never see WHAT was actually done. So they are kept out of the
# selection and printed as a per-actor "book" context line instead -- the same
# reason they are excluded from the directional read (they double-count).
# Set to False if you would rather rank them alongside everything else.
EXCLUDE_TOTAL_FIELDS = True

TOTAL_FIELDS = ("total_long_contracts", "total_short_contracts")

# How lopsided the index positioning must be before we call a tilt.
# The read score runs from -1 (fully bearish) to +1 (fully bullish).
TILT_THRESHOLD = 0.25

CONTEXT_PARTICIPANT = "TOTAL"          # shown as context, never ranked

FIELDS = db_loader.NUMERIC_COLUMNS
TABLE = db_loader.PARTICIPANT_OI_TABLE
ALL_KINDS = ("daily", "weekly", "monthly")

FOOTNOTE = ("Moves selected by absolute change (size); % shown alongside as "
            "context - OI is quantity-driven.")
DISCLAIMER = "Positioning read only - not investment advice."


# --------------------------------------------------------------------------- #
# Rules for the directional read                                               #
# --------------------------------------------------------------------------- #

# What an INCREASE in each field implies for market direction.
#   +1 = leaning bullish, -1 = leaning bearish.
# Only INDEX instruments are used: they are what express a view on the market's
# direction. Single-stock positions and the total_* aggregates are excluded --
# the totals would double-count the fields they are made of.
FIELD_SENTIMENT = {
    "future_index_long": +1,      # buying index futures = bullish
    "future_index_short": -1,     # selling index futures = bearish
    "option_index_call_long": +1,  # buying calls = bullish
    "option_index_call_short": -1,  # writing calls = bearish (caps upside)
    "option_index_put_long": -1,  # buying puts = bearish / hedging
    "option_index_put_short": +1,  # writing puts = bullish
}

# How much each actor's positioning counts toward the read.
# Client is deliberately absent: for every long there must be a short, so the
# crowd is largely the other side of these same trades. Counting both sides
# would simply cancel out and tell us nothing.
ACTOR_SENTIMENT_WEIGHT = {"FII": 1.0, "Pro": 0.6, "DII": 0.4}


# --------------------------------------------------------------------------- #
# Small formatting helpers                                                     #
# --------------------------------------------------------------------------- #

def pretty_field(name: str) -> str:
    """'option_index_put_long' -> 'Option Index Put Long'."""
    return name.replace("_", " ").title()


def behaviour_tag(field: str, change: int) -> str:
    """Plain-English description of what a move means, e.g.
    ('option_index_put_long', +30000) -> 'adding index put longs'."""
    if change == 0:
        return "unchanged"
    growing = change > 0

    if field.startswith("total_"):
        side = "long" if "long" in field else "short"
        return f"{'growing' if growing else 'cutting'} overall {side} book"

    parts = field.split("_")            # future_index_long / option_index_call_long
    kind, segment = parts[0], parts[1]
    if kind == "future":
        what = f"{segment} futures {parts[2]}s"
    else:
        what = f"{segment} {parts[2]} {parts[3]}s"
    return f"{'adding' if growing else 'trimming'} {what}"


def _iso(day: date) -> str:
    return day.isoformat()


def _as_date(iso: str) -> date:
    return date.fromisoformat(iso)


def _weekday_of(iso: str) -> str:
    return _as_date(iso).strftime("%a")


# --------------------------------------------------------------------------- #
# Reading days out of the database                                             #
# --------------------------------------------------------------------------- #

def latest_date(conn) -> str:
    return db_loader.latest_date(conn, TABLE)


def date_exists(conn, day_iso: str) -> bool:
    return conn.execute(
        f"SELECT 1 FROM {TABLE} WHERE date = ? LIMIT 1", (day_iso,)
    ).fetchone() is not None


def previous_date_in_db(conn, day_iso: str):
    """The most recent date in the DB strictly before `day_iso` (or None)."""
    return conn.execute(
        f"SELECT MAX(date) FROM {TABLE} WHERE date < ?", (day_iso,)
    ).fetchone()[0]


def latest_date_on_or_before(conn, day_iso: str):
    """The most recent date in the DB on or before `day_iso` (or None).
    Used only as a safety net if a computed expiry has no data."""
    return conn.execute(
        f"SELECT MAX(date) FROM {TABLE} WHERE date <= ?", (day_iso,)
    ).fetchone()[0]


def fetch_day(conn, day_iso: str) -> dict:
    """Return {participant_type: {field: value}} for one date."""
    columns = ", ".join(FIELDS)
    rows = conn.execute(
        f"SELECT participant_type, {columns} FROM {TABLE} WHERE date = ?",
        (day_iso,),
    ).fetchall()
    return {row[0]: {f: row[i + 1] for i, f in enumerate(FIELDS)} for row in rows}


def trading_days_between(conn, anchor_iso: str, current_iso: str) -> int:
    """How many trading days the comparison spans (daily = 1)."""
    return conn.execute(
        f"SELECT COUNT(DISTINCT date) FROM {TABLE} WHERE date > ? AND date <= ?",
        (anchor_iso, current_iso),
    ).fetchone()[0]


# --------------------------------------------------------------------------- #
# Working out which date to compare against                                    #
# --------------------------------------------------------------------------- #

def resolve_anchor(conn, kind: str, current_iso: str, holidays: set,
                   expiry_weekday: int) -> dict:
    """Decide which past date this comparison should use.

    Returns a dict with either available=False + a reason, or the chosen
    `compare_date` plus detail about how we got there:
      nominal_expiry          the plain Thursday before any holiday rule
      expiry_moved_by_holiday True if a holiday pushed the expiry earlier
      snapped                 True if we had to fall back because the computed
                              expiry had no data (means the holiday list is
                              probably out of date)
    """
    current = _as_date(current_iso)

    # --- DAILY: just the previous day that has data. -----------------------
    if kind == "daily":
        previous = previous_date_in_db(conn, current_iso)
        if previous is None:
            return {"available": False,
                    "reason": "no earlier trading day in the database"}
        return {"available": True, "compare_date": previous,
                "nominal_expiry": None, "expiry_moved_by_holiday": False,
                "snapped": False}

    # --- WEEKLY / MONTHLY: compute the real expiry from the calendar. ------
    if kind == "weekly":
        real, nominal = tc.last_weekly_expiry_before(current, holidays,
                                                     expiry_weekday)
    elif kind == "monthly":
        real, nominal = tc.monthly_expiry_of_previous_month(current, holidays,
                                                            expiry_weekday)
    else:
        raise ValueError(f"unknown comparison kind: {kind}")

    if real >= current:                       # defensive; should not happen
        return {"available": False,
                "reason": f"computed expiry {real} is not before {current_iso}"}

    real_iso, nominal_iso = _iso(real), _iso(nominal)
    moved = real != nominal                   # a holiday pushed it earlier

    if date_exists(conn, real_iso):
        return {"available": True, "compare_date": real_iso,
                "nominal_expiry": nominal_iso, "expiry_moved_by_holiday": moved,
                "snapped": False}

    # Safety net: the calendar says this was a trading day but we have no data
    # for it -- either the download is missing, or the holiday list is wrong.
    fallback = latest_date_on_or_before(conn, real_iso)
    if fallback is None:
        return {"available": False,
                "reason": f"no data on or before the computed expiry {real_iso}"}
    return {"available": True, "compare_date": fallback,
            "nominal_expiry": nominal_iso, "expiry_moved_by_holiday": moved,
            "snapped": True}


# --------------------------------------------------------------------------- #
# Comparing two days                                                           #
# --------------------------------------------------------------------------- #

def compute_changes(old_day: dict, new_day: dict, participants) -> tuple:
    """Compare two days for the given participants.

    Returns (cells, skipped). A cell is skipped when either side is missing
    (NULL, or the participant isn't in one of the files) -- we count those
    rather than silently drop them.
    """
    cells, skipped = [], 0

    for participant in participants:
        old_row, new_row = old_day.get(participant), new_day.get(participant)
        if old_row is None or new_row is None:
            skipped += len(FIELDS)            # participant absent on one side
            continue

        for field in FIELDS:
            old, new = old_row.get(field), new_row.get(field)
            if old is None or new is None:    # NULL in the database
                skipped += 1
                continue

            change = new - old
            # Percentage is meaningless when we start from zero -- report N/A
            # rather than dividing by zero or showing "infinity".
            pct = (change / old * 100) if old != 0 else None

            cells.append({
                "participant": participant,
                "field": field,
                "field_label": pretty_field(field),
                "old": old,
                "new": new,
                "abs_change": change,
                "pct_change": round(pct, 2) if pct is not None else None,
                "pct_display": f"{pct:+.1f}%" if pct is not None else "N/A",
                "direction": "+" if change > 0 else ("-" if change < 0 else "0"),
                "behaviour": behaviour_tag(field, change),
            })

    return cells, skipped


# --------------------------------------------------------------------------- #
# Deciding whether an "extra" actor (Client) is moving notably FOR ITSELF      #
# --------------------------------------------------------------------------- #

def typical_biggest_move(conn, actor: str, horizon: int, current_iso: str,
                         lookback: int = DEVIATION_LOOKBACK):
    """The actor's MEDIAN biggest move over `horizon` trading days, measured
    across recent history. This is the yardstick an extra actor must beat.

    Measured over the same horizon as the comparison itself, so a weekly move
    is judged against typical weekly moves (not daily ones). Returns None when
    there isn't enough history.
    """
    columns = ", ".join(FIELDS)
    rows = conn.execute(
        f"SELECT date, {columns} FROM {TABLE} "
        f"WHERE participant_type = ? AND date <= ? ORDER BY date DESC LIMIT ?",
        (actor, current_iso, lookback + horizon + 1),
    ).fetchall()
    rows.reverse()                              # oldest first

    moves = []
    for i in range(len(rows) - horizon):
        start, end = rows[i], rows[i + horizon]
        sizes = [abs(end[j + 1] - start[j + 1]) for j in range(len(FIELDS))
                 if start[j + 1] is not None and end[j + 1] is not None]
        if sizes:
            moves.append(max(sizes))

    # The final entry is the move we're testing -- drop it so the yardstick is
    # built only from history.
    moves = moves[:-1]
    return median(moves) if moves else None


def qualifying_extra_actors(conn, cells, current_iso: str, horizon: int,
                            deviation: float, lookback: int) -> dict:
    """Work out which EXTRA_ACTORS moved notably enough to earn a place.

    Returns {actor: {"qualified": bool, "biggest": n, "typical": n|None,
                     "ratio": x|None, "reason": str}}
    """
    verdicts = {}
    for actor in EXTRA_ACTORS:
        theirs = [c for c in cells if c["participant"] == actor]
        if not theirs:
            continue
        biggest = max(abs(c["abs_change"]) for c in theirs)
        typical = typical_biggest_move(conn, actor, horizon, current_iso, lookback)

        if typical is None or typical == 0:
            verdicts[actor] = {"qualified": False, "biggest": biggest,
                               "typical": None, "ratio": None,
                               "reason": "not enough history to judge"}
            continue

        ratio = biggest / typical
        qualified = ratio >= deviation
        verdicts[actor] = {
            "qualified": qualified,
            "biggest": biggest,
            "typical": int(typical),
            "ratio": round(ratio, 2),
            "reason": (f"biggest move {biggest:,} is {ratio:.1f}x their typical "
                       f"{int(typical):,} (needs {deviation}x)"),
        }
    return verdicts


# --------------------------------------------------------------------------- #
# Selecting the lines for the brief                                            #
# --------------------------------------------------------------------------- #

def select_movers(cells, eligible_actors, target_lines: int,
                  max_per_actor: int, min_actors: int, min_abs: int,
                  exclude_totals: bool = EXCLUDE_TOTAL_FIELDS) -> tuple:
    """Pick the biggest fluctuations, by ABSOLUTE change only.

    Steps:
      1. Take the biggest moves overall (absolute change is the only selector),
         letting no actor take more than `max_per_actor` lines.
      2. If that covers fewer than `min_actors` actors, pull in each missing
         actor's own single biggest move -- this is the only reason DII ever
         appears, since its moves are ~20x smaller than everyone else's.

    The total_* aggregates sit this out (see EXCLUDE_TOTAL_FIELDS).

    Returns (selected_cells, why) where `why` maps a cell's (actor, field) to
    'ranked' or 'coverage'.
    """
    def usable(c):
        if c["participant"] not in eligible_actors:
            return False
        if abs(c["abs_change"]) < min_abs:
            return False
        if exclude_totals and c["field"] in TOTAL_FIELDS:
            return False
        return True

    pool = sorted((c for c in cells if usable(c)),
                  key=lambda c: abs(c["abs_change"]), reverse=True)

    selected, why, per_actor = [], {}, {}
    for cell in pool:                          # step 1: biggest first
        actor = cell["participant"]
        if max_per_actor is not None and per_actor.get(actor, 0) >= max_per_actor:
            continue                           # only if a cap was asked for
        selected.append(cell)
        why[(actor, cell["field"])] = "ranked"
        per_actor[actor] = per_actor.get(actor, 0) + 1
        if len(selected) >= target_lines:
            break

    # Step 2: make sure enough different BASE actors are represented.
    # We count BASE actors specifically: an extra actor (Client) is meant to
    # appear *in addition to* the base set when it moves notably, never to
    # take a base actor's place. In practice this is the only reason DII is
    # ever visible -- its moves are ~20x smaller than everyone else's, so it
    # never wins a contest decided purely by size.
    base_present = [a for a in per_actor if a in BASE_ACTORS]
    if len(base_present) < min_actors:
        missing = [a for a in BASE_ACTORS if a not in per_actor]
        # bring in the strongest missing actors first
        missing.sort(
            key=lambda a: max((abs(c["abs_change"]) for c in pool
                               if c["participant"] == a), default=0),
            reverse=True,
        )
        for actor in missing:
            biggest = next((c for c in pool if c["participant"] == actor), None)
            if biggest is None:
                continue
            selected.append(biggest)
            why[(actor, biggest["field"])] = "coverage"
            per_actor[actor] = 1
            base_present.append(actor)
            if len(base_present) >= min_actors:
                break

    selected.sort(key=lambda c: abs(c["abs_change"]), reverse=True)
    return selected, why


def group_by_actor(selected, why, all_cells) -> list:
    """Group the chosen lines by actor -- the brief is a picture of each
    player, not a leaderboard. Actors with the biggest move come first.

    Each group also carries that actor's overall "book" change (their total
    long/short), which is context rather than a selected move.
    """
    groups = {}
    for cell in selected:
        groups.setdefault(cell["participant"], []).append(cell)

    out = []
    for actor, lines in groups.items():
        lines.sort(key=lambda c: abs(c["abs_change"]), reverse=True)
        book = {c["field"]: c for c in all_cells
                if c["participant"] == actor and c["field"] in TOTAL_FIELDS}
        out.append({
            "actor": actor,
            "biggest_abs": max(abs(c["abs_change"]) for c in lines),
            "included_by": why.get((actor, lines[0]["field"]), "ranked"),
            "book": {"long": book.get("total_long_contracts"),
                     "short": book.get("total_short_contracts")},
            "lines": lines,
        })
    out.sort(key=lambda g: g["biggest_abs"], reverse=True)
    return out


# --------------------------------------------------------------------------- #
# The directional read (rules-based, non-advisory)                             #
# --------------------------------------------------------------------------- #

def directional_read(cells, min_abs: int, tilt_threshold: float) -> dict:
    """Turn index positioning into a bearish / neutral / bullish tilt.

    The rule, in words: for each INDEX position that moved, decide whether that
    move leans bullish or bearish (FIELD_SENTIMENT), weight it by how much the
    actor's view counts (ACTOR_SENTIMENT_WEIGHT) and by the size of the move,
    then see which way the total leans.

        score = sum(weight * sentiment * change) / sum(weight * |change|)

    That puts the score between -1 (everything bearish) and +1 (everything
    bullish). Anything inside +/- TILT_THRESHOLD is called neutral.

    Nothing here is invented: every signal points at a real number in the data.
    """
    signals, numerator, denominator = [], 0.0, 0.0

    for cell in cells:
        weight = ACTOR_SENTIMENT_WEIGHT.get(cell["participant"])
        sentiment = FIELD_SENTIMENT.get(cell["field"])
        if weight is None or sentiment is None:      # not a scored actor/field
            continue
        change = cell["abs_change"]
        if abs(change) < min_abs:
            continue

        contribution = weight * sentiment * change
        numerator += contribution
        denominator += weight * abs(change)
        signals.append({
            "participant": cell["participant"],
            "field": cell["field"],
            "behaviour": cell["behaviour"],
            "abs_change": change,
            "leans": "bullish" if contribution > 0 else "bearish",
            "strength": abs(contribution),
        })

    if not signals or denominator == 0:
        return {"tilt": "neutral", "score": 0.0, "signals": [],
                "action": "No index positioning moved enough to read.",
                "disclaimer": DISCLAIMER}

    score = round(numerator / denominator, 3)
    if score <= -tilt_threshold:
        tilt = "bearish"
    elif score >= tilt_threshold:
        tilt = "bullish"
    else:
        tilt = "neutral"

    signals.sort(key=lambda s: s["strength"], reverse=True)
    top = signals[:3]

    # A factual one-liner: name the tilt and the single strongest signal behind it.
    lead = top[0]
    lean_word = {"bearish": "leaned defensive",
                 "bullish": "leaned constructive",
                 "neutral": "showed no clear lean"}[tilt]
    action = (f"Index positioning {lean_word} (score {score:+.2f}); "
              f"strongest signal: {lead['participant']} {lead['behaviour']} "
              f"{lead['abs_change']:+,} contracts.")

    return {"tilt": tilt, "score": score,
            "signals": [{k: v for k, v in s.items() if k != "strength"} for s in top],
            "action": action, "disclaimer": DISCLAIMER}


# --------------------------------------------------------------------------- #
# Building one comparison                                                      #
# --------------------------------------------------------------------------- #

def compare_one(conn, kind: str, current_iso: str, holidays: set,
                target_lines: int, max_per_actor: int, min_actors: int,
                min_abs: int, deviation: float, lookback: int,
                tilt_threshold: float, expiry_weekday: int,
                exclude_totals: bool = EXCLUDE_TOTAL_FIELDS) -> dict:
    """Build one comparison (daily / weekly / monthly) as structured data."""
    result = {
        "kind": kind,
        "label": kind.upper(),
        "current_date": current_iso,
        "available": False,
        "reason": None,
        "compare_date": None,
        "nominal_expiry": None,
        "expiry_moved_by_holiday": False,
        "snapped": False,
        "notes": [],
        "headline": None,
        "actor_groups": [],
        "movers": [],
        "selection": {},
        "read": None,
        "total_context": [],
        "skipped_cells": 0,
    }

    anchor = resolve_anchor(conn, kind, current_iso, holidays, expiry_weekday)
    if not anchor["available"]:
        result["reason"] = anchor["reason"]
        return result

    result.update({
        "available": True,
        "compare_date": anchor["compare_date"],
        "nominal_expiry": anchor["nominal_expiry"],
        "expiry_moved_by_holiday": anchor["expiry_moved_by_holiday"],
        "snapped": anchor["snapped"],
    })

    new_day = fetch_day(conn, current_iso)
    old_day = fetch_day(conn, anchor["compare_date"])
    all_actors = tuple(BASE_ACTORS) + tuple(EXTRA_ACTORS)
    cells, skipped = compute_changes(old_day, new_day, all_actors)
    result["skipped_cells"] = skipped

    # Which extra actors earned a place today?
    horizon = max(1, trading_days_between(conn, anchor["compare_date"], current_iso))
    verdicts = qualifying_extra_actors(conn, cells, current_iso, horizon,
                                       deviation, lookback)
    extras_in = [a for a, v in verdicts.items() if v["qualified"]]
    eligible = tuple(BASE_ACTORS) + tuple(extras_in)

    selected, why = select_movers(cells, eligible, target_lines, max_per_actor,
                                  min_actors, min_abs, exclude_totals)
    result["movers"] = selected
    result["actor_groups"] = group_by_actor(selected, why, cells)
    result["selection"] = {
        "selector": "absolute change (contracts)",
        "totals_excluded_from_selection": exclude_totals,
        "target_lines": target_lines,
        "max_lines_per_actor": max_per_actor,
        "min_actors": min_actors,
        "lines_shown": len(selected),
        "actors_shown": [g["actor"] for g in result["actor_groups"]],
        "base_actors": list(BASE_ACTORS),
        "extra_actor_checks": verdicts,
        "extra_actors_included": extras_in,
        "horizon_trading_days": horizon,
    }

    if selected:
        top = selected[0]
        result["headline"] = (f"{top['participant']} {top['behaviour']} "
                              f"{top['abs_change']:+,} contracts "
                              f"({top['pct_display']})")

    # The read uses every eligible cell, not just the printed lines, so the
    # tilt reflects all the index positioning rather than only the top few.
    result["read"] = directional_read(cells, min_abs, tilt_threshold)

    # TOTAL is context only -- never part of the "who moved" picture.
    total_cells, _ = compute_changes(old_day, new_day, (CONTEXT_PARTICIPANT,))
    total_cells.sort(key=lambda c: abs(c["abs_change"]), reverse=True)
    result["total_context"] = total_cells

    # Helpful notes.
    if anchor["expiry_moved_by_holiday"]:
        result["notes"].append(
            f"Expiry moved from {_weekday_of(anchor['nominal_expiry'])} "
            f"{anchor['nominal_expiry']} to {anchor['compare_date']} "
            f"because {anchor['nominal_expiry']} was a holiday.")
    if anchor["snapped"]:
        result["notes"].append(
            "No data for the computed expiry; used the nearest earlier day "
            "instead. Your holiday list may need updating "
            "(try: python analysis.py --check-calendar).")
    for actor, verdict in verdicts.items():
        if not verdict["qualified"]:
            result["notes"].append(f"{actor} not shown: {verdict['reason']}.")
    if kind in ("weekly", "monthly"):
        previous = previous_date_in_db(conn, current_iso)
        if previous is not None and anchor["compare_date"] == previous:
            result["notes"].append(
                "Same date as the DAILY comparison -- today is the first "
                "trading day after this expiry.")
    return result


def build_report(conn, kinds=ALL_KINDS, current_iso: str = None,
                 holidays: set = None, target_lines: int = TARGET_LINES,
                 max_per_actor: int = MAX_LINES_PER_ACTOR,
                 min_actors: int = MIN_ACTORS, min_abs: int = MIN_ABS_CHANGE,
                 deviation: float = EXTRA_ACTOR_DEVIATION,
                 lookback: int = DEVIATION_LOOKBACK,
                 tilt_threshold: float = TILT_THRESHOLD,
                 expiry_weekday: int = tc.EXPIRY_WEEKDAY,
                 exclude_totals: bool = EXCLUDE_TOTAL_FIELDS) -> dict:
    """Build the whole brief as JSON-ready data. This is the reusable core --
    a dashboard, Excel export or alert can call this and never touch the
    printing code below.
    """
    db_loader.ensure_table(conn, db_loader.PARTICIPANT_OI_DDL)
    if holidays is None:
        holidays = tc.load_holidays()
    if current_iso is None:
        current_iso = latest_date(conn)
    if current_iso is None:
        raise ValueError("the database is empty -- run "
                         "'python nse_oi_scraper.py --load-all' first")
    if not date_exists(conn, current_iso):
        raise ValueError(f"no data for {current_iso} in the database")

    return {
        "current_date": current_iso,
        "config": {
            "selector": "absolute change (contracts)",
            "target_lines": target_lines,
            "max_lines_per_actor": max_per_actor,
            "min_actors": min_actors,
            "min_abs_change": min_abs,
            "totals_excluded_from_selection": exclude_totals,
            "extra_actor_deviation": deviation,
            "tilt_threshold": tilt_threshold,
            "expiry_weekday": tc.weekday_name(expiry_weekday),
        },
        "footnote": FOOTNOTE,
        "disclaimer": DISCLAIMER,
        "comparisons": [
            compare_one(conn, kind, current_iso, holidays, target_lines,
                        max_per_actor, min_actors, min_abs, deviation,
                        lookback, tilt_threshold, expiry_weekday,
                        exclude_totals)
            for kind in kinds
        ],
    }


# --------------------------------------------------------------------------- #
# The brief: headline on top, actors in the middle, the read at the bottom     #
# --------------------------------------------------------------------------- #

def format_brief(report: dict) -> str:
    """Human-readable version of build_report()'s output."""
    lines = []

    for comp in report["comparisons"]:
        lines.append("=" * 78)
        if not comp["available"]:
            lines.append(f"{comp['label']} BRIEF -- skipped: {comp['reason']}")
            lines.append("=" * 78)
            continue

        tag = "  [expiry]" if comp["kind"] in ("weekly", "monthly") else ""
        lines.append(f"NSE PARTICIPANT OI -- {comp['label']} BRIEF{tag}")
        lines.append(f"{comp['current_date']} [{_weekday_of(comp['current_date'])}]"
                     f"  vs  {comp['compare_date']} "
                     f"[{_weekday_of(comp['compare_date'])}]")
        lines.append("=" * 78)

        if comp["headline"]:
            lines.append(f"HEADLINE: {comp['headline']}")
        for note in comp["notes"]:
            lines.append(f"  * {note}")
        lines.append("")

        # --- the actors -------------------------------------------------- #
        for group in comp["actor_groups"]:
            marker = "  (shown for coverage)" if group["included_by"] == "coverage" else ""
            lines.append(f"{group['actor']}{marker}")

            # Their overall book, as context -- not one of the selected moves.
            # Skipped when --include-totals is on, because then the totals are
            # already printed as ranked lines and this would just repeat them.
            book_long, book_short = group["book"]["long"], group["book"]["short"]
            if book_long and book_short and comp["selection"].get(
                    "totals_excluded_from_selection", True):
                lines.append(
                    f"    {'book:':<24} long {book_long['abs_change']:+,} "
                    f"({book_long['pct_display']})  |  "
                    f"short {book_short['abs_change']:+,} "
                    f"({book_short['pct_display']})")

            for cell in group["lines"]:
                lines.append(
                    f"    {cell['field_label']:<24} "
                    f"{cell['old']:>12,} -> {cell['new']:>12,}   "
                    f"{cell['abs_change']:>+11,}  {cell['pct_display']:>8}   "
                    f"{cell['behaviour']}")
        if not comp["actor_groups"]:
            lines.append("  (no moves above the noise floor)")

        if comp["total_context"]:
            total = comp["total_context"][0]
            lines.append("")
            lines.append(f"TOTAL (context): {total['field_label']} "
                         f"{total['abs_change']:+,} "
                         f"({total['old']:,} -> {total['new']:,})")

        # --- the read ---------------------------------------------------- #
        read = comp["read"]
        lines.append("")
        lines.append(f"READ: {read['tilt'].upper()} tilt   (score {read['score']:+.2f} "
                     f"on a -1 bearish .. +1 bullish scale)")
        for signal in read["signals"]:
            lines.append(f"    - {signal['participant']} {signal['behaviour']} "
                         f"{signal['abs_change']:+,}  ({signal['leans']})")
        lines.append(f"Action: {read['action']}")
        lines.append(read["disclaimer"])
        lines.append("")
        lines.append(report["footnote"])
        lines.append("=" * 78)

    return "\n".join(lines)


# Kept so older callers/scripts that used format_report() still work.
format_report = format_brief


# =========================================================================== #
# DASHBOARD EXPORT -- the ONE place where backend names become UI names        #
# =========================================================================== #
#
# The "Equinext Pulse" frontend (frontend/) is a single React page that simply
# fetches these JSON files -- it does no maths and knows nothing about the
# database. Everything the page shows comes from the contract below, so if the
# UI ever wants a new value it must be added HERE, not invented in the browser.
#
# One file per timeframe:  frontend/public/data/{daily,weekly,monthly}.json
# (Vite serves `public/` at the site root, so the page fetches /data/daily.json.
#  That's why this needs no API server and no extra dependency.)
#
# THE CONTRACT (one object per file):
#   timeframe          "daily" | "weekly" | "monthly"
#   available          false when there isn't enough history; `reason` says why
#   reason             string | null
#   marketLabel        "NSE F&O"
#   generatedAt        ISO timestamp of when this file was written
#   generatedAtDisplay e.g. "7:04 PM IST"   (what the navbar/hero chip shows)
#   asOf               { iso, display }     the trading date the brief is about
#   dateA / dateB      { iso, display, weekday, expiry }  the two compared days
#   headline           the single biggest move, as a sentence
#   note               "Client hidden - ..." | null   (the muted chip)
#   notes              [ every note the engine raised ]
#   actors             [ { name, coverage, book{...}, moves[...] } ]
#     book             { longChange, longPct, shortChange, shortPct }  (pct may be null)
#     moves            [ { field, oldVal, newVal, change, pct, note } ] (pct may be null)
#   total              { field, oldVal, newVal, change }   the TOTAL context strip
#   read               { score, tilt, signals[ { text, sentiment } ] }
#   action             the one-line positioning summary
#   disclaimer         "Positioning read only - not investment advice."
#   footnote           how moves were selected
#
# NOTE ON pct: it is `null` (never 0, never Infinity) when the old value was 0.
# The UI must render that as "N/A".

DASHBOARD_DIR = Path(__file__).with_name("frontend") / "public" / "data"


def _tz_label(moment: datetime) -> str:
    """Name the machine's timezone. India is what this project is about, so
    +05:30 is spelled IST; anything else is shown honestly as a UTC offset."""
    offset = moment.utcoffset()
    if offset is None:
        return "local"
    if offset == timedelta(hours=5, minutes=30):
        return "IST"
    minutes = int(offset.total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    hours, mins = divmod(abs(minutes), 60)
    return f"UTC{sign}{hours:02d}:{mins:02d}"


def _clock(moment: datetime) -> str:
    """'17 Jul 2026, 7:04 PM IST' -- when this file was written.

    The DATE is deliberately included. This stamp is almost never the same day
    as the data it describes (NSE publishes a day's OI after ~6 PM that
    evening, and the job may run later still), so a bare '7:04 PM' printed next
    to the trading date would read as a time ON that date -- a moment that
    never happened. Keeping the date here makes the two facts impossible to
    confuse. %-I is not portable to Windows, hence the hand-rolled hour.
    """
    hour = moment.hour % 12 or 12
    ampm = "AM" if moment.hour < 12 else "PM"
    return (f"{moment.strftime('%d %b %Y')}, "
            f"{hour}:{moment.minute:02d} {ampm} {_tz_label(moment)}")


def _date_parts(iso: str, expiry: bool = False) -> dict:
    """'2026-07-09' -> {iso, display:'09 Jul 2026', weekday:'Thu', expiry}.
    `display` is pre-composed so the page can print it without any date logic."""
    day = _as_date(iso)
    weekday = day.strftime("%a")
    suffix = f"{weekday} · expiry" if expiry else weekday
    return {"iso": iso, "display": f"{day.strftime('%d %b %Y')} ({suffix})",
            "dateOnly": day.strftime("%d %b %Y"), "weekday": weekday,
            "expiry": expiry}


def _hidden_actor_note(comp: dict):
    """The muted chip: 'Client hidden - biggest move ... (needs 1.5x)'.
    Built from the engine's own verdict, so the numbers are always real."""
    for actor, verdict in comp["selection"].get("extra_actor_checks", {}).items():
        if not verdict.get("qualified"):
            return f"{actor} hidden - {verdict['reason']}"
    return None


def to_dashboard_payload(comp: dict, report: dict, moment: datetime) -> dict:
    """Map one comparison onto the UI contract above.

    This is deliberately the ONLY translation layer: backend field names
    (abs_change, behaviour, included_by, leans, ...) become UI field names
    (change, note, coverage, sentiment, ...) exactly once, here.
    """
    base = {
        "timeframe": comp["kind"],
        "available": comp["available"],
        "reason": comp["reason"],
        "marketLabel": "NSE F&O",
        "generatedAt": moment.isoformat(timespec="seconds"),
        "generatedAtDisplay": _clock(moment),
        "asOf": {"iso": report["current_date"],
                 "display": _as_date(report["current_date"]).strftime("%d %b %Y")},
        "disclaimer": report["disclaimer"],
        "footnote": report["footnote"],
    }
    if not comp["available"]:
        # Nothing to show -- the page renders `reason` instead of the brief.
        base.update({"dateA": None, "dateB": None, "headline": None, "note": None,
                     "notes": [], "actors": [], "total": None, "read": None,
                     "action": None})
        return base

    is_expiry = comp["kind"] in ("weekly", "monthly")

    actors = []
    for group in comp["actor_groups"]:
        book_long, book_short = group["book"]["long"], group["book"]["short"]
        actors.append({
            "name": group["actor"],
            "coverage": group["included_by"] == "coverage",
            "book": {
                "longChange": book_long["abs_change"] if book_long else None,
                "longPct": book_long["pct_change"] if book_long else None,
                "shortChange": book_short["abs_change"] if book_short else None,
                "shortPct": book_short["pct_change"] if book_short else None,
            },
            "moves": [{
                "field": line["field_label"],
                "oldVal": line["old"],
                "newVal": line["new"],
                "change": line["abs_change"],
                "pct": line["pct_change"],      # null when the old value was 0
                "note": line["behaviour"],
            } for line in group["lines"]],
        })

    total = comp["total_context"][0] if comp["total_context"] else None
    read = comp["read"]

    base.update({
        "dateA": _date_parts(comp["current_date"]),
        "dateB": _date_parts(comp["compare_date"], expiry=is_expiry),
        "headline": comp["headline"],
        "note": _hidden_actor_note(comp),
        "notes": comp["notes"],
        "actors": actors,
        "total": None if total is None else {
            "field": total["field_label"], "oldVal": total["old"],
            "newVal": total["new"], "change": total["abs_change"],
        },
        "read": {
            "score": read["score"],
            "tilt": read["tilt"].upper(),
            "signals": [{
                "text": (f"{s['participant']} {s['behaviour']} "
                         f"{s['abs_change']:+,}"),
                "sentiment": s["leans"],
            } for s in read["signals"]],
        },
        "action": read["action"],
    })
    return base


def export_dashboard(conn, out_dir=DASHBOARD_DIR, holidays: set = None,
                     current_iso: str = None, **kwargs) -> list:
    """Write daily.json / weekly.json / monthly.json for the frontend."""
    moment = datetime.now().astimezone()
    report = build_report(conn, kinds=ALL_KINDS, current_iso=current_iso,
                          holidays=holidays, **kwargs)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for comp in report["comparisons"]:
        payload = to_dashboard_payload(comp, report, moment)
        path = out_dir / f"{comp['kind']}.json"
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                        encoding="utf-8")
        written.append(path)
    return written


# --------------------------------------------------------------------------- #
# --check-calendar: does the holiday list still match the downloaded data?     #
# --------------------------------------------------------------------------- #

def check_calendar(conn, holidays: set) -> dict:
    """Cross-check the holiday list against the archive.

    The data is the ground truth: if NSE published no file on a weekday, the
    market did not trade that day. So:
      * a missing weekday NOT in the holiday list  -> the list is incomplete
      * a listed holiday that DOES have data       -> DANGEROUS: that is a real
        trading day being skipped, and it would corrupt the expiry dates.
    """
    rows = conn.execute(f"SELECT DISTINCT date FROM {TABLE}").fetchall()
    have = {r[0] for r in rows}
    if not have:
        return {"empty": True}

    low, high = _as_date(min(have)), _as_date(max(have))
    missing, day = set(), low
    while day <= high:
        if day.weekday() < 5 and _iso(day) not in have:
            missing.add(day)
        day += timedelta(days=1)

    declared = {h for h in holidays if low <= h <= high and h.weekday() < 5}
    return {
        "empty": False,
        "range": (_iso(low), _iso(high)),
        "missing_weekdays": sorted(_iso(d) for d in missing),
        "undeclared": sorted(_iso(d) for d in (missing - declared)),
        "wrongly_declared": sorted(_iso(d) for d in (declared - missing)),
    }


def format_calendar_check(check: dict) -> str:
    if check.get("empty"):
        return "The database is empty -- nothing to check."
    low, high = check["range"]
    lines = [f"Calendar check against downloaded data ({low} .. {high})",
             f"  non-trading weekdays found in the data: {len(check['missing_weekdays'])}"]
    for d in check["missing_weekdays"]:
        mark = "  <- NOT in your holiday list" if d in check["undeclared"] else ""
        lines.append(f"    {d} [{_weekday_of(d)}]{mark}")

    if check["wrongly_declared"]:
        lines.append("")
        lines.append("  DANGER: these are listed as holidays but DO have data,")
        lines.append("  i.e. they are real trading days. Remove them from")
        lines.append("  nse_holidays.txt -- they corrupt the expiry dates:")
        for d in check["wrongly_declared"]:
            lines.append(f"    {d} [{_weekday_of(d)}]")
    if not check["undeclared"] and not check["wrongly_declared"]:
        lines.append("")
        lines.append("  OK: the holiday list agrees with the data exactly.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Command line                                                                 #
# --------------------------------------------------------------------------- #

def parse_date_arg(text: str) -> str:
    try:
        return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"date must look like 2026-07-16, got {text!r}")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="A short brief on who moved NSE participant-wise OI.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python analysis.py                      # all three briefs\n"
            "  python analysis.py --daily\n"
            "  python analysis.py --weekly --as-of 2026-04-02\n"
            "  python analysis.py --all --json\n"
            "  python analysis.py --check-calendar\n"
        ),
    )
    parser.add_argument("--daily", action="store_true", help="Compare with the previous trading day.")
    parser.add_argument("--weekly", action="store_true", help="Compare with the last weekly expiry.")
    parser.add_argument("--monthly", action="store_true", help="Compare with last month's expiry.")
    parser.add_argument("--all", action="store_true", help="All three (the default).")
    parser.add_argument("--db", default="nse_data.db", help="Database file (default: nse_data.db).")
    parser.add_argument("--holidays", type=Path, default=tc.DEFAULT_HOLIDAYS_PATH,
                        help="Holiday list (default: nse_holidays.txt next to this script).")
    parser.add_argument("--as-of", type=parse_date_arg, default=None, metavar="DATE",
                        help="Treat this date as 'current' (default: latest date in the DB).")
    parser.add_argument("--lines", type=int, default=TARGET_LINES, metavar="N",
                        help=f"How many moves to aim for (default: {TARGET_LINES}).")
    parser.add_argument("--max-per-actor", type=int, default=MAX_LINES_PER_ACTOR, metavar="N",
                        help="Cap on lines per actor (default: no cap - absolute "
                             "change is the sole selector).")
    parser.add_argument("--min-actors", type=int, default=MIN_ACTORS, metavar="N",
                        help=f"Always show at least this many actors (default: {MIN_ACTORS}).")
    parser.add_argument("--min-abs", type=int, default=MIN_ABS_CHANGE, metavar="N",
                        help=f"Ignore moves under N contracts (default: {MIN_ABS_CHANGE}).")
    parser.add_argument("--deviation", type=float, default=EXTRA_ACTOR_DEVIATION, metavar="X",
                        help=("How many times its own typical move an extra actor "
                              f"(e.g. Client) must make to appear (default: {EXTRA_ACTOR_DEVIATION})."))
    parser.add_argument("--include-totals", action="store_true",
                        help="Also rank the total_* aggregate columns (off by "
                             "default: they are sums, so they crowd out real moves).")
    parser.add_argument("--json", action="store_true",
                        help="Print structured JSON instead of the brief.")
    parser.add_argument("--check-calendar", action="store_true",
                        help="Check the holiday list against the downloaded data, then exit.")
    parser.add_argument("--export-dashboard", nargs="?", const=str(DASHBOARD_DIR),
                        default=None, metavar="DIR",
                        help=("Write daily/weekly/monthly.json for the frontend, "
                              f"then exit (default: {DASHBOARD_DIR})."))
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    conn = db_loader.connect(args.db)
    try:
        holidays = tc.load_holidays(args.holidays)

        if args.check_calendar:
            print(format_calendar_check(check_calendar(conn, holidays)))
            return

        if args.export_dashboard is not None:
            try:
                written = export_dashboard(conn, args.export_dashboard, holidays,
                                           current_iso=args.as_of,
                                           target_lines=args.lines,
                                           max_per_actor=args.max_per_actor,
                                           min_actors=args.min_actors,
                                           min_abs=args.min_abs,
                                           deviation=args.deviation,
                                           exclude_totals=not args.include_totals)
            except ValueError as exc:
                print(f"ERROR: {exc}")
                sys.exit(1)
            for path in written:
                print(f"wrote {path}")
            return

        kinds = [k for k in ALL_KINDS if getattr(args, k)]
        if args.all or not kinds:          # default: everything
            kinds = list(ALL_KINDS)

        try:
            report = build_report(conn, kinds=kinds, current_iso=args.as_of,
                                  holidays=holidays, target_lines=args.lines,
                                  max_per_actor=args.max_per_actor,
                                  min_actors=args.min_actors,
                                  min_abs=args.min_abs,
                                  deviation=args.deviation,
                                  exclude_totals=not args.include_totals)
        except ValueError as exc:
            print(f"ERROR: {exc}")
            sys.exit(1)

        print(json.dumps(report, indent=2) if args.json else format_brief(report))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
