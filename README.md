# NSE Participant-wise Open Interest (OI) Scraper + Database

A small, free toolkit that (1) downloads NSE's daily **"Participant wise Open
Interest"** CSV files onto your own laptop, and (2) loads them into a local
**SQLite database** you can query. No paid APIs, no cloud — just `requests`
(with a `cloudscraper` fallback) on your home internet connection.

Each trading day, NSE publishes one CSV showing open interest split by
participant type — **Client, DII, FII, Pro, TOTAL** — across index/stock
futures and options. This tool archives those files and makes them queryable.

**Two layers, kept separate on purpose:**
- **The raw CSV files** in `nse_oi_data/` are your permanent, untouched backup.
- **The database** `nse_data.db` is built *from* those files. It never downloads
  anything itself, so you can always delete and rebuild it from the raw files.

---

## 0. Clone & run from scratch (new machine / after you forget)

> The repo ships **source + the dashboard's JSON** — but **not** `nse_data.db`, the
> raw scraped archives (`nse_oi_data/`, `fo_bhavcopy_data/`, `fii_stats_data/`), or
> `node_modules/`/`dist/` (all `.gitignore`d). You rebuild those locally. Prereqs:
> **Python 3.9+** and **Node 18+**.

```bash
# 1. Get the code
git clone <your-repo-url>
cd 8am                       # or whatever the folder is named

# 2. Python side — deps, then scrape NSE and build the SQLite DB
pip install -r requirements.txt
python nse_oi_scraper.py     # downloads ~6 months of OI, builds nse_data.db, prints the brief
#   (optional analysis extras: pip install pandas openpyxl)

# 3. Emit the dashboard's data files from the DB
python analysis.py --export-dashboard        # writes frontend/public/data/{daily,weekly,monthly}.json
python plot_fii_vs_nifty.py                  # writes fii_vs_nifty.json + participants_vs_nifty.json (+ PNG)
python participant_report.py                 # writes participant_report.json
python export_tuesday_summary.py             # writes the weekly-comparison JSON

# 4. Frontend — install and run
cd frontend
npm install
npm run dev                  # dev server (Vite) — open the printed localhost URL
# or: npm run build          # production build into frontend/dist/
```

**Faster path if you already have `nse_data.db`** (e.g. copied from another machine):
drop it in the project root and skip step 2's scrape — just run step 3 to refresh the
JSON, then step 4. The daily job (`python nse_oi_scraper.py`, or `run_daily.bat`)
re-runs steps 2–3 together and keeps everything fresh.

> **Note:** `frontend/public/data/*.json` **is** committed, so `npm run dev` shows a
> working dashboard immediately after `git clone` — but the numbers are frozen at the
> last commit until you re-run steps 2–3 against fresh data.

---

## 1. Setup (one time)

You need Python 3.9+ installed. Then, from this folder:

```bash
pip install -r requirements.txt
```

That installs `requests` and `cloudscraper`. The database uses Python's built-in
`sqlite3` — **nothing extra to install**. The optional `--merge` and
`--export-excel` features need `pandas` (and `openpyxl` for Excel):
`pip install pandas openpyxl`.

---

## 2. Basic usage

Download the **last 6 months** of OI files into `nse_oi_data/` **and load them
into the database**:

```bash
python nse_oi_scraper.py
```

You'll see live progress like:

```
[18:20:01] 2026-07-14  SAVED -> oi_2026-07-14.csv  (12,033 bytes)
[18:20:05] 2026-07-15  SAVED -> oi_2026-07-15.csv  (12,110 bytes)
[18:20:05] 2026-07-16  404  (holiday / non-trading day)
...
[18:31:12] Done. saved=118  skipped=0  not-found=6  errors=0
------------------------------------------------------------
[18:31:12] Updating database: C:\...\nse_data.db
[18:31:13] DB update: loaded 118 new file(s), inserted 590 row(s), skipped 0.
```

**It is resumable.** Run it again any time — already-downloaded files are
skipped, and the database only loads days it doesn't already have.

Use `--no-db` if you want to download **without** touching the database.

---

## 3. Common commands

| Goal | Command |
|------|---------|
| Download + update DB + print today's brief (default) | `python nse_oi_scraper.py` |
| A specific date range | `python nse_oi_scraper.py --start 2026-01-01 --end 2026-07-16` |
| Download only, skip the database | `python nse_oi_scraper.py --no-db` |
| Download + DB, but no brief | `python nse_oi_scraper.py --no-analysis` |
| (Re)build the DB from all saved files | `python nse_oi_scraper.py --load-all` |
| **The brief (daily / weekly / monthly)** | `python analysis.py --all` |
| **Check the holiday list against the data** | `python analysis.py --check-calendar` |
| Export the DB to Excel | `python nse_oi_scraper.py --export-excel` |
| Merge saved CSVs into one flat CSV | `python nse_oi_scraper.py --merge` |
| Download **volume** files instead of OI | `python nse_oi_scraper.py --vol` |
| If plain requests keeps getting blocked | `python nse_oi_scraper.py --force-cloudscraper` |

See every option with `python nse_oi_scraper.py --help` (or
`python analysis.py --help`). Other flags: `--out` (archive folder), `--db`
(database file), `--sql` (custom query for export), `--delay-min` /
`--delay-max`, `--timeout`, `--holidays`.

---

## 4. The database (`nse_data.db`)

One SQLite file, with **one table per report type**. Right now there is a single
table, `participant_oi` — one row per **(date, participant_type)**, with a
column for each OI field in the CSV. (More NSE reports can be added as their own
tables later without disturbing this one.)

- **Automatic daily update:** a normal run (section 2) loads any new or
  previously-missed days into the DB right after downloading. It's
  *self-healing* — if your laptop was off for a few days, the next run downloads
  those days and loads all of them, not just the newest.
- **Bulk load / rebuild:** `python nse_oi_scraper.py --load-all` scans the whole
  archive and loads everything. It's safe to run repeatedly — rows already in
  the DB are skipped (never duplicated). It prints a summary of files found,
  rows inserted, rows skipped, and any files that failed to parse.
- **Rebuild from scratch:** because the DB is built only from the raw files, you
  can delete `nse_data.db`, run `--load-all`, and get an identical database
  back. The CSV files are the source of truth.

The database keeps **all history** and never auto-deletes anything.

> Dates are stored as text in `YYYY-MM-DD` form (e.g. `2026-07-16`). This sorts
> correctly and works with SQLite's date functions.

---

## 5. Exploring the data with SQL

Three easy ways to run queries:

- **DB Browser for SQLite** — a free, beginner-friendly graphical app
  (https://sqlitebrowser.org). Open `nse_data.db` and use the "Execute SQL" tab.
- **Command line** (if the `sqlite3` tool is installed):
  `sqlite3 nse_data.db "SELECT ... ;"`
- **Python:** `sqlite3.connect("nse_data.db")` then run a query.

### Example queries

**1) FII index-futures OI trend over time**
```sql
SELECT date, future_index_long, future_index_short
FROM participant_oi
WHERE participant_type = 'FII'
ORDER BY date;
```

**2) FII vs DII net futures position by date** (net = long − short, index + stock;
a positive number means net long / bullish, negative means net short / bearish)
```sql
SELECT date, participant_type,
       (future_index_long + future_stock_long)
     - (future_index_short + future_stock_short) AS net_futures
FROM participant_oi
WHERE participant_type IN ('FII', 'DII')
ORDER BY date, participant_type;
```

**3) The most recent day's full snapshot**
```sql
SELECT *
FROM participant_oi
WHERE date = (SELECT MAX(date) FROM participant_oi);
```

> Tip: the `TOTAL` rows are the sum of Client + DII + FII + Pro. Add
> `AND participant_type != 'TOTAL'` when you only want the individual players.

---

## 6. Data dictionary

Every value is a count of **open contracts** held at the end of that trading day.

| Column | Meaning |
|--------|---------|
| `date` | Trading date (`YYYY-MM-DD`). |
| `participant_type` | `Client` (retail), `DII` (domestic institutions), `FII` (foreign institutions), `Pro` (brokers' own desks), `TOTAL` (sum of all). |
| `future_index_long` / `future_index_short` | Long / short OI in **index** futures (NIFTY, BANKNIFTY, …). |
| `future_stock_long` / `future_stock_short` | Long / short OI in single-**stock** futures. |
| `option_index_call_long` / `option_index_call_short` | Long / short OI in index **call** options. |
| `option_index_put_long` / `option_index_put_short` | Long / short OI in index **put** options. |
| `option_stock_call_long` / `option_stock_call_short` | Long / short OI in stock **call** options. |
| `option_stock_put_long` / `option_stock_put_short` | Long / short OI in stock **put** options. |
| `total_long_contracts` / `total_short_contracts` | Participant's total long / short OI across everything above. |
| `source_file` | The CSV this row was loaded from (for tracing). |

(A fuller version lives in the comments at the top of `db_loader.py`.)

---

## 7. The brief — who moved, and what it adds up to

`analysis.py` reads the database (never the CSVs) and prints a short **brief**:
a headline, what each player did, and a directional read.

```bash
python analysis.py                    # all three briefs
python analysis.py --daily            # the primary one
python analysis.py --weekly --as-of 2026-04-02
python analysis.py --all --json       # structured JSON instead of text
```

```
NSE PARTICIPANT OI -- DAILY BRIEF
2026-07-15 [Wed]  vs  2026-07-14 [Tue]
==============================================================================
HEADLINE: Pro adding index call longs +163,663 contracts (+22.8%)

Pro
    book:                    long +324,935 (+7.0%)  |  short +292,822 (+6.8%)
    Option Index Call Long    716,728 ->   880,391   +163,663   +22.8%   adding index call longs
FII
    book:                    long +117,153 (+2.1%)  |  short +195,474 (+3.9%)
    Option Index Put Long     815,790 ->   894,399    +78,609    +9.6%   adding index put longs
DII  (shown for coverage)
    ...
READ: NEUTRAL tilt   (score -0.04 on a -1 bearish .. +1 bullish scale)
Action: Index positioning showed no clear lean ...
Positioning read only - not investment advice.
```

### How moves are selected

**Absolute change (contracts) is the only selector.** Open interest is a
quantity, so size is what matters. The **% is printed alongside as context** —
it never decides what appears. (A move of 154 → 274 contracts is +77.9%, which
would top any percentage list, but it's only +120 contracts — noise beside a
+493,863 move.) When a value starts at **0**, the % shows **`N/A`**, never
"infinity".

It is **not a leaderboard** — there are no rankings. Lines are grouped by
**actor** so the brief reads like "here's what each player did".

> The `total_*` columns are **sums** of the other fields, so they'd always be the
> biggest numbers and every line would just say "their book grew". They're kept
> out of the selection and shown as each actor's **`book:`** context line
> instead. Use `--include-totals` to rank them anyway.

### Which actors appear (the 3-actor rule)

- **FII, DII and Pro always appear** (`BASE_ACTORS`). If the biggest moves all
  belong to one or two of them, each missing actor's **own biggest move** is
  pulled in — marked *"(shown for coverage)"*. This is the only reason DII is
  ever visible: its typical daily move is ~40,000 contracts against Client's
  ~960,000, so it can never win a contest decided purely by size.
- **Client only appears when it moves notably _for itself_** — an extra actor on
  top of the base three, never a replacement. This has to be a **deviation**,
  not a fixed number: Client clears any sensible fixed threshold on ~99% of
  days. So its biggest move is compared with its *own* median move over the same
  horizon, and it must be `EXTRA_ACTOR_DEVIATION`× bigger (default 1.5×). In
  practice it shows up on about **25%** of days. When it sits out, the brief says
  why.

### The directional read

The brief ends with a **bearish / neutral / bullish tilt**, worked out by rules
from the actual numbers:

- Only **index** instruments count — they're what express a view on market
  direction. Single-stock positions and the `total_*` aggregates are excluded
  (the totals would double-count).
- Each move leans bullish or bearish by what it is: buying index futures or
  calls, or writing puts = bullish; selling futures, writing calls, or buying
  puts = bearish.
- Each is weighted by the actor (`FII` 1.0, `Pro` 0.6, `DII` 0.4) and by the size
  of the move. **Client is deliberately excluded from the read**: for every long
  there's a short, so the crowd is largely the other side of these same trades —
  counting both sides would just cancel out.
- `score = sum(weight × lean × change) / sum(weight × |change|)`, giving −1
  (fully bearish) to +1 (fully bullish). Inside ±`TILT_THRESHOLD` it's called
  **neutral** — which is the honest answer on most days (positioning really is
  balanced; across this archive the median score is ~0.00 and only ~18% of days
  earn a call).

**This is a positioning read, not advice.** Every brief carries the line
*"Positioning read only - not investment advice."* Nothing is invented — each
signal points at a real number in the data.

### Tuning it

At the top of `analysis.py`:

| Setting | Default | Meaning |
|---|---|---|
| `TARGET_LINES` | `6` | how many moves to aim for (coverage may push to 7–8) |
| `MIN_ACTORS` | `3` | base actors that must always appear |
| `EXTRA_ACTOR_DEVIATION` | `1.5` | how many × its own normal an extra actor must move |
| `MIN_ABS_CHANGE` | `1000` | noise floor, in contracts |
| `TILT_THRESHOLD` | `0.25` | how lopsided before a direction is called |
| `MAX_LINES_PER_ACTOR` | `None` | optional cap; off, so absolute stays the sole selector |
| `EXCLUDE_TOTAL_FIELDS` | `True` | keep the `total_*` sums out of the selection |

Or per-run: `--lines 8`, `--min-actors 4`, `--deviation 2.0`, `--min-abs 5000`,
`--max-per-actor 2`, `--include-totals`.

### How the expiry dates are worked out (important)

NSE F&O expires on a **Thursday** — but if that Thursday is a holiday, the
exchange moves expiry **back to the previous trading day**. So this tool does
*not* just assume "Thursday": it loads `nse_holidays.txt` and computes the real
expiry.

This is not hypothetical — in your own archive, **Thursday 2026-03-26** and
**Thursday 2026-05-28** were holidays, so those weeks expired on the Wednesday:

```bash
python analysis.py --weekly --as-of 2026-04-02
# WEEKLY (2026-04-02 [Thu] vs 2026-03-25 [Wed])  [expiry]
#   * Expiry moved from Thu 2026-03-26 to 2026-03-25 because 2026-03-26 was a holiday.
```

The expiry weekday is a single constant — `EXPIRY_WEEKDAY` in
`trading_calendar.py` (Thursday = 3) — so if the exchange ever changes the rule,
edit that one number.

**Because every expiry date depends on the holiday list being correct**, check it
any time against the downloaded data:

```bash
python analysis.py --check-calendar
```

The data is the ground truth (no file published = no trading), so this flags both
holidays you're missing *and* — more dangerously — any date wrongly listed as a
holiday that is really a trading day.

### Automatic in the daily job

A normal `python nse_oi_scraper.py` run now downloads → updates the DB → **prints
the daily brief**. Use `--no-analysis` to skip that last step.

---

## 8. The dashboard (Equinext Pulse)

`frontend/` is a single-page React dashboard (Vite + React 18 + Tailwind). It does
**no maths**: it just fetches JSON that `analysis.py` writes.

```bash
python analysis.py --export-dashboard    # writes frontend/public/data/*.json
cd frontend && npm install && npm run dev
```

The normal daily run refreshes those files automatically (after the DB update),
so the page always shows the latest brief. `--no-analysis` skips it.

### How it loads

Vite serves `frontend/public/` at the site root, so the page fetches
`/data/daily.json`, `/data/weekly.json`, `/data/monthly.json` — one file per tab,
Daily by default. **No API server and no extra dependency**: that's the whole
reason for static files rather than a backend endpoint.

### Data contract

One object per file. All naming is translated in exactly one place —
`to_dashboard_payload()` in `analysis.py` — so the browser never has to know that
the engine calls things `abs_change` / `behaviour` / `included_by` / `leans`.

```jsonc
{
  "timeframe": "daily",              // daily | weekly | monthly
  "available": true,                 // false when history is too short
  "reason": null,                    // why, when available=false
  "marketLabel": "NSE F&O",
  "generatedAt": "2026-07-17T15:53:02+05:30",            // when this file was written
  "generatedAtDisplay": "17 Jul 2026, 3:53 PM IST",      // navbar "Updated …"
  "asOf": { "iso": "2026-07-15", "display": "15 Jul 2026" },  // the trading day

  "dateA": { "iso": "2026-07-15", "display": "15 Jul 2026 (Wed)",
             "dateOnly": "15 Jul 2026", "weekday": "Wed", "expiry": false },
  "dateB": { "iso": "2026-07-09", "display": "09 Jul 2026 (Thu · expiry)",
             "dateOnly": "09 Jul 2026", "weekday": "Thu", "expiry": true },

  "headline": "Pro adding index call longs +163,663 contracts (+22.8%)",
  "note": "Client hidden - biggest move 933,376 is 1.0x their typical 930,474 (needs 1.5x)",
  "notes": ["…every note the engine raised…"],

  "actors": [{
    "name": "Pro",
    "coverage": false,               // true -> "COVERAGE" badge
    "book": { "longChange": 324935, "longPct": 6.97,
              "shortChange": 292822, "shortPct": 6.79 },
    "moves": [{ "field": "Option Index Call Long",
                "oldVal": 716728, "newVal": 880391,
                "change": 163663, "pct": 22.83,
                "note": "adding index call longs" }]
  }],

  "total": { "field": "Total Long Contracts",
             "oldVal": 20810416, "newVal": 22210093, "change": 1399677 },

  "read": { "score": -0.041, "tilt": "NEUTRAL",
            "signals": [{ "text": "Pro adding index call longs +163,663",
                          "sentiment": "bullish" }] },
  "action": "Index positioning showed no clear lean …",
  "disclaimer": "Positioning read only - not investment advice.",
  "footnote": "Moves selected by absolute change (size); …"
}
```

**`pct` is `null`** (never `0`, never `Infinity`) when the old value was 0 — the
page renders that as **`N/A`**. The same applies to `book.longPct` / `shortPct`.

**Two different clocks, kept apart.** `asOf` is the *trading day the brief is
about*; `generatedAt` is *when the JSON was written*. They are almost never the
same day — NSE publishes a day's OI after ~6 PM that evening, and the job may run
later still. So the navbar shows `Updated 17 Jul 2026, 3:53 PM IST` (date
included, deliberately) and the hero chip shows `Data as of / 15 Jul 2026`.
Printing a bare time next to the trading date would assert a moment that never
happened.

Nothing on the page is hardcoded: the number of actor cards and rows comes purely
from the data, so the engine's 5–7 movers and ≥3-actor coverage logic drive the
layout. If the JSON is missing, the page says so and tells you to run the export
rather than showing stale or invented numbers.

---

## 9. Exporting to Excel (on demand)

Excel is only an output you generate when you want it — the database stays the
source of truth. Needs `pandas` + `openpyxl` (`pip install pandas openpyxl`).

```bash
python nse_oi_scraper.py --export-excel                     # -> nse_participant_oi.xlsx
python nse_oi_scraper.py --export-excel fii_only.xlsx --sql "SELECT * FROM participant_oi WHERE participant_type='FII'"
```

Without `--sql` it dumps the whole `participant_oi` table (ordered by date, then
participant). With `--sql` it exports exactly the rows your query returns.

---

## 10. The optional `--merge` step

A simpler alternative to the database: combine the raw CSVs into one flat,
spreadsheet-ready CSV with an added `date` column.

```bash
pip install pandas          # only needed the first time
python nse_oi_scraper.py --merge
```

This writes `combined_participant_oi.csv` inside your data folder. (Add `--vol`
to merge the volume files instead.)

---

## 11. How it beats the "403 Forbidden" problem

NSE is protected by Akamai, so a naive download is refused with HTTP 403. The
script gets around it the same way a browser naturally does:

1. Sends a real browser **User-Agent**.
2. First visits the NSE **homepage** and **reports page** to collect cookies.
3. Requests the CSV using those cookies **plus a matching `Referer`** header.
4. If that still fails, it automatically retries with **`cloudscraper`**, which
   is built to solve these challenges.

It also **re-warms** cookies and backs off between retries, and only ever
downloads **one file at a time** with a short random delay — so it stays polite.

---

## 12. Holidays

Files only exist on trading days. The script skips weekends automatically, and
reads extra market holidays from **`nse_holidays.txt`** (one `YYYY-MM-DD` per
line). You can edit that file freely.

You don't have to keep it perfect: any holiday you miss simply returns a 404 and
is logged as a non-trading day. **Just don't add a real trading day by mistake**
— that would make the script skip data it could have downloaded. The official
list is linked at the top of `nse_holidays.txt`.

---

## 13. Troubleshooting

- **Everything comes back `ERROR (... bot protection)`** → try
  `--force-cloudscraper`. If it still fails, wait a few minutes (NSE may be rate
  limiting your IP) and re-run — already-saved files are kept.
- **Today's file is `404`** → NSE publishes after ~6 PM IST. Run again in the
  evening.
- **`--merge` / `--export-excel` says pandas or openpyxl is missing** →
  `pip install pandas openpyxl`.
- **The DB looks out of date** → run `python nse_oi_scraper.py --load-all` to
  load every file in the archive. To start fresh, delete `nse_data.db` first.
- **Want to go back further than 6 months** → pass an explicit `--start`, e.g.
  `--start 2025-07-01`. Older files may only exist on the `archives.nseindia.com`
  host, which the script already falls back to automatically.

---

## 14. Other NSE reports (`nse_reports.py`)

Beyond participant OI, `nse_reports.py` downloads two more daily reports into
their own folders (same 6-month back-fill, same polite one-at-a-time approach,
reusing the exact anti-bot machinery via `NseClient.fetch_url`). **These are not
in the database yet** — this step just builds the file archives.

```bash
python nse_reports.py                       # both reports, last 6 months
python nse_reports.py --report fii_stats
python nse_reports.py --report fo_bhavcopy --keep-zip
```

| Report | Folder | NSE URL (example) | Stored as |
|--------|--------|-------------------|-----------|
| **FII derivative statistics** | `fii_stats_data/` | `…/content/fo/fii_stats_16-Jul-2026.xls` | **`.xls`** as delivered |
| **F&O UDiFF common bhavcopy** | `fo_bhavcopy_data/` | `…/content/fo/BhavCopy_NSE_FO_0_0_0_20260716_F_0000.csv.zip` | **`.csv`** (extracted from the `.zip`; `--keep-zip` to store the zip) |

Two things worth knowing, both verified against live NSE:

- **FII stats is a real Excel `.xls` binary, not a CSV** (the `.csv` URL 404s).
  We store it untouched; parsing happens at DB-load time.
- **The bhavcopy is a `.zip`** we unzip to its CSV (~6.6 MB/day → ~786 MB for six
  months). Use `--keep-zip` (~136 MB) if disk/OneDrive space matters.

### Not included: FII/DII cash trading activity

The "FII/FPI & DII trading activity" (capital-market segment) report has **no
6-month archive on NSE**. Its only endpoint (`api/fiidiiTradeReact`) returns a
single day and ignores every date parameter, and the old archive URLs are dead.
The only way to build history is to capture that daily snapshot going forward —
left for a later step rather than faked here.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `nse_oi_scraper.py` | Participant-OI scraper + main entry point (download → DB → brief → dashboard). |
| `nse_reports.py` | Scrapers for the **other** NSE reports (FII stats, F&O bhavcopy) — see §14. |
| `db_loader.py` | The database layer (loading CSVs into SQLite, Excel export). |
| `analysis.py` | The brief engine (daily/weekly/monthly movers) + the dashboard's JSON exporter. |
| `trading_calendar.py` | Trading days + holiday-aware F&O expiry rules (shared). |
| `requirements.txt` | Python packages to install. |
| `nse_holidays.txt` | Editable holiday list — drives both skipping **and** expiry dates. |
| `run_daily.bat` / `logs/` | The 7 PM scheduled-job wrapper and its log. |
| `README.md` | This file. |
| `nse_oi_data/` | Participant-OI CSVs (the archive the DB is built from). |
| `fii_stats_data/` | FII derivative-statistics `.xls` files (§14). |
| `fo_bhavcopy_data/` | F&O UDiFF bhavcopy `.csv` files (§14). |
| `nse_data.db` | The SQLite database (participant OI only, for now). |
| `frontend/` | The Equinext Pulse dashboard (React + Vite). |
| `frontend/public/data/*.json` | Written by `--export-dashboard`; what the page reads. |

*For personal/educational analysis. Please respect NSE's website and keep the
polite delays in place.*
