#!/usr/bin/env python3
"""
db_loader.py
============

The DATABASE layer for the NSE data project. It READS the CSV files that
`nse_oi_scraper.py` has already saved in your archive folder and loads them into
a small local SQLite database (`nse_data.db`).

WHY A SEPARATE STEP?
--------------------
The raw CSV files in your archive folder are the permanent, untouched backup.
This module only ever *reads* those files -- it never downloads anything. That
means the database is disposable: if it ever gets corrupted, you can delete it
and rebuild the whole thing from the raw files with one command (`--load-all`).

HOW IT IS ORGANISED (so it can grow later)
------------------------------------------
- ONE SQLite file, but ONE TABLE PER REPORT TYPE. Today there is just
  `participant_oi`. When you add another NSE report later, you only add a new
  parser + a new table here -- the generic plumbing below is reused as-is.
- The generic plumbing (`connect`, `ensure_table`, `insert_or_ignore`, ...)
  knows nothing about any specific report, so it works for future tables too.
- This module deliberately uses only Python's STANDARD LIBRARY (sqlite3 + csv)
  for loading, so your daily job stays lightweight. Only the optional Excel
  export needs extra packages (pandas + openpyxl).

Run the features from the scraper's command line:
    python nse_oi_scraper.py --load-all           # bulk-load the archive
    python nse_oi_scraper.py --export-excel        # dump the table to .xlsx
    python nse_oi_scraper.py                       # daily run auto-loads new days
"""

import csv
import sqlite3
from datetime import datetime
from pathlib import Path


# --------------------------------------------------------------------------- #
# Tiny logging helper (kept local so this module does not depend on the        #
# scraper -- that avoids a circular import).                                   #
# --------------------------------------------------------------------------- #

def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


# =========================================================================== #
# SECTION 1 -- GENERIC, REUSABLE DATABASE PLUMBING                             #
# (future report types use these unchanged)                                   #
# =========================================================================== #

def connect(db_path) -> sqlite3.Connection:
    """Open the SQLite database file, creating it if it does not exist yet."""
    return sqlite3.connect(str(db_path))


def ensure_table(conn: sqlite3.Connection, ddl_sql: str) -> None:
    """Create a table if it isn't there yet. `ddl_sql` must be a
    'CREATE TABLE IF NOT EXISTS ...' statement. Safe to call every run."""
    conn.execute(ddl_sql)
    conn.commit()


def insert_or_ignore(conn: sqlite3.Connection, table: str,
                     columns: list, rows: list) -> tuple:
    """Insert many rows, skipping any that clash with an existing primary key.

    Returns (inserted, skipped). Because we use "INSERT OR IGNORE", re-loading
    the same file is harmless -- duplicates are silently skipped, which is what
    makes the whole system safe to re-run.

    Note: `table` and `columns` come from our own code constants (never from a
    downloaded file), so building the SQL text from them is safe. The actual
    values are passed separately as parameters (the '?' placeholders).
    """
    if not rows:
        return (0, 0)

    placeholders = ", ".join(["?"] * len(columns))
    column_list = ", ".join(columns)
    sql = f"INSERT OR IGNORE INTO {table} ({column_list}) VALUES ({placeholders})"

    changes_before = conn.total_changes
    conn.executemany(sql, rows)
    conn.commit()
    inserted = conn.total_changes - changes_before   # only truly-new rows count
    skipped = len(rows) - inserted
    return (inserted, skipped)


def distinct_dates(conn: sqlite3.Connection, table: str) -> set:
    """Return the set of dates ('YYYY-MM-DD') already stored in a table."""
    cursor = conn.execute(f"SELECT DISTINCT date FROM {table}")
    return {row[0] for row in cursor.fetchall()}


def latest_date(conn: sqlite3.Connection, table: str):
    """Return the most recent date stored, or None if the table is empty."""
    cursor = conn.execute(f"SELECT MAX(date) FROM {table}")
    return cursor.fetchone()[0]


# =========================================================================== #
# SECTION 2 -- THE participant_oi REPORT (table + parser + loaders)           #
# =========================================================================== #

PARTICIPANT_OI_TABLE = "participant_oi"

# The 14 numeric fields, in the exact order they appear in the CSV (after the
# first "Client Type" column). We match the CSV by these NORMALISED names, so
# the load does not depend on column order and will loudly complain if NSE ever
# changes the format.
NUMERIC_COLUMNS = [
    "future_index_long",
    "future_index_short",
    "future_stock_long",
    "future_stock_short",
    "option_index_call_long",
    "option_index_put_long",
    "option_index_call_short",
    "option_index_put_short",
    "option_stock_call_long",
    "option_stock_put_long",
    "option_stock_call_short",
    "option_stock_put_short",
    "total_long_contracts",
    "total_short_contracts",
]

# Full column list for the table / INSERT, in order.
PARTICIPANT_OI_COLUMNS = ["date", "participant_type"] + NUMERIC_COLUMNS + ["source_file"]

# The table definition. PRIMARY KEY (date, participant_type) is what makes
# re-loading safe: the same participant on the same date can only exist once.
PARTICIPANT_OI_DDL = f"""
CREATE TABLE IF NOT EXISTS {PARTICIPANT_OI_TABLE} (
    date                    TEXT NOT NULL,   -- trading date, 'YYYY-MM-DD'
    participant_type        TEXT NOT NULL,   -- Client / DII / FII / Pro / TOTAL
    future_index_long       INTEGER,
    future_index_short      INTEGER,
    future_stock_long       INTEGER,
    future_stock_short      INTEGER,
    option_index_call_long  INTEGER,
    option_index_put_long   INTEGER,
    option_index_call_short INTEGER,
    option_index_put_short  INTEGER,
    option_stock_call_long  INTEGER,
    option_stock_put_long   INTEGER,
    option_stock_call_short INTEGER,
    option_stock_put_short  INTEGER,
    total_long_contracts    INTEGER,
    total_short_contracts   INTEGER,
    source_file             TEXT,            -- which CSV this row came from
    PRIMARY KEY (date, participant_type)
);
"""

# --------------------------------------------------------------------------- #
# DATA DICTIONARY -- what each column means (all counts are "number of open    #
# contracts" held at the end of that trading day).                            #
# --------------------------------------------------------------------------- #
DATA_DICTIONARY = """
participant_oi -- daily open interest (OI) split by participant type.
Each row = one participant type on one trading date. OI = number of open
(not-yet-closed) derivative contracts held at the end of the day.

  date                     Trading date (YYYY-MM-DD).
  participant_type         Who is holding the positions:
                             Client = retail / non-institutional
                             DII    = Domestic Institutional Investors
                             FII    = Foreign Institutional Investors
                             Pro    = proprietary (brokers' own trading desks)
                             TOTAL  = sum of all the above (a check row)
  future_index_long        Long (buy) OI in INDEX futures  (e.g. NIFTY, BANKNIFTY).
  future_index_short       Short (sell) OI in index futures.
  future_stock_long        Long OI in single-STOCK futures.
  future_stock_short       Short OI in single-stock futures.
  option_index_call_long   Long OI in index CALL options.
  option_index_put_long    Long OI in index PUT options.
  option_index_call_short  Short OI in index call options.
  option_index_put_short   Short OI in index put options.
  option_stock_call_long   Long OI in stock call options.
  option_stock_put_long    Long OI in stock put options.
  option_stock_call_short  Short OI in stock call options.
  option_stock_put_short   Short OI in stock put options.
  total_long_contracts     Participant's total long OI across everything above.
  total_short_contracts    Participant's total short OI across everything above.
  source_file              The CSV file this row was loaded from (for tracing).
"""


def normalize_header(header: str) -> str:
    """Turn a messy CSV header into a clean column name.

    'Future Stock Short\\t' -> 'future_stock_short'
    'Client Type'           -> 'client_type'
    (strips spaces/tabs, lowercases, turns spaces into underscores)
    """
    cleaned = header.strip().lower()
    # collapse any run of whitespace (spaces, stray tabs) into a single '_'
    return "_".join(cleaned.split())


def date_from_filename(path) -> str:
    """'oi_2024-07-01.csv' -> '2024-07-01'. Raises ValueError if the name does
    not contain a valid date."""
    stem = Path(path).stem                 # 'oi_2024-07-01'
    date_part = stem.split("_", 1)[1] if "_" in stem else stem
    datetime.strptime(date_part, "%Y-%m-%d")   # validate; raises if wrong shape
    return date_part


def _to_int(text):
    """Convert a CSV cell to an integer. Blanks become None (NULL in the DB).
    Handles stray tabs/spaces and (just in case) thousands separators."""
    cleaned = str(text).strip().replace(",", "")
    if cleaned in ("", "-", "NA", "na", "null", "None"):
        return None
    try:
        return int(cleaned)
    except ValueError:
        # Fall back for an unexpected decimal like '123.0'
        return int(float(cleaned))


def parse_participant_oi(csv_path) -> list:
    """Read one participant-OI CSV and return a list of rows ready to insert.

    Each returned row is a tuple in PARTICIPANT_OI_COLUMNS order:
        (date, participant_type, <14 numbers>, source_file)

    Raises ValueError if the file does not look like the expected report
    (e.g. NSE changed the columns) so bad files are reported, not silently wrong.
    """
    path = Path(csv_path)
    file_date = date_from_filename(path)

    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = list(csv.reader(fh))

    if len(reader) < 3:
        raise ValueError("file has too few rows to be a valid report")

    # Row 0 is the title line; row 1 is the real header.
    header = [normalize_header(h) for h in reader[1]]
    position = {name: i for i, name in enumerate(header)}

    # Make sure every column we expect is present.
    required = ["client_type"] + NUMERIC_COLUMNS
    missing = [name for name in required if name not in position]
    if missing:
        raise ValueError(f"unexpected CSV format; missing columns: {missing}")

    rows = []
    for raw in reader[2:]:
        if not raw or not raw[position["client_type"]].strip():
            continue                       # skip blank / padding lines
        participant_type = raw[position["client_type"]].strip()
        numbers = [_to_int(raw[position[name]]) for name in NUMERIC_COLUMNS]
        rows.append(tuple([file_date, participant_type] + numbers + [path.name]))

    if not rows:
        raise ValueError("no participant rows found")
    return rows


def load_file(conn: sqlite3.Connection, csv_path) -> tuple:
    """Parse and load a single CSV. Returns (inserted, skipped)."""
    rows = parse_participant_oi(csv_path)
    return insert_or_ignore(conn, PARTICIPANT_OI_TABLE, PARTICIPANT_OI_COLUMNS, rows)


def _oi_files(data_dir) -> list:
    """All participant-OI CSVs in the archive folder, oldest name first.
    (Matches 'oi_*.csv' only -- never the volume files or the merged file.)"""
    return sorted(Path(data_dir).glob("oi_*.csv"))


def load_all(conn: sqlite3.Connection, data_dir) -> dict:
    """Bulk-load EVERY oi_*.csv in the archive folder into the DB.

    Safe to run repeatedly (rows already present are skipped). Returns a summary
    dict: files, inserted, skipped, failed (list of (filename, reason)).
    """
    ensure_table(conn, PARTICIPANT_OI_DDL)
    files = _oi_files(data_dir)
    summary = {"files": len(files), "inserted": 0, "skipped": 0, "failed": []}

    for path in files:
        try:
            inserted, skipped = load_file(conn, path)
            summary["inserted"] += inserted
            summary["skipped"] += skipped
        except Exception as exc:                       # one bad file must not stop the rest
            summary["failed"].append((path.name, str(exc)))
            log(f"  FAILED to parse {path.name}: {exc}")
    return summary


def sync_new(conn: sqlite3.Connection, data_dir) -> dict:
    """Self-healing daily load: load only the OI files whose date is NOT already
    in the DB. This catches up on any gap (e.g. laptop was off for a few days),
    not just the newest day. Returns a summary dict.
    """
    ensure_table(conn, PARTICIPANT_OI_DDL)
    already_have = distinct_dates(conn, PARTICIPANT_OI_TABLE)
    files = _oi_files(data_dir)
    summary = {"checked": len(files), "loaded_files": 0,
               "inserted": 0, "skipped": 0, "failed": []}

    for path in files:
        try:
            file_date = date_from_filename(path)
        except ValueError:
            continue                                   # oddly-named file, ignore
        if file_date in already_have:
            continue                                   # this date is already loaded

        try:
            inserted, skipped = load_file(conn, path)
            summary["loaded_files"] += 1
            summary["inserted"] += inserted
            summary["skipped"] += skipped
        except Exception as exc:
            summary["failed"].append((path.name, str(exc)))
            log(f"  FAILED to parse {path.name}: {exc}")
    return summary


# =========================================================================== #
# SECTION 3 -- ON-DEMAND EXCEL EXPORT (the DB stays the source of truth)       #
# =========================================================================== #

# =========================================================================== #
# SECTION 4 -- THE index_prices REPORT (daily index OHLCV, e.g. NIFTY 50)      #
# Populated by scraper.py (Yahoo Finance), not from CSV files. Kept here so    #
# the table lives with all the others and reuses the generic plumbing above.   #
# =========================================================================== #

INDEX_PRICES_TABLE = "index_prices"

# Column order used for the table and every INSERT.
INDEX_PRICES_COLUMNS = ["date", "symbol", "open", "high", "low", "close",
                        "volume", "source"]

# PRIMARY KEY (date, symbol) makes re-loading safe: one index can only have one
# row per trading day, so "INSERT OR IGNORE" quietly skips days we already have.
INDEX_PRICES_DDL = f"""
CREATE TABLE IF NOT EXISTS {INDEX_PRICES_TABLE} (
    date    TEXT NOT NULL,   -- trading date, 'YYYY-MM-DD' (IST)
    symbol  TEXT NOT NULL,   -- index name, e.g. 'NIFTY 50'
    open    REAL,            -- day's open  level
    high    REAL,            -- day's high  level
    low     REAL,            -- day's low   level
    close   REAL,            -- day's CLOSE level (the number we mainly want)
    volume  INTEGER,         -- index volume (often 0/None for indices)
    source  TEXT,            -- where the row came from, e.g. 'yahoo:^NSEI'
    PRIMARY KEY (date, symbol)
);
"""


def store_index_prices(conn: sqlite3.Connection, rows: list) -> tuple:
    """Create the index_prices table if needed and INSERT OR IGNORE `rows`
    (each a tuple in INDEX_PRICES_COLUMNS order). Returns (inserted, skipped)."""
    ensure_table(conn, INDEX_PRICES_DDL)
    return insert_or_ignore(conn, INDEX_PRICES_TABLE, INDEX_PRICES_COLUMNS, rows)


def index_dates(conn: sqlite3.Connection, symbol: str = None) -> set:
    """Dates already stored in index_prices (optionally for one symbol)."""
    ensure_table(conn, INDEX_PRICES_DDL)
    if symbol is None:
        cur = conn.execute(f"SELECT DISTINCT date FROM {INDEX_PRICES_TABLE}")
    else:
        cur = conn.execute(
            f"SELECT DISTINCT date FROM {INDEX_PRICES_TABLE} WHERE symbol = ?",
            (symbol,))
    return {r[0] for r in cur.fetchall()}


def export_excel(conn: sqlite3.Connection, xlsx_path, sql: str = None) -> bool:
    """Run a query (or dump the whole table) and write the result to an .xlsx.

    Excel is only an output you generate when you want it -- nothing is stored
    in Excel. Needs pandas + openpyxl (install: pip install pandas openpyxl).
    Returns True on success, False on a handled error.
    """
    try:
        import pandas as pd                            # optional dependency
    except ImportError:
        log("ERROR: --export-excel needs pandas. Install:  pip install pandas openpyxl")
        return False

    ensure_table(conn, PARTICIPANT_OI_DDL)
    if sql is None:
        sql = f"SELECT * FROM {PARTICIPANT_OI_TABLE} ORDER BY date, participant_type"

    try:
        df = pd.read_sql_query(sql, conn)
    except Exception as exc:
        log(f"ERROR: could not run the query: {exc}")
        return False

    try:
        df.to_excel(xlsx_path, index=False)            # writing .xlsx needs openpyxl
    except ImportError:
        log("ERROR: writing .xlsx needs openpyxl. Install:  pip install openpyxl")
        return False

    log(f"Exported {len(df):,} rows -> {Path(xlsx_path).resolve()}")
    return True
