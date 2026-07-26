#!/usr/bin/env python3
"""
scraper.py
==========

Scrape NIFTY 50's daily price data (Open/High/Low/CLOSE + volume) and store it
in our local database `nse_data.db`, in its OWN table `index_prices`. This is
the price side of the "Equinext Pulse" overlay: the participant_oi table tells
us WHO is positioned; index_prices tells us WHERE the index actually went, so
the two can be joined on `date` and plotted together.

WHY YAHOO FINANCE (and not screener.in)?
----------------------------------------
Screener.in is a per-COMPANY fundamentals site -- it does not publish an INDEX
(NIFTY 50) price series, so it can't supply this. Yahoo Finance's public chart
API does: one JSON request returns the whole daily history for the ticker
`^NSEI` (NIFTY 50), needs no login, isn't behind Akamai bot-protection, and its
trading dates line up exactly with NSE's (verified against participant_oi).

    https://query1.finance.yahoo.com/v8/finance/chart/^NSEI?period1=..&period2=..&interval=1d

Official settled closes are also on NSE at
    https://archives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv
(one file per day, behind Akamai). Yahoo is accurate enough for a price overlay
and far simpler, so we use it here; the NSE path is a possible future fallback.

DEFAULT RANGE = whatever the OI table covers
--------------------------------------------
So the overlay always has a price for every OI day, the default date range is
the min..max date already in `participant_oi`. Pass --start/--end to override,
or run with an empty DB and it falls back to the last 6 months.

Nothing about the raw CSV archive changes; this only ADDS a table. Re-running is
safe (INSERT OR IGNORE on (date, symbol)) -- it only fills in missing days.

    python scraper.py                       # NIFTY 50, aligned to the OI table
    python scraper.py --start 2026-01-01 --end 2026-07-21
    python scraper.py --index "NIFTY BANK"  # a different index into the same table
    python scraper.py --preview 10          # also print the first rows
"""

import argparse
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

import db_loader
# reuse the exact same date helpers the OI scraper uses, so behaviour matches.
from nse_oi_scraper import months_ago, parse_date


# --------------------------------------------------------------------------- #
# Constants                                                                    #
# --------------------------------------------------------------------------- #

# Friendly index name -> Yahoo Finance ticker. Add more here if ever needed.
INDEX_TICKERS = {
    "NIFTY 50":      "^NSEI",
    "NIFTY BANK":    "^NSEBANK",
    "NIFTY NEXT 50": "^NSMIDCP",
    "NIFTY IT":      "^CNXIT",
    "SENSEX":        "^BSESN",
}

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

MAX_ATTEMPTS = 3       # Yahoo is reliable, but retry a couple of times anyway
BACKOFF_BASE = 2.0     # seconds between retries (grows with each attempt)


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


# --------------------------------------------------------------------------- #
# Fetch + parse Yahoo's daily chart JSON                                       #
# --------------------------------------------------------------------------- #

def fetch_chart(ticker: str, start: date, end: date, timeout: float = 30.0) -> dict:
    """Return Yahoo's parsed chart `result` dict for one ticker over a range.

    period1/period2 are UNIX seconds. We pad period2 by a day so the `end` day
    is included regardless of the exchange's session time. Raises RuntimeError
    if Yahoo never returns a usable body.
    """
    period1 = int(datetime(start.year, start.month, start.day,
                           tzinfo=timezone.utc).timestamp())
    period2 = int(datetime(end.year, end.month, end.day,
                           tzinfo=timezone.utc).timestamp()) + 86400
    url = YAHOO_CHART.format(ticker=ticker)
    params = {"period1": period1, "period2": period2, "interval": "1d"}
    headers = {"User-Agent": BROWSER_UA, "Accept": "application/json"}

    last_err = "unknown error"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last_err = f"network error: {exc}"
        else:
            if resp.status_code == 200:
                body = resp.json()
                chart = body.get("chart") or {}
                if chart.get("error"):
                    raise RuntimeError(f"Yahoo error: {chart['error']}")
                results = chart.get("result") or []
                if results:
                    return results[0]
                last_err = "empty 'result' in response"
            else:
                last_err = f"HTTP {resp.status_code}"
        if attempt < MAX_ATTEMPTS:
            log(f"  attempt {attempt} failed ({last_err}); retrying...")
            time.sleep(BACKOFF_BASE * attempt)
    raise RuntimeError(last_err)


def parse_chart(result: dict, symbol: str, ticker: str) -> list:
    """Turn Yahoo's chart `result` into rows for db_loader.store_index_prices.

    Each row is a tuple in db_loader.INDEX_PRICES_COLUMNS order:
        (date, symbol, open, high, low, close, volume, source)

    The trading date is the candle's timestamp shifted into the exchange's own
    timezone (gmtoffset), so a 09:15 IST open is dated correctly. Days whose
    close is null (an occasional Yahoo gap / holiday) are skipped.
    """
    timestamps = result.get("timestamp") or []
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    opens = quote.get("open", [])
    highs = quote.get("high", [])
    lows = quote.get("low", [])
    closes = quote.get("close", [])
    vols = quote.get("volume", [])
    gmtoffset = result.get("meta", {}).get("gmtoffset", 0) or 0
    tz = timezone(timedelta(seconds=gmtoffset))
    source = f"yahoo:{ticker}"

    def r2(v):
        return None if v is None else round(float(v), 2)

    rows = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:                       # no settled close -> skip the day
            continue
        d = datetime.fromtimestamp(ts, tz).date().isoformat()
        vol = vols[i] if i < len(vols) else None
        rows.append((
            d, symbol,
            r2(opens[i] if i < len(opens) else None),
            r2(highs[i] if i < len(highs) else None),
            r2(lows[i] if i < len(lows) else None),
            r2(close),
            int(vol) if vol is not None else None,
            source,
        ))
    return rows


# --------------------------------------------------------------------------- #
# Range resolution -- default to whatever participant_oi covers                #
# --------------------------------------------------------------------------- #

def resolve_range(conn, start: date, end: date):
    """Fill in whichever of start/end the user did not give. Default = the span
    of the OI table (so every OI day has a price); fall back to last 6 months if
    that table is empty. Returns (start, end)."""
    if start and end:
        return start, end
    lo = hi = None
    try:
        row = conn.execute(
            f"SELECT MIN(date), MAX(date) FROM {db_loader.PARTICIPANT_OI_TABLE}"
        ).fetchone()
        if row and row[0]:
            lo = date.fromisoformat(row[0])
            hi = date.fromisoformat(row[1])
    except Exception:
        pass                                    # table missing -> use the fallback
    if lo is None:
        hi = date.today()
        lo = months_ago(hi, 6)
    return (start or lo), (end or hi)


def refresh(conn, index: str = "NIFTY 50", start=None, end=None, timeout: float = 30.0):
    """Fetch <index> daily prices over the OI span (defaults) and store them in
    index_prices on an ALREADY-OPEN connection. Returns (inserted, skipped).

    Used by the daily OI job: call it AFTER the day's OI is loaded (so the OI
    table's max date = today, and the default range therefore reaches today) and
    BEFORE the participants-vs-NIFTY JSON is rebuilt, so the overlay has today's
    close the same night. No matplotlib, no argparse — just the fetch + store."""
    ticker = INDEX_TICKERS[index]
    s, e = resolve_range(conn, start, end)
    if s > e:
        raise ValueError(f"start ({s}) is after end ({e}).")
    result = fetch_chart(ticker, s, e, timeout=timeout)
    rows = parse_chart(result, index, ticker)
    ss, ee = s.isoformat(), e.isoformat()
    rows = [r for r in rows if ss <= r[0] <= ee]
    if not rows:
        return 0, 0
    return db_loader.store_index_prices(conn, rows)


def report_alignment(conn, symbol: str) -> None:
    """Cross-check the stored prices against the OI trading days, both ways, so a
    silently mis-aligned overlay (a session in one table but not the other) shows
    up loudly instead of at plot time."""
    price_dates = db_loader.index_dates(conn, symbol)
    try:
        oi_dates = db_loader.distinct_dates(conn, db_loader.PARTICIPANT_OI_TABLE)
    except Exception:
        oi_dates = set()
    if not oi_dates:
        log("Alignment: participant_oi is empty -- nothing to cross-check against.")
        return
    common = price_dates & oi_dates
    oi_only = sorted(oi_dates - price_dates)
    px_only = sorted(price_dates - oi_dates)
    log(f"Alignment: {len(common)} dates match participant_oi.")
    if oi_only:
        log(f"  OI days with NO price ({len(oi_only)}): {', '.join(oi_only[:10])}"
            + (" ..." if len(oi_only) > 10 else ""))
    if px_only:
        log(f"  Price days not in OI ({len(px_only)}): {', '.join(px_only[:10])}"
            + (" ..." if len(px_only) > 10 else ""))
    if not oi_only and not px_only:
        log("  Perfect 1:1 alignment with the OI table.")


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Scrape NIFTY 50 daily prices (Yahoo Finance) into nse_data.db (index_prices table).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("Examples:\n"
                "  python scraper.py\n"
                "  python scraper.py --start 2026-01-01 --end 2026-07-21\n"
                "  python scraper.py --index \"NIFTY BANK\"\n"
                "  python scraper.py --preview 10\n"))
    p.add_argument("--index", default="NIFTY 50", choices=sorted(INDEX_TICKERS),
                   help="Which index to fetch (default: NIFTY 50). Stored under this name in `symbol`.")
    p.add_argument("--start", type=parse_date,
                   help="First date YYYY-MM-DD (default: earliest date in participant_oi).")
    p.add_argument("--end", type=parse_date,
                   help="Last date YYYY-MM-DD (default: latest date in participant_oi).")
    p.add_argument("--db", default="nse_data.db", help="SQLite database (default: nse_data.db).")
    p.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout seconds (default: 30).")
    p.add_argument("--preview", type=int, default=0, metavar="N", help="Also print the first N stored rows.")
    return p


def main() -> None:
    args = build_arg_parser().parse_args()
    ticker = INDEX_TICKERS[args.index]

    conn = db_loader.connect(Path(args.db))
    try:
        start, end = resolve_range(conn, args.start, args.end)
        if start > end:
            log(f"ERROR: start ({start}) is after end ({end})."); sys.exit(1)

        log(f"Index   : {args.index}  (Yahoo ticker {ticker})")
        log(f"Range   : {start} -> {end}")
        result = fetch_chart(ticker, start, end, timeout=args.timeout)
        rows = parse_chart(result, args.index, ticker)
        # keep only rows inside the requested window (period2 padding can overshoot)
        s, e = start.isoformat(), end.isoformat()
        rows = [r for r in rows if s <= r[0] <= e]
        if not rows:
            log("ERROR: no price rows returned for that range."); sys.exit(1)

        # Heads-up if the last row is today's still-forming candle (run intraday).
        if rows[-1][0] == date.today().isoformat() and datetime.now().hour < 16:
            log(f"NOTE: {rows[-1][0]} is today -- its close may be a live (unsettled) "
                f"value until the market closes (~15:30 IST).")

        inserted, skipped = db_loader.store_index_prices(conn, rows)
        log(f"Stored  : {inserted} new row(s), {skipped} already present "
            f"({len(rows)} fetched) -> {db_loader.INDEX_PRICES_TABLE} in {Path(args.db).resolve()}")
        log(f"Prices  : {rows[0][0]} ({rows[0][5]}) -> {rows[-1][0]} ({rows[-1][5]})")

        report_alignment(conn, args.index)

        if args.preview:
            print("\n--- preview (date, symbol, open, high, low, close, volume, source) ---")
            for r in rows[:args.preview]:
                print("  ", ", ".join("" if v is None else str(v) for v in r))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
