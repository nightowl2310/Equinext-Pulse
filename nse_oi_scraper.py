#!/usr/bin/env python3
"""
nse_oi_scraper.py
=================

Download NSE's daily "Participant wise Open Interest" (OI) CSV files and build
a local archive on your own laptop -- for free, no paid APIs.

WHAT THIS DOES
--------------
NSE publishes one CSV per trading day at a URL like:

    https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_16072026.csv
                                                                      ^^^^^^^^ = DDMMYYYY

This script walks over a range of dates (default: the last 6 months), skips
weekends and known holidays, politely downloads one file at a time, and saves
each one as  oi_YYYY-MM-DD.csv  in an output folder. Re-running it only fetches
the days you are still missing.

THE MAIN OBSTACLE (and how we beat it)
--------------------------------------
NSE sits behind Akamai bot protection, so a plain request gets HTTP 403.
The trick that works from a normal home connection:
  1. Use a real browser User-Agent.
  2. First visit the NSE homepage + the reports page so Akamai gives us cookies.
  3. Ask for the CSV using those cookies PLUS a matching "Referer" header.
If that still fails, we transparently retry using the `cloudscraper` library,
which is a drop-in replacement that knows how to pass such challenges.

Run  `python nse_oi_scraper.py --help`  to see all options.
"""

import argparse
import calendar
import random
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests  # pip install requests

import db_loader  # our own sibling module -- the database layer (stdlib only)

# Which days the market trades + the holiday list. These live in their own module
# because analysis.py needs the same rules (see trading_calendar.py).
# Importing them here keeps the old names working exactly as before.
from trading_calendar import (DEFAULT_HOLIDAYS_PATH, iter_trading_days,
                              load_holidays)


# --------------------------------------------------------------------------- #
# Constants                                                                    #
# --------------------------------------------------------------------------- #

# Where the CSV files live. We try the modern CDN first, then the older host.
PRIMARY_HOST = "https://nsearchives.nseindia.com/content/nsccl/"
FALLBACK_HOST = "https://archives.nseindia.com/content/nsccl/"

# Pages we visit purely to collect Akamai cookies before asking for a CSV.
HOME_URL = "https://www.nseindia.com"
REPORTS_URL = "https://www.nseindia.com/all-reports-derivatives"

# Headers that make us look like a normal Chrome browser on Windows.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    # NOTE: we intentionally do NOT set "Accept-Encoding" ourselves. requests
    # advertises only the compressions it can actually decode (gzip/deflate,
    # plus brotli only if the 'brotli' package is installed). Hard-coding "br"
    # here would risk getting a brotli body we can't decode.
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# Retry behaviour when a request is blocked (403) or looks wrong.
MAX_ATTEMPTS = 4        # total tries per file before we give up
ESCALATE_AFTER = 2      # after this many failed tries, switch to cloudscraper
BACKOFF_BASE = 3.0      # seconds; the wait grows with each failed attempt


# --------------------------------------------------------------------------- #
# Tiny logging helper -- prints a timestamped line so progress is easy to read #
# --------------------------------------------------------------------------- #

def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


# --------------------------------------------------------------------------- #
# Date helpers                                                                 #
# --------------------------------------------------------------------------- #

def months_ago(reference: date, n: int) -> date:
    """Return the date `n` calendar months before `reference`.

    Example: months_ago(2026-07-16, 6) -> 2026-01-16.
    We clamp the day so that e.g. 6 months before 31-Aug still lands on a
    real date in February.
    """
    month = reference.month - n
    year = reference.year
    while month <= 0:          # wrap backwards across year boundaries
        month += 12
        year -= 1
    last_day_of_month = calendar.monthrange(year, month)[1]
    day = min(reference.day, last_day_of_month)
    return date(year, month, day)


# NOTE: `load_holidays` and `iter_trading_days` used to live here. They moved to
# trading_calendar.py so analysis.py can share the exact same rules, and are
# imported at the top of this file -- so they are still available as
# nse_oi_scraper.load_holidays / .iter_trading_days, unchanged.


# --------------------------------------------------------------------------- #
# Content check -- make sure we actually got a CSV, not an anti-bot page       #
# --------------------------------------------------------------------------- #

def content_looks_like_csv(raw: bytes) -> bool:
    """NSE sometimes returns an HTML 'Access Denied' page with a 200 status.
    We only trust the response if it looks like the real report: a small text
    body that is not HTML and mentions the 'Client' participant row/column.
    """
    text = raw[:2000].decode("utf-8", errors="ignore").lower()
    if not text.strip():
        return False
    bad_markers = ("<html", "<!doctype", "access denied",
                   "request unsuccessful", "akamai")
    if any(marker in text for marker in bad_markers):
        return False
    # The genuine file always contains a "Client" participant line.
    return "client" in text


# --------------------------------------------------------------------------- #
# The HTTP client -- manages the session, warm-up, and cloudscraper fallback  #
# --------------------------------------------------------------------------- #

class NseClient:
    """Wraps a browser-like HTTP client and knows how to recover from blocks."""

    def __init__(self, timeout: float, use_cloudscraper: bool = False):
        self.timeout = timeout
        self.using_cloudscraper = False
        self.client = None
        self._build(use_cloudscraper)

    # -- setup ------------------------------------------------------------- #

    def _build(self, use_cloudscraper: bool) -> None:
        """Create (or recreate) the underlying client and warm it up."""
        if use_cloudscraper:
            import cloudscraper  # pip install cloudscraper (imported only if needed)
            log("Using cloudscraper to get past bot protection...")
            self.client = cloudscraper.create_scraper(
                browser={"browser": "chrome", "platform": "windows", "mobile": False}
            )
            self.using_cloudscraper = True
        else:
            session = requests.Session()
            session.headers.update(BROWSER_HEADERS)
            self.client = session
            self.using_cloudscraper = False
        self.warm_up()

    def warm_up(self) -> None:
        """Visit NSE's homepage and reports page to collect fresh cookies.
        Failing here is not fatal -- the CSV request may still work, or we
        will escalate on the next attempt.
        """
        try:
            self.client.get(HOME_URL, timeout=self.timeout)
            self.client.get(REPORTS_URL, timeout=self.timeout)
        except requests.RequestException as exc:
            log(f"NOTE: warm-up request failed ({exc}); continuing anyway.")

    def escalate_to_cloudscraper(self) -> None:
        """Switch from plain requests to cloudscraper (once)."""
        if not self.using_cloudscraper:
            self._build(use_cloudscraper=True)

    # -- one raw GET ------------------------------------------------------- #

    def _get_one(self, url: str, headers: dict, validate):
        """Try a single URL. `validate(bytes) -> bool` decides whether a 200
        body is the real file or an anti-bot/error page. Returns one of:
            ("ok", bytes)       -> a valid body
            ("notfound", None)  -> HTTP 404, the file is not on this host
            ("blocked", reason) -> bot protection / body failed validation
            ("error", reason)   -> network problem or unexpected status
        """
        try:
            resp = self.client.get(url, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:
            return ("error", f"network error: {exc}")

        if resp.status_code == 404:
            return ("notfound", None)
        if resp.status_code == 200:
            if validate(resp.content):
                return ("ok", resp.content)
            return ("blocked", "got an HTML/anti-bot page instead of the file")
        if resp.status_code in (401, 403):
            return ("blocked", f"HTTP {resp.status_code} (bot protection)")
        return ("error", f"unexpected HTTP {resp.status_code}")

    # -- fetch one file, given candidate URLs (retries + host fallback) ---- #

    def fetch_url(self, urls, validate=None, accept="text/csv,application/octet-stream,*/*",
                  referer: str = REPORTS_URL):
        """Download the first of `urls` that works. GENERIC -- any NSE report
        can use this, not just participant OI. `validate(bytes) -> bool` guards
        against anti-bot pages (defaults to the CSV check).

        Returns the file bytes on success, None if every host 404s (treated as
        a non-trading day), or raises RuntimeError if blocked after all retries.
        """
        if validate is None:
            validate = content_looks_like_csv
        headers = {"Referer": referer, "Accept": accept}

        last_reason = "unknown error"
        for attempt in range(1, MAX_ATTEMPTS + 1):
            all_hosts_404 = True
            for url in urls:
                kind, payload = self._get_one(url, headers, validate)
                if kind == "ok":
                    return payload
                if kind == "notfound":
                    continue                 # maybe the other host has it
                # kind is "blocked" or "error" -> stop trying hosts, go recover
                all_hosts_404 = False
                last_reason = payload
                break

            if all_hosts_404:
                return None                  # every host said 404 -> not a trading day

            # We were blocked or errored. Recover before the next attempt.
            if attempt < MAX_ATTEMPTS:
                self._recover(attempt, last_reason)

        raise RuntimeError(last_reason)

    def fetch(self, day: date, want_vol: bool):
        """Download the participant OI (or volume) report for `day`.
        Thin wrapper over fetch_url() with the participant-file URL pattern."""
        stem = "fao_participant_vol_" if want_vol else "fao_participant_oi_"
        filename = f"{stem}{day:%d%m%Y}.csv"
        urls = [PRIMARY_HOST + filename, FALLBACK_HOST + filename]
        return self.fetch_url(urls, content_looks_like_csv)

    def _recover(self, attempt: int, reason: str) -> None:
        """Between failed attempts: re-warm cookies, and after a couple of
        tries switch to cloudscraper. Then wait a bit (growing backoff)."""
        log(f"  attempt {attempt} blocked ({reason}); recovering...")
        if not self.using_cloudscraper and attempt >= ESCALATE_AFTER:
            self.escalate_to_cloudscraper()
        else:
            self.warm_up()
        wait = BACKOFF_BASE * attempt + random.uniform(0, 1)
        time.sleep(wait)


# --------------------------------------------------------------------------- #
# Main download loop                                                           #
# --------------------------------------------------------------------------- #

def download_range(start: date, end: date, out_dir: Path, want_vol: bool,
                   holidays: set, delay_min: float, delay_max: float,
                   timeout: float, force_cloudscraper: bool) -> None:
    """Walk trading days and download whatever is missing, one file at a time."""

    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = "vol_" if want_vol else "oi_"
    label = "volume" if want_vol else "open interest"

    log(f"Archive folder : {out_dir.resolve()}")
    log(f"Report type    : participant-wise {label}")
    log(f"Date range     : {start} -> {end}")
    log(f"Holidays loaded: {len(holidays)}")
    log("-" * 60)

    client = NseClient(timeout=timeout, use_cloudscraper=force_cloudscraper)

    saved = skipped = notfound = errors = 0
    try:
        for day in iter_trading_days(start, end, holidays):
            target = out_dir / f"{prefix}{day.isoformat()}.csv"

            # Resume support: never re-download a file we already have.
            if target.exists():
                log(f"{day}  SKIP (already downloaded)")
                skipped += 1
                continue

            # Be polite: pause before every network request.
            time.sleep(random.uniform(delay_min, delay_max))

            try:
                data = client.fetch(day, want_vol)
            except Exception as exc:                      # noqa: BLE001 (show any failure)
                log(f"{day}  ERROR ({exc})")
                errors += 1
                continue

            if data is None:
                log(f"{day}  404  (holiday / non-trading day)")
                notfound += 1
                continue

            target.write_bytes(data)
            log(f"{day}  SAVED -> {target.name}  ({len(data):,} bytes)")
            saved += 1

    except KeyboardInterrupt:
        log("Interrupted by user (Ctrl+C). Showing summary so far...")

    log("-" * 60)
    log(f"Done. saved={saved}  skipped={skipped}  "
        f"not-found={notfound}  errors={errors}")
    if errors:
        log("Some days errored (likely persistent blocking). Re-run later to "
            "retry just those days -- already-saved files are kept.")


# --------------------------------------------------------------------------- #
# Optional bonus: merge every downloaded CSV into one combined file            #
# --------------------------------------------------------------------------- #

def merge_folder(out_dir: Path, want_vol: bool) -> None:
    """Combine all downloaded CSVs into one file with an added `date` column."""
    try:
        import pandas as pd  # pip install pandas (only needed for --merge)
    except ImportError:
        log("ERROR: --merge needs pandas. Install it with:  pip install pandas")
        sys.exit(1)

    prefix = "vol_" if want_vol else "oi_"
    kind = "vol" if want_vol else "oi"
    files = sorted(out_dir.glob(f"{prefix}*.csv"))
    if not files:
        log(f"No '{prefix}*.csv' files found in {out_dir.resolve()} -- "
            "download some first.")
        return

    frames = []
    for path in files:
        # Filename is like  oi_2026-07-16.csv  -> pull out the date part.
        date_str = path.stem.split("_", 1)[1]
        try:
            file_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            log(f"  skipping oddly-named file: {path.name}")
            continue

        # Row 0 is a title line; the REAL header is on row 1, so skiprows=1.
        df = pd.read_csv(path, skiprows=1)
        df.columns = [str(c).strip() for c in df.columns]  # tidy header spaces
        df.insert(0, "date", file_date)                    # add date as 1st column
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)
    out_path = out_dir / f"combined_participant_{kind}.csv"
    combined.to_csv(out_path, index=False)
    log(f"Merged {len(frames)} files ({len(combined):,} rows) -> "
        f"{out_path.resolve()}")


# --------------------------------------------------------------------------- #
# Command-line interface                                                       #
# --------------------------------------------------------------------------- #

def parse_date(text: str) -> date:
    """Turn a 'YYYY-MM-DD' string from the command line into a date object."""
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"date must look like 2026-07-16, got {text!r}")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download NSE participant-wise Open Interest CSVs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python nse_oi_scraper.py                       # download + auto-update DB\n"
            "  python nse_oi_scraper.py --start 2026-01-01 --end 2026-07-16\n"
            "  python nse_oi_scraper.py --out my_folder --vol\n"
            "  python nse_oi_scraper.py --no-db               # download only, skip DB\n"
            "  python nse_oi_scraper.py --load-all            # (re)build DB from all files\n"
            "  python nse_oi_scraper.py --export-excel        # dump DB table to .xlsx\n"
            "  python nse_oi_scraper.py --merge\n"
            "  python nse_oi_scraper.py --force-cloudscraper\n"
        ),
    )
    parser.add_argument("--start", type=parse_date,
                        help="First date, YYYY-MM-DD (default: 6 months before --end).")
    parser.add_argument("--end", type=parse_date,
                        help="Last date, YYYY-MM-DD (default: today).")
    parser.add_argument("--out", default="nse_oi_data",
                        help="Output folder (default: nse_oi_data).")
    parser.add_argument("--vol", action="store_true",
                        help="Download the participant VOLUME files instead of OI.")
    parser.add_argument("--merge", action="store_true",
                        help="Merge already-downloaded CSVs into one combined file, then exit.")
    parser.add_argument("--force-cloudscraper", action="store_true",
                        help="Start with cloudscraper instead of plain requests.")

    # -- database options ------------------------------------------------- #
    parser.add_argument("--db", default="nse_data.db",
                        help="SQLite database file (default: nse_data.db).")
    parser.add_argument("--no-db", action="store_true",
                        help="After downloading, do NOT update the database.")
    parser.add_argument("--load-all", action="store_true",
                        help="Load every CSV in the archive into the DB, then exit "
                             "(safe to re-run; rebuilds the DB from your raw files).")
    parser.add_argument("--export-excel", nargs="?", const="nse_participant_oi.xlsx",
                        default=None, metavar="PATH",
                        help="Export the DB to an .xlsx file, then exit "
                             "(default file: nse_participant_oi.xlsx).")
    parser.add_argument("--sql", default=None,
                        help="Custom SQL query to run for --export-excel "
                             "(default: dump the whole participant_oi table).")
    parser.add_argument("--no-analysis", action="store_true",
                        help="After the DB update, do NOT print the daily movers.")
    parser.add_argument("--delay-min", type=float, default=2.0,
                        help="Minimum seconds to wait between downloads (default: 2).")
    parser.add_argument("--delay-max", type=float, default=4.0,
                        help="Maximum seconds to wait between downloads (default: 4).")
    parser.add_argument("--timeout", type=float, default=30.0,
                        help="Per-request timeout in seconds (default: 30).")
    parser.add_argument("--holidays", type=Path, default=DEFAULT_HOLIDAYS_PATH,
                        help="Path to the holiday list (default: nse_holidays.txt next to this script).")
    return parser


def load_all_into_db(db_path: Path, out_dir: Path) -> None:
    """Standalone --load-all: (re)build the DB from every CSV in the archive."""
    log(f"Loading archive '{out_dir}' into database '{db_path.resolve()}'...")
    conn = db_loader.connect(db_path)
    try:
        summary = db_loader.load_all(conn, out_dir)
    finally:
        conn.close()
    log("-" * 60)
    log(f"--load-all done. files={summary['files']}  "
        f"inserted={summary['inserted']}  skipped={summary['skipped']}  "
        f"failed={len(summary['failed'])}")
    for name, reason in summary["failed"]:
        log(f"  could not parse {name}: {reason}")


def update_db_after_download(db_path: Path, out_dir: Path) -> None:
    """Load any newly-downloaded / previously-missing OI files into the DB.
    Reads the saved CSV files from disk -- never the network."""
    log("-" * 60)
    log(f"Updating database: {db_path.resolve()}")
    conn = db_loader.connect(db_path)
    try:
        summary = db_loader.sync_new(conn, out_dir)
    finally:
        conn.close()
    log(f"DB update: loaded {summary['loaded_files']} new file(s), "
        f"inserted {summary['inserted']} row(s), skipped {summary['skipped']}.")
    for name, reason in summary["failed"]:
        log(f"  could not parse {name}: {reason}")


def print_daily_movers(db_path: Path, holidays_path: Path) -> None:
    """After the DB is updated: print today's brief, then refresh the JSON the
    Equinext Pulse dashboard reads. Imported here (not at the top) so the
    download path never depends on it."""
    import analysis

    conn = db_loader.connect(db_path)
    try:
        holidays = load_holidays(holidays_path)
        report = analysis.build_report(conn, kinds=("daily",), holidays=holidays)
        print()
        print(analysis.format_report(report))

        # Refresh the dashboard's data files so the page shows today's brief.
        try:
            written = analysis.export_dashboard(conn, holidays=holidays)
            log(f"Dashboard data refreshed: {len(written)} file(s) in "
                f"{written[0].parent}")
        except Exception as exc:         # never let the dashboard break the job
            log(f"Could not refresh dashboard data: {exc}")

        # Refresh the Participant Wise Report JSON alongside the others. This one
        # file also backs the frontend "dossier" (net levels + one-day changes).
        try:
            import participant_report
            p = participant_report.export(conn)
            log(f"Participant report refreshed: {p}")
        except Exception as exc:         # never let this break the job either
            log(f"Could not refresh participant report: {exc}")

        # Refresh the NIFTY 50 spot (index_prices) FIRST, so the overlay JSON below
        # has today's close. The OI is already loaded, so index_prices' default range
        # now reaches today. Yahoo Finance, read-only join later; no matplotlib.
        try:
            import scraper
            ins, skp = scraper.refresh(conn)
            log(f"NIFTY 50 prices refreshed: +{ins} new, {skp} already present")
        except Exception as exc:         # a price hiccup must not break the OI job
            log(f"Could not refresh NIFTY 50 prices: {exc}")

        # Refresh participants_vs_nifty.json (the "NIFTY vs All Participants"
        # section: all four participants' net futures/calls/puts vs NIFTY close).
        try:
            import plot_fii_vs_nifty
            pv = plot_fii_vs_nifty.export(conn)
            log(f"Participants-vs-NIFTY refreshed: {pv}")
        except Exception as exc:         # never let this break the job either
            log(f"Could not refresh participants-vs-NIFTY: {exc}")

    except ValueError as exc:            # e.g. empty DB -- not worth crashing over
        log(f"Skipping analysis: {exc}")
    finally:
        conn.close()


def main() -> None:
    args = build_arg_parser().parse_args()
    out_dir = Path(args.out)
    db_path = Path(args.db)

    # --- Standalone actions: do one thing and exit (no downloading) --------- #

    # --merge: combine the raw CSVs into one flat file.
    if args.merge:
        merge_folder(out_dir, args.vol)
        return

    # --load-all: (re)build the database from the raw files.
    if args.load_all:
        load_all_into_db(db_path, out_dir)
        return

    # --export-excel: dump the DB (or a custom query) to an .xlsx.
    if args.export_excel is not None:
        conn = db_loader.connect(db_path)
        try:
            ok = db_loader.export_excel(conn, args.export_excel, sql=args.sql)
        finally:
            conn.close()
        if not ok:
            sys.exit(1)
        return

    # --- Normal daily action: download, then auto-update the DB ------------- #

    # Work out the date range (default = last 6 months up to today).
    end = args.end or date.today()
    start = args.start or months_ago(end, 6)
    if start > end:
        log(f"ERROR: --start ({start}) is after --end ({end}).")
        sys.exit(1)
    if args.delay_min > args.delay_max:
        log("ERROR: --delay-min cannot be greater than --delay-max.")
        sys.exit(1)

    holidays = load_holidays(args.holidays)

    download_range(
        start=start,
        end=end,
        out_dir=out_dir,
        want_vol=args.vol,
        holidays=holidays,
        delay_min=args.delay_min,
        delay_max=args.delay_max,
        timeout=args.timeout,
        force_cloudscraper=args.force_cloudscraper,
    )

    # Then load the fresh files into the database (unless told not to).
    if args.no_db:
        log("Skipping database update (--no-db).")
    elif args.vol:
        # The DB currently only holds the OI report, not the volume files.
        log("Note: --vol downloads volume files; the database is OI-only, so "
            "skipping the DB update.")
    else:
        update_db_after_download(db_path, out_dir)
        # ...and then show today's biggest movers straight away.
        if not args.no_analysis:
            print_daily_movers(db_path, args.holidays)


if __name__ == "__main__":
    main()
