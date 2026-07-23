#!/usr/bin/env python3
"""
nse_reports.py
==============

Downloads NSE daily reports OTHER than participant-wise OI, reusing the same
anti-bot machinery. Each report is one entry in the REPORTS registry below, so
adding a new one later means adding a dict -- not another scraper.

Reports available now (both are 6-month back-fillable from NSE's archive):

  fii_stats     FII Derivative Statistics.
                URL:  .../content/fo/fii_stats_16-Jul-2026.xls
                NOTE: NSE serves this as a real Excel .xls binary, NOT a CSV.
                      We store it exactly as delivered (convert at DB time).

  fo_bhavcopy   F&O UDiFF Common Bhavcopy (the official name is
                "F&O - UDiFF Common Bhavcopy Final (zip)").
                URL:  .../content/fo/BhavCopy_NSE_FO_0_0_0_20260716_F_0000.csv.zip
                NOTE: NSE serves a .zip; we extract the CSV inside and store that.

NOT here (deliberately): "FII/FPI & DII trading activity" (cash market). NSE only
publishes the latest single day for it (the fiidiiTradeReact API ignores date
params and the old archive endpoints are dead), so there is no 6-month history to
scrape. That report needs a forward-capture approach and is left for later.

Everything reuses nse_oi_scraper.NseClient (browser session + Akamai warm-up +
cloudscraper fallback) and trading_calendar (holidays + trading days).

    python nse_reports.py                       # both reports, last 6 months
    python nse_reports.py --report fii_stats
    python nse_reports.py --report fo_bhavcopy --keep-zip
    python nse_reports.py --start 2026-01-01 --end 2026-06-30
"""

import argparse
import io
import random
import sys
import time
import zipfile
from datetime import date, datetime
from pathlib import Path

import nse_oi_scraper as scraper          # NseClient, log, months_ago, parse_date
import trading_calendar as tc            # load_holidays, iter_trading_days

ARCHIVE_HOSTS = ("https://nsearchives.nseindia.com", "https://archives.nseindia.com")

# English month abbreviations -- hard-coded so the URL never depends on the
# machine's locale (strftime("%b") would give a localised name on some systems).
_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# --------------------------------------------------------------------------- #
# Validators -- tell a real file apart from an anti-bot / "file not found" page #
# --------------------------------------------------------------------------- #

def _is_error_page(raw: bytes) -> bool:
    """True if the body is clearly an HTML error/anti-bot page, not a data file."""
    head = raw[:512].lstrip().lower()
    return (head.startswith(b"<") or b"<html" in head or b"<!doctype" in head
            or b"file not found" in head or b"access denied" in head)


def validate_xls(raw: bytes) -> bool:
    """A genuine .xls: an OLE compound-file (magic D0 CF 11 E0), or at least a
    non-trivial non-HTML body (some NSE .xls files are HTML tables)."""
    if raw[:4] == b"\xd0\xcf\x11\xe0":
        return True
    return len(raw) > 512 and not _is_error_page(raw)


def validate_zip(raw: bytes) -> bool:
    """A genuine ZIP starts with the 'PK' local-file-header magic."""
    return raw[:2] == b"PK" and len(raw) > 100


# --------------------------------------------------------------------------- #
# Post-processors -- turn the downloaded bytes into what we store             #
# --------------------------------------------------------------------------- #

def store_raw(raw: bytes, day: date) -> bytes:
    """Keep the file exactly as NSE served it (used for the .xls report)."""
    return raw


def extract_csv_from_zip(raw: bytes, day: date) -> bytes:
    """Pull the single CSV out of the bhavcopy ZIP and return its bytes."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        csvs = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not csvs:
            raise ValueError(f"zip contained no CSV (has: {zf.namelist()})")
        return zf.read(csvs[0])


# --------------------------------------------------------------------------- #
# The report registry -- add a report by adding an entry here                 #
# --------------------------------------------------------------------------- #

def _fii_stats_urls(day: date) -> list:
    name = f"fii_stats_{day.day:02d}-{_MON[day.month - 1]}-{day.year}.xls"
    return [f"{host}/content/fo/{name}" for host in ARCHIVE_HOSTS]


def _fo_bhavcopy_urls(day: date) -> list:
    name = f"BhavCopy_NSE_FO_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"
    return [f"{host}/content/fo/{name}" for host in ARCHIVE_HOSTS]


REPORTS = {
    "fii_stats": {
        "label": "FII derivative statistics",
        "folder": "fii_stats_data",
        "ext": "xls",                       # stored as delivered
        "accept": "application/vnd.ms-excel,application/octet-stream,*/*",
        "urls": _fii_stats_urls,
        "validate": validate_xls,
        "process": store_raw,
    },
    "fo_bhavcopy": {
        "label": "F&O UDiFF common bhavcopy",
        "folder": "fo_bhavcopy_data",
        "ext": "csv",                       # extracted from the .zip
        "accept": "application/zip,application/octet-stream,*/*",
        "urls": _fo_bhavcopy_urls,
        "validate": validate_zip,
        "process": extract_csv_from_zip,
    },
}


# --------------------------------------------------------------------------- #
# Download loop (mirrors nse_oi_scraper.download_range, generalised)          #
# --------------------------------------------------------------------------- #

def download_report(report_key: str, start: date, end: date, out_dir: Path,
                    holidays: set, delay_min: float, delay_max: float,
                    timeout: float, force_cloudscraper: bool,
                    keep_zip: bool = False) -> dict:
    """Download one report across trading days. One file at a time, resumable,
    404 = non-trading day. Returns a summary dict."""
    spec = REPORTS[report_key]

    # For the bhavcopy, --keep-zip stores the raw .zip instead of the CSV.
    ext = "zip" if (keep_zip and report_key == "fo_bhavcopy") else spec["ext"]
    process = store_raw if (keep_zip and report_key == "fo_bhavcopy") else spec["process"]

    out_dir = Path(out_dir) if out_dir else Path(spec["folder"])
    out_dir.mkdir(parents=True, exist_ok=True)

    scraper.log(f"=== {spec['label']} ({report_key}) ===")
    scraper.log(f"Folder     : {out_dir.resolve()}")
    scraper.log(f"Date range : {start} -> {end}   (storing .{ext})")
    scraper.log("-" * 60)

    client = scraper.NseClient(timeout=timeout, use_cloudscraper=force_cloudscraper)

    saved = skipped = notfound = errors = 0
    total_bytes = 0
    try:
        for day in tc.iter_trading_days(start, end, holidays):
            target = out_dir / f"{report_key}_{day.isoformat()}.{ext}"
            if target.exists():
                skipped += 1
                continue                     # resume: never re-download

            time.sleep(random.uniform(delay_min, delay_max))   # be polite

            try:
                raw = client.fetch_url(spec["urls"](day), spec["validate"],
                                       accept=spec["accept"])
            except Exception as exc:                            # noqa: BLE001
                scraper.log(f"{day}  ERROR ({exc})")
                errors += 1
                continue

            if raw is None:
                scraper.log(f"{day}  404  (holiday / non-trading day)")
                notfound += 1
                continue

            try:
                data = process(raw, day)         # e.g. unzip -> csv bytes
            except Exception as exc:             # downloaded fine, processing failed
                scraper.log(f"{day}  ERROR (downloaded but could not process: {exc})")
                errors += 1
                continue

            target.write_bytes(data)
            total_bytes += len(data)
            scraper.log(f"{day}  SAVED -> {target.name}  ({len(data):,} bytes)")
            saved += 1
    except KeyboardInterrupt:
        scraper.log("Interrupted by user (Ctrl+C). Summary so far...")

    scraper.log("-" * 60)
    scraper.log(f"{report_key}: saved={saved}  skipped={skipped}  "
                f"not-found={notfound}  errors={errors}  "
                f"({total_bytes / 1_048_576:.1f} MB written)")
    return {"report": report_key, "saved": saved, "skipped": skipped,
            "notfound": notfound, "errors": errors, "bytes": total_bytes}


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download extra NSE daily reports (FII stats, F&O bhavcopy).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python nse_reports.py                       # both, last 6 months\n"
            "  python nse_reports.py --report fii_stats\n"
            "  python nse_reports.py --report fo_bhavcopy --keep-zip\n"
        ),
    )
    parser.add_argument("--report", choices=list(REPORTS) + ["all"], default="all",
                        help="Which report to download (default: all).")
    parser.add_argument("--start", type=scraper.parse_date,
                        help="First date YYYY-MM-DD (default: 6 months before --end).")
    parser.add_argument("--end", type=scraper.parse_date,
                        help="Last date YYYY-MM-DD (default: today).")
    parser.add_argument("--out", default=None,
                        help="Output folder (only with a single --report; "
                             "default: each report's own folder).")
    parser.add_argument("--keep-zip", action="store_true",
                        help="For fo_bhavcopy, store the raw .zip instead of the "
                             "extracted .csv (much smaller on disk).")
    parser.add_argument("--force-cloudscraper", action="store_true",
                        help="Start with cloudscraper instead of plain requests.")
    parser.add_argument("--delay-min", type=float, default=2.0,
                        help="Min seconds between downloads (default: 2).")
    parser.add_argument("--delay-max", type=float, default=4.0,
                        help="Max seconds between downloads (default: 4).")
    parser.add_argument("--timeout", type=float, default=45.0,
                        help="Per-request timeout in seconds (default: 45).")
    parser.add_argument("--holidays", type=Path, default=tc.DEFAULT_HOLIDAYS_PATH,
                        help="Holiday list (default: nse_holidays.txt next to this script).")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()

    reports = list(REPORTS) if args.report == "all" else [args.report]
    if args.out and len(reports) > 1:
        scraper.log("ERROR: --out can only be used with a single --report.")
        sys.exit(1)

    end = args.end or date.today()
    start = args.start or scraper.months_ago(end, 6)
    if start > end:
        scraper.log(f"ERROR: --start ({start}) is after --end ({end}).")
        sys.exit(1)
    if args.delay_min > args.delay_max:
        scraper.log("ERROR: --delay-min cannot be greater than --delay-max.")
        sys.exit(1)

    holidays = tc.load_holidays(args.holidays)

    summaries = []
    for key in reports:
        summaries.append(download_report(
            key, start, end, Path(args.out) if args.out else None,
            holidays, args.delay_min, args.delay_max, args.timeout,
            args.force_cloudscraper, keep_zip=args.keep_zip))
        scraper.log("")

    if len(summaries) > 1:
        scraper.log("=" * 60)
        for s in summaries:
            scraper.log(f"  {s['report']:14} saved={s['saved']}  skipped={s['skipped']}  "
                        f"404={s['notfound']}  errors={s['errors']}")


if __name__ == "__main__":
    main()
