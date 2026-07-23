#!/usr/bin/env python3
"""
participant_report.py
=====================

Builds the "Participant Wise Report" for EVERY trading day and writes a single
JSON the frontend filters client-side with a date picker. Read-only on the DB.

For each date, 21 OI lines x 5 participant columns (Client, DII, FII, Pro, Total).
Each cell carries the value AND its day-over-day change:

    value  = that participant's OI for the field on the selected date
    change = value - the same field on the PREVIOUS TRADING DAY (not calendar day)
    NET row: value = Long - Short ; change = today's NET - previous day's NET

The 'Total' column is NSE's own TOTAL participant row (= the four summed). Because
every long is someone's short, each field's Long-total equals its Short-total, so
every NET row's Total is 0 -- that market-wide identity is kept, not hidden.

The earliest date has no previous trading day -> every change there is null.

    python participant_report.py                 # -> frontend/public/data/participant_report.json
    python participant_report.py --out other.json
Also called from the daily job (nse_oi_scraper.py) alongside the other exports.
"""

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path

TABLE = "participant_oi"
DEFAULT_OUT = Path("frontend/public/data/participant_report.json")

# Output column order. The DB stores the fourth as 'TOTAL'; we expose it as 'Total'.
COLUMNS = [("Client", "Client"), ("DII", "DII"), ("FII", "FII"),
           ("Pro", "Pro"), ("Total", "TOTAL")]

# The six instrument groups + the totals group, in report order. Each becomes a
# Long row, a Short row, and a NET row.
GROUPS = [
    ("Future Index",      "future_index_long",       "future_index_short",
     "Future Index Long", "Future Index Short"),
    ("Option Index Call", "option_index_call_long",  "option_index_call_short",
     "Option Index Call Long", "Option Index Call Short"),
    ("Option Index Put",  "option_index_put_long",   "option_index_put_short",
     "Option Index Put Long", "Option Index Put Short"),
    ("Future Stock",      "future_stock_long",       "future_stock_short",
     "Future Stock Long", "Future Stock Short"),
    ("Option Stock Call", "option_stock_call_long",  "option_stock_call_short",
     "Option Stock Call Long", "Option Stock Call Short"),
    ("Option Stock Put",  "option_stock_put_long",   "option_stock_put_short",
     "Option Stock Put Long", "Option Stock Put Short"),
    ("Total",             "total_long_contracts",    "total_short_contracts",
     "Total Long Contracts", "Total Short Contracts"),
]

# Every numeric field we need to read, de-duplicated in a stable order.
FIELDS = []
for _g, _lc, _sc, _ll, _sl in GROUPS:
    FIELDS += [_lc, _sc]


def load(conn):
    """data[date][participant] = {field: value}; plus the sorted date list."""
    conn.row_factory = sqlite3.Row
    cols = ", ".join(FIELDS)
    data = {}
    for r in conn.execute(f"SELECT date, participant_type, {cols} FROM {TABLE}"):
        data.setdefault(r["date"], {})[r["participant_type"]] = {f: r[f] for f in FIELDS}
    return data, sorted(data)


def _cell(today, prev, participant, field):
    """{'v':..,'chg':..} for one field. chg is None on the earliest day or when
    either value is missing."""
    cur = today.get(participant)
    v = None if cur is None else cur.get(field)
    chg = None
    if prev is not None and v is not None:
        pcur = prev.get(participant)
        pv = None if pcur is None else pcur.get(field)
        if pv is not None:
            chg = v - pv
    return {"v": v, "chg": chg}


def _net_cell(today, prev, participant, long_f, short_f):
    """NET cell: v = Long - Short; chg = today's NET - previous day's NET."""
    cur = today.get(participant)
    if cur is None or cur.get(long_f) is None or cur.get(short_f) is None:
        return {"v": None, "chg": None}
    v = cur[long_f] - cur[short_f]
    chg = None
    if prev is not None:
        pcur = prev.get(participant)
        if pcur is not None and pcur.get(long_f) is not None and pcur.get(short_f) is not None:
            chg = v - (pcur[long_f] - pcur[short_f])
    return {"v": v, "chg": chg}


def build_rows(today, prev):
    """The 21 rows (field / field / NET, x7 groups) for one date."""
    rows = []
    for group, long_f, short_f, long_label, short_label in GROUPS:
        rows.append({
            "label": long_label, "kind": "field",
            "cells": {out: _cell(today, prev, db, long_f) for out, db in COLUMNS},
        })
        rows.append({
            "label": short_label, "kind": "field",
            "cells": {out: _cell(today, prev, db, short_f) for out, db in COLUMNS},
        })
        rows.append({
            "label": "NET", "kind": "net", "group": group,
            "cells": {out: _net_cell(today, prev, db, long_f, short_f) for out, db in COLUMNS},
        })
    return rows


def build_payload(conn):
    data, dates = load(conn)
    reports = {}
    for i, d in enumerate(dates):
        prev_date = dates[i - 1] if i > 0 else None
        prev = data[prev_date] if prev_date else None
        dt = datetime.strptime(d, "%Y-%m-%d")
        reports[d] = {
            "date": d,
            "display": dt.strftime("%d %b %Y (%a)"),
            "compareDate": prev_date,
            "rows": build_rows(data[d], prev),
        }
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "dates": dates,
        "reports": reports,
    }


def export(conn, out_path=DEFAULT_OUT):
    """Build from an existing (read-only-usable) connection and write the JSON."""
    payload = build_payload(conn)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")
    return out


def _self_check(payload):
    """Reproduce the one hand-verified cell so a bad build fails loudly."""
    r = payload["reports"].get("2026-07-20")
    if not r:
        return
    fil = next(row for row in r["rows"] if row["label"] == "Future Index Long")
    cell = fil["cells"]["Client"]
    assert cell["v"] == 215325, f"self-check v: {cell['v']}"
    assert cell["chg"] == -3769, f"self-check chg: {cell['chg']}"
    net_total = next(row for row in r["rows"] if row["kind"] == "net")["cells"]["Total"]["v"]
    assert net_total == 0, f"self-check NET Total should be 0: {net_total}"
    print("Self-check OK: 20 Jul Client Future Index Long = 215,325 (chg -3,769); NET Total = 0.")


def main():
    p = argparse.ArgumentParser(description="Build the Participant Wise Report JSON for the frontend.")
    p.add_argument("--db", default="nse_data.db")
    p.add_argument("--out", default=str(DEFAULT_OUT))
    args = p.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        payload = build_payload(conn)
    finally:
        conn.close()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")

    print(f"Dates : {payload['dates'][0]} -> {payload['dates'][-1]}  ({len(payload['dates'])} days)")
    print(f"Wrote : {out.resolve()}  ({out.stat().st_size:,} bytes)")
    _self_check(payload)


if __name__ == "__main__":
    main()
