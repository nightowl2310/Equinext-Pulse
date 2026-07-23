#!/usr/bin/env python3
"""
trading_calendar.py
===================

Shared knowledge about WHICH DAYS THE MARKET TRADES, and WHEN F&O CONTRACTS
EXPIRE. Both `nse_oi_scraper.py` (which days to download) and `analysis.py`
(which days to compare against) use this, so the rules live in exactly one place.

THE TWO IDEAS IN HERE
---------------------
1. A "trading day" is a weekday that is not in the holiday list
   (`nse_holidays.txt`).

2. F&O contracts expire on a fixed weekday -- Thursday for NSE. BUT if that
   Thursday is a holiday, the exchange moves the expiry BACK to the previous
   trading day (usually Wednesday). `resolve_expiry()` below implements that
   rule, so we compute the real expiry date instead of blindly assuming
   "Thursday".

   This is not theoretical: in the downloaded archive, Thursday 2026-03-26 and
   Thursday 2026-05-28 were holidays, so those weeks expired on the Wednesday.

This module imports nothing from the rest of the project, which keeps the
imports simple and one-directional:

    trading_calendar.py          (this file -- depends on nothing local)
          ^            ^
          |            |
    nse_oi_scraper.py  analysis.py
"""

from datetime import date, datetime, timedelta
from pathlib import Path


# --------------------------------------------------------------------------- #
# Configuration                                                                #
# --------------------------------------------------------------------------- #

# The weekday F&O contracts expire on. Monday=0, Tuesday=1, ... Sunday=6.
# NSE currently expires on THURSDAY (=3). If the exchange ever changes this,
# edit this single number -- everything else follows automatically.
EXPIRY_WEEKDAY = 3

# The holiday list that ships next to this file.
DEFAULT_HOLIDAYS_PATH = Path(__file__).with_name("nse_holidays.txt")

# Friendly weekday names for messages.
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday",
                 "Friday", "Saturday", "Sunday"]


def weekday_name(weekday: int) -> str:
    """0 -> 'Monday', 3 -> 'Thursday'."""
    return WEEKDAY_NAMES[weekday]


# --------------------------------------------------------------------------- #
# The holiday list                                                             #
# --------------------------------------------------------------------------- #

def load_holidays(path=None) -> set:
    """Read a holiday file (one YYYY-MM-DD per line) into a set of dates.

    Blank lines and anything after a '#' are ignored, so inline comments like
    "2026-01-26   # Republic Day" work. A missing file is not fatal -- we warn
    and carry on with an empty set.
    """
    path = Path(path) if path is not None else DEFAULT_HOLIDAYS_PATH
    holidays = set()
    if not path.exists():
        print(f"NOTE: holiday file not found at {path} -- continuing without it.")
        return holidays

    for line in path.read_text(encoding="utf-8").splitlines():
        # Drop any inline comment (e.g. "2026-01-26   # Republic Day") and spaces.
        line = line.split("#", 1)[0].strip()
        if not line:                    # blank line or a comment-only line
            continue
        try:
            holidays.add(datetime.strptime(line, "%Y-%m-%d").date())
        except ValueError:
            print(f"WARNING: ignoring bad date in holiday file: {line!r}")
    return holidays


# --------------------------------------------------------------------------- #
# Trading days                                                                 #
# --------------------------------------------------------------------------- #

def is_trading_day(day: date, holidays: set) -> bool:
    """True if the market trades on `day`: a weekday that isn't a holiday."""
    if day.weekday() >= 5:              # Mon=0 ... Sat=5, Sun=6
        return False
    return day not in holidays


def previous_trading_day(day: date, holidays: set) -> date:
    """The most recent trading day STRICTLY BEFORE `day`."""
    day -= timedelta(days=1)
    while not is_trading_day(day, holidays):
        day -= timedelta(days=1)
    return day


def iter_trading_days(start: date, end: date, holidays: set):
    """Yield each trading day from `start` to `end` (inclusive), oldest first,
    skipping weekends and holidays."""
    day = start
    one_day = timedelta(days=1)
    while day <= end:
        if is_trading_day(day, holidays):
            yield day
        day += one_day


# --------------------------------------------------------------------------- #
# Expiry dates -- the important part                                           #
# --------------------------------------------------------------------------- #

def resolve_expiry(nominal: date, holidays: set) -> date:
    """Turn a NOMINAL expiry day (e.g. "that week's Thursday") into the REAL one.

    NSE's rule: if the expiry day is a holiday, expiry moves BACK to the
    previous trading day. So we simply walk backwards until we land on a
    trading day.

    Example: Thursday 2026-03-26 was a holiday, so that week's expiry was
    actually Wednesday 2026-03-25.
    """
    day = nominal
    while not is_trading_day(day, holidays):
        day -= timedelta(days=1)
    return day


def nominal_weekly_expiry_on_or_before(day: date,
                                       expiry_weekday: int = EXPIRY_WEEKDAY) -> date:
    """The most recent expiry WEEKDAY (Thursday) on or before `day`, ignoring
    holidays. This is just calendar arithmetic -- `resolve_expiry` applies the
    holiday rule afterwards."""
    days_back = (day.weekday() - expiry_weekday) % 7
    return day - timedelta(days=days_back)


def last_weekly_expiry_before(current: date, holidays: set,
                              expiry_weekday: int = EXPIRY_WEEKDAY) -> tuple:
    """The last weekly expiry that happened STRICTLY BEFORE `current`.

    Returns (real_expiry, nominal_expiry) so the caller can tell the user when
    a holiday moved the date (real != nominal).

    Walking example, current = Thursday 2026-04-02:
      nominal 2026-04-02 -> resolves to itself, but that is not < current,
      so step back a week: nominal 2026-03-26 -> that Thursday is a holiday
      -> resolves to Wednesday 2026-03-25 -> which IS < current. Done.
    """
    nominal = nominal_weekly_expiry_on_or_before(current, expiry_weekday)
    while True:
        real = resolve_expiry(nominal, holidays)
        if real < current:              # must be strictly before "current"
            return real, nominal
        nominal -= timedelta(days=7)    # try the previous week's expiry


def monthly_expiry_of_previous_month(current: date, holidays: set,
                                     expiry_weekday: int = EXPIRY_WEEKDAY) -> tuple:
    """The monthly expiry of the month BEFORE `current`'s month.

    The monthly expiry is the LAST expiry-weekday (Thursday) of that month,
    moved back if it lands on a holiday. Returns (real_expiry, nominal_expiry).
    """
    first_of_this_month = current.replace(day=1)
    last_day_of_prev_month = first_of_this_month - timedelta(days=1)
    nominal = nominal_weekly_expiry_on_or_before(last_day_of_prev_month,
                                                 expiry_weekday)
    return resolve_expiry(nominal, holidays), nominal
