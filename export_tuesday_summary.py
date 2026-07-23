#!/usr/bin/env python3
"""
export_tuesday_summary.py
=========================

"Tuesday vs Tuesday" positioning summary for the last 12 Tuesdays (anchored to
2026-07-21, today, which is itself a Tuesday). Read-only against nse_data.db.

For each instrument (Index Futures / Calls / Puts) and each of the four
participants (Client / DII / FII / Pro) we take the net position on each
Tuesday:

    net = long - short

and the WEEKLY delta -- this Tuesday's net minus the PREVIOUS Tuesday's net
(so it answers "how did positioning shift week over week"). Note this is a
Tuesday-over-Tuesday delta, NOT the day-over-day delta in net_report.py.

Per Tuesday we also flag:
    Winner       -- the participant with the largest |delta| (moved the most)
    Market Bias  -- read off the FII delta (FII = the institutional tell):
                      futures/calls  FII delta > 0  -> Bullish  (adding longs)
                      puts           FII delta > 0  -> Bearish  (adding long puts)
                    "Strong" when |FII delta| >= 1.5x its median across the 12.

Writes frontend/public/data/tuesday_summary.json (both the weekly deltas for the
table and the net LEVELS for the line chart).

    python export_tuesday_summary.py
    python export_tuesday_summary.py --asof 2026-07-21
"""

import argparse
import json
import sqlite3
import statistics
from datetime import datetime
from pathlib import Path

ACTORS = ["Client", "DII", "FII", "Pro"]
# (key, nice name, long col, short col, bias polarity)  polarity: +1 normal, -1 for puts
INSTRUMENTS = [
    ("futures", "Index Futures", "future_index_long", "future_index_short", +1),
    ("calls",   "Index Calls",   "option_index_call_long", "option_index_call_short", +1),
    ("puts",    "Index Puts",    "option_index_put_long",  "option_index_put_short",  -1),
]
N_SHOW = 12   # Tuesdays to display (we fetch one extra to get the first row's delta)


def last_tuesdays(conn, asof, need):
    rows = conn.execute(
        "SELECT DISTINCT date FROM participant_oi "
        "WHERE strftime('%w', date) = '2' AND date <= ? ORDER BY date", (asof,)
    ).fetchall()
    tues = [r[0] for r in rows]
    return tues[-need:]


def nets_for(conn, day, lc, sc):
    """{actor: net} for one instrument on one day (net = long - short)."""
    out = {}
    for a in ACTORS:
        r = conn.execute(
            f"SELECT {lc}, {sc} FROM participant_oi WHERE date = ? AND participant_type = ?",
            (day, a)).fetchone()
        out[a] = None if (not r or r[0] is None or r[1] is None) else r[0] - r[1]
    return out


def bias_for(fii_delta, polarity, strong):
    eff = fii_delta * polarity
    if eff == 0:
        return "Neutral"
    base = "Bullish" if eff > 0 else "Bearish"
    return f"Strong {base}" if strong else base


def build(conn, asof):
    tues = last_tuesdays(conn, asof, N_SHOW + 1)
    if len(tues) < 2:
        raise SystemExit("ERROR: not enough Tuesdays in participant_oi.")
    show = tues[1:]                        # the 12 we display (each has a prior Tuesday)
    displays = [datetime.fromisoformat(d).strftime("%d %b") for d in show]

    instruments = {}
    for key, name, lc, sc, polarity in INSTRUMENTS:
        nets = {d: nets_for(conn, d, lc, sc) for d in tues}

        # first pass: weekly deltas + |FII delta| for the strong threshold
        deltas = []
        for i, d in enumerate(show, start=1):
            prev = tues[i - 1]
            deltas.append({a: (None if nets[d][a] is None or nets[prev][a] is None
                               else nets[d][a] - nets[prev][a]) for a in ACTORS})
        fii_abs = [abs(x["FII"]) for x in deltas if x["FII"] is not None]
        strong_cut = 1.5 * statistics.median(fii_abs) if fii_abs else 0

        rows = []
        for d, disp, dl in zip(show, displays, deltas):
            valid = {a: v for a, v in dl.items() if v is not None}
            winner = max(valid, key=lambda a: abs(valid[a])) if valid else None
            fd = dl["FII"]
            bias = (bias_for(fd, polarity, abs(fd) >= strong_cut)
                    if fd is not None else "—")
            rows.append({
                "date": d, "display": disp, "day": "Tuesday",
                "net": nets[d],
                "delta": dl,
                "winner": winner or "—",
                "bias": bias,
            })
        instruments[key] = {"label": name, "biasPolarity": polarity, "rows": rows}

    return {
        "asOf": asof,
        "deltaBasis": "vs previous Tuesday",
        "tuesdays": show,
        "displays": displays,
        "actors": ACTORS,
        "instruments": instruments,
    }


def main():
    p = argparse.ArgumentParser(description="Export last-12-Tuesdays positioning summary JSON.")
    p.add_argument("--db", default="nse_data.db")
    p.add_argument("--asof", default="2026-07-21", help="Anchor Tuesday (default: 2026-07-21).")
    p.add_argument("--out", default="frontend/public/data/tuesday_summary.json")
    args = p.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        payload = build(conn, args.asof)
    finally:
        conn.close()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")

    print(f"As of : {payload['asOf']}  ({len(payload['tuesdays'])} Tuesdays: "
          f"{payload['tuesdays'][0]} -> {payload['tuesdays'][-1]})")
    print(f"Wrote : {out.resolve()}  ({out.stat().st_size:,} bytes)")
    # tiny preview so the numbers can be eyeballed
    fut = payload["instruments"]["futures"]["rows"]
    print("\nIndex Futures (weekly delta vs previous Tuesday):")
    print(f"  {'Tue':7} {'FII d':>10} {'DII d':>9} {'PRO d':>9} {'Client d':>10}  Winner  Bias")
    for r in fut[-4:]:
        dl = r["delta"]
        print(f"  {r['display']:7} {dl['FII']:>10,} {dl['DII']:>9,} {dl['Pro']:>9,} "
              f"{dl['Client']:>10,}  {r['winner']:6} {r['bias']}")


if __name__ == "__main__":
    main()
