#!/usr/bin/env python3
"""
plot_fii_vs_nifty.py
====================

Stacked-panel chart of FII index F&O positioning against the NIFTY 50 close,
on ONE shared timeline. Read-only against nse_data.db.

Four vertically stacked panels sharing the x-axis (the exact trading dates in
participant_oi -- weekends/holidays are simply absent, so nothing is invented):

    Panel 1  NIFTY 50 daily close            (index points; from index_prices)
    Panel 2  FII net index futures           = future_index_long  - future_index_short
    Panel 3  FII net index calls             = option_index_call_long - option_index_call_short
    Panel 4  FII net index puts              = option_index_put_long  - option_index_put_short

Each panel keeps its NATURAL units (no normalising) -- that is the whole point
of stacking: puts (~+500k) dwarf futures (~-230k), and that contrast is signal.
Net panels get a zero line; Thursday (weekly-expiry) days get a faint vertical
line, because expiry-day OI shifts are mechanical rollover, not sentiment.

    python plot_fii_vs_nifty.py
    python plot_fii_vs_nifty.py --start 2026-02-01 --end 2026-07-20
    python plot_fii_vs_nifty.py --out frontend/public/fii_vs_nifty.png
"""

import argparse
import json
import sqlite3
from datetime import date, datetime
from pathlib import Path

WEEKDAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# matplotlib is imported LAZILY (see _ensure_mpl) so the JSON-emit path — used by
# the daily job, which runs in a venv WITHOUT matplotlib — never needs it. Only the
# PNG-plotting path (build_figure) pulls it in.
plt = None
FuncFormatter = None


def _ensure_mpl():
    """Populate the module-level plt / FuncFormatter on first plotting use."""
    global plt, FuncFormatter
    if plt is not None:
        return
    import matplotlib
    matplotlib.use("Agg")                 # headless: write a file, never open a window
    import matplotlib.pyplot as _plt
    from matplotlib.ticker import FuncFormatter as _FF
    plt = _plt
    FuncFormatter = _FF

SYMBOL = "NIFTY 50"

# palette (matches the frontend's calm ink/teal/green/red)
INK   = "#12151C"
TEAL  = "#0EA5A4"
GREEN = "#158A4E"
RED   = "#C0362C"
GRID  = "#E5E1D8"
MUTED = "#9E9A92"

CAVEATS = [
    "Index OI aggregates ALL index F&O (NIFTY + BANKNIFTY + FINNIFTY + MIDCPNIFTY + NEXT50); "
    "NIFTY 50 close is a directional proxy, not an exact match.",
    "Thursday (weekly-expiry) vertical lines: OI jumps there are mechanical rollover, not sentiment.",
    "FII net is one side of a zero-sum book (Client / DII / Pro hold the other side) -- "
    "this is FII's stance vs price, not the whole market.",
]


ACTORS = ["Client", "DII", "FII", "Pro"]   # the frontend can select any of these


def load_all(conn, start, end):
    """Join ALL four participants' index-OI positions with the NIFTY close on the
    shared trading dates. Returns (dates, close, series) where series[actor] holds,
    aligned to dates:
      'fut' / 'call' / 'put'          -- the nets (long - short) per instrument
      'fut_l' / 'fut_s' / 'call_l' /  -- the GROSS legs, carried through so the
      'call_s' / 'put_l' / 'put_s'       frontend can switch its three instrument
                                         panels between net / long-only / short-only
      'long_book' / 'short_book'      -- the derived directional books:
        long_book  = future_index_long  + option_index_call_long  - option_index_put_short
        short_book = future_index_short + option_index_call_short - option_index_put_long
    (a long call and a short put are both bullish exposure; the opposite legs are
    bearish)."""
    q = """
        SELECT p.date, p.participant_type,
               (p.future_index_long      - p.future_index_short)      AS fut,
               (p.option_index_call_long - p.option_index_call_short) AS call,
               (p.option_index_put_long  - p.option_index_put_short)  AS put,
               (p.future_index_long  + p.option_index_call_long  - p.option_index_put_short) AS long_book,
               (p.future_index_short + p.option_index_call_short - p.option_index_put_long)  AS short_book,
               x.close                                                AS close,
               p.future_index_long       AS fut_l,
               p.future_index_short      AS fut_s,
               p.option_index_call_long  AS call_l,
               p.option_index_call_short AS call_s,
               p.option_index_put_long   AS put_l,
               p.option_index_put_short  AS put_s
        FROM participant_oi p
        JOIN index_prices  x ON x.date = p.date AND x.symbol = ?
        WHERE p.participant_type IN ('Client', 'DII', 'FII', 'Pro')
    """
    params = [SYMBOL]
    if start:
        q += " AND p.date >= ?"; params.append(start)
    if end:
        q += " AND p.date <= ?"; params.append(end)
    q += " ORDER BY p.date"

    # column order of the SELECT above, minus date/participant/close
    FIELDS = ["fut", "call", "put", "long_book", "short_book",
              "fut_l", "fut_s", "call_l", "call_s", "put_l", "put_s"]

    close_by = {}
    rows = {}                                  # (date, actor) -> tuple in FIELDS order
    dates = set()
    for r in conn.execute(q, params):
        d, a = r[0], r[1]
        dates.add(d)
        close_by[d] = r[7]
        rows[(d, a)] = (r[2], r[3], r[4], r[5], r[6]) + tuple(r[8:14])

    dates = sorted(dates)
    close = [close_by[d] for d in dates]
    series = {a: {f: [] for f in FIELDS} for a in ACTORS}
    blank = (None,) * len(FIELDS)
    for d in dates:
        for a in ACTORS:
            vals = rows.get((d, a), blank)
            for f, v in zip(FIELDS, vals):
                series[a][f].append(v)
    return dates, close, series


def write_json(dates, close, series, out_path):
    """Emit the per-participant nets + NIFTY close as JSON so the frontend can
    switch the interactive chart between Client / DII / FII / Pro."""
    points = []
    for i, d in enumerate(dates):
        dt = datetime.fromisoformat(d)
        nets = {a: {"fut": series[a]["fut"][i],
                    "call": series[a]["call"][i],
                    "put": series[a]["put"][i]} for a in ACTORS}
        points.append({
            "date": d,
            "dateDisplay": dt.strftime("%d %b %Y"),
            "day": WEEKDAY_FULL[dt.weekday()],
            "expiry": dt.weekday() == 3,          # Thursday = weekly expiry
            "close": None if close[i] is None else round(float(close[i]), 2),
            "nets": nets,
        })
    payload = {
        "symbol": SYMBOL,
        "start": dates[0],
        "end": dates[-1],
        "count": len(dates),
        "actors": ACTORS,
        "points": points,
    }
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")
    return out


def write_participants_json(dates, close, series, out_path):
    """Emit ALL four participants' nets + the NIFTY close as columnar arrays on
    the shared date axis, for the "NIFTY vs All Participants" frontend section.

    net = long - short, per date, per instrument (futures / calls / puts).
    Read-only against participant_oi. The core shape the frontend contracts on is
    {dates, nifty, participants:{FII/DII/Client/Pro:{futures,calls,puts}}}; the
    dateDisplay/day/expiry arrays are carried alongside so the chart can render
    its readout, dd-Mon ticks and Thursday-expiry verticals without re-parsing
    dates on the client (avoids a timezone off-by-one on which day is expiry)."""
    dts = [datetime.fromisoformat(d) for d in dates]

    def _ints(vals):
        return [None if v is None else int(v) for v in vals]

    def _delta(vals):
        """Day-over-day difference; first day (and any day adjacent to a gap) null."""
        out = [None]
        for i in range(1, len(vals)):
            a, b = vals[i], vals[i - 1]
            out.append(None if a is None or b is None else int(a) - int(b))
        return out

    participants = {}
    for a in ACTORS:
        long_book = series[a]["long_book"]
        short_book = series[a]["short_book"]
        participants[a] = {
            "futures": _ints(series[a]["fut"]),
            "calls":   _ints(series[a]["call"]),
            "puts":    _ints(series[a]["put"]),
            # gross legs — the frontend's "Long book" / "Short book" modes swap the
            # three instrument panels onto these instead of the nets above.
            "futuresLong":  _ints(series[a]["fut_l"]),
            "futuresShort": _ints(series[a]["fut_s"]),
            "callsLong":    _ints(series[a]["call_l"]),
            "callsShort":   _ints(series[a]["call_s"]),
            "putsLong":     _ints(series[a]["put_l"]),
            "putsShort":    _ints(series[a]["put_s"]),
            "longBook":       _ints(long_book),
            "shortBook":      _ints(short_book),
            "longBookDelta":  _delta(long_book),
            "shortBookDelta": _delta(short_book),
        }
    payload = {
        "symbol": SYMBOL,
        "start": dates[0],
        "end": dates[-1],
        "count": len(dates),
        "dates": list(dates),
        "dateDisplay": [dt.strftime("%d %b %Y") for dt in dts],
        "day": [WEEKDAY_FULL[dt.weekday()] for dt in dts],
        "expiry": [dt.weekday() == 3 for dt in dts],   # Thursday = weekly expiry
        "nifty": [None if close[i] is None else round(float(close[i]), 2)
                  for i in range(len(dates))],
        "participants": participants,
    }
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")
    return out


def export(conn, start=None, end=None,
           out="frontend/public/data/participants_vs_nifty.json"):
    """Refresh participants_vs_nifty.json from an OPEN, read-only connection.
    Imported by the daily OI job so the "NIFTY vs All Participants" section stays
    fresh. Does no plotting — JSON only. Returns the written path, or None if
    there are no joined participant+NIFTY rows yet."""
    dates, close, series = load_all(conn, start, end)
    if not dates:
        return None
    return write_participants_json(dates, close, series, out)


def _thin_ticks(dates, target=14):
    """Evenly-spaced tick positions with 'dd Mon' labels (categorical axis)."""
    n = len(dates)
    step = max(1, round(n / target))
    pos = list(range(0, n, step))
    if pos[-1] != n - 1:
        pos.append(n - 1)
    labels = [datetime.fromisoformat(dates[i]).strftime("%d %b") for i in pos]
    return pos, labels


def _thousands(v, _pos):
    return f"{v:,.0f}"


def net_panel(ax, x, y, title, color_pos=GREEN, color_neg=RED):
    """A signed net-position panel: line + green/red fill vs a zero baseline."""
    ax.plot(x, y, color=INK, lw=1.1, zorder=3)
    ax.fill_between(x, 0, y, where=[v >= 0 for v in y], color=color_pos, alpha=0.18,
                    interpolate=True, zorder=2)
    ax.fill_between(x, 0, y, where=[v < 0 for v in y], color=color_neg, alpha=0.18,
                    interpolate=True, zorder=2)
    ax.axhline(0, color=MUTED, lw=1.0, zorder=1)
    ax.set_ylabel(title, fontsize=10, color=INK)
    ax.yaxis.set_major_formatter(FuncFormatter(_thousands))


def build_figure(dates, fut, call, put, close):
    _ensure_mpl()                          # pull in matplotlib only when actually plotting
    x = list(range(len(dates)))
    thursdays = [i for i, d in enumerate(dates)
                 if datetime.fromisoformat(d).weekday() == 3]

    fig, axes = plt.subplots(4, 1, figsize=(13, 11), sharex=True,
                             gridspec_kw={"height_ratios": [1.25, 1, 1, 1], "hspace": 0.12})
    fig.patch.set_facecolor("white")

    # Panel 1 -- NIFTY 50 close (index points)
    ax0 = axes[0]
    ax0.plot(x, close, color=TEAL, lw=1.8, zorder=3)
    ax0.set_ylabel("NIFTY 50 close\n(index points)", fontsize=10, color=INK)
    ax0.yaxis.set_major_formatter(FuncFormatter(_thousands))

    # Panels 2-4 -- FII net positions (contracts)
    net_panel(axes[1], x, fut,  "Net index futures\n(contracts)")
    net_panel(axes[2], x, call, "Net index calls\n(contracts)")
    net_panel(axes[3], x, put,  "Net index puts\n(contracts)")

    # shared cosmetics: expiry markers, grid, spines
    for ax in axes:
        for t in thursdays:
            ax.axvline(t, color=MUTED, lw=0.6, alpha=0.30, zorder=0)
        ax.grid(axis="y", color=GRID, lw=0.6, alpha=0.7)
        ax.margins(x=0.01)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("left", "bottom"):
            ax.spines[side].set_color(GRID)
        ax.tick_params(colors=MUTED, labelsize=9)

    pos, labels = _thin_ticks(dates)
    axes[-1].set_xticks(pos)
    axes[-1].set_xticklabels(labels, rotation=45, ha="right", fontsize=8.5, color=INK)

    # title + expiry legend note
    fig.suptitle(f"FII index F&O positioning vs NIFTY 50   ·   {dates[0]} to {dates[-1]}"
                 f"   ({len(dates)} trading days)",
                 x=0.02, ha="left", fontsize=15, fontweight="bold", color=INK, y=0.985)
    fig.text(0.02, 0.958, "Faint vertical lines = Thursday (weekly expiry). Each panel keeps its "
             "own units — nothing is normalised.", fontsize=9, color=MUTED)

    # caveats caption
    caption = "\n".join(f"•  {c}" for c in CAVEATS)
    fig.text(0.02, 0.005, caption, fontsize=8.2, color="#4A4740", va="bottom", linespacing=1.5)

    fig.subplots_adjust(left=0.11, right=0.985, top=0.93, bottom=0.135)
    return fig


def main():
    p = argparse.ArgumentParser(description="Stacked-panel chart: FII index F&O positioning vs NIFTY 50.")
    p.add_argument("--db", default="nse_data.db")
    p.add_argument("--start", help="First date YYYY-MM-DD (default: all).")
    p.add_argument("--end", help="Last date YYYY-MM-DD (default: all).")
    p.add_argument("--out", default="frontend/public/fii_vs_nifty.png",
                   help="Output PNG (default: frontend/public/fii_vs_nifty.png).")
    p.add_argument("--json", default="frontend/public/data/fii_vs_nifty.json",
                   help="Output JSON for the interactive frontend chart "
                        "(default: frontend/public/data/fii_vs_nifty.json).")
    p.add_argument("--participants-json",
                   default="frontend/public/data/participants_vs_nifty.json",
                   help="Output JSON for the 'NIFTY vs All Participants' section "
                        "(default: frontend/public/data/participants_vs_nifty.json).")
    p.add_argument("--dpi", type=int, default=130)
    args = p.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        dates, close, series = load_all(conn, args.start, args.end)
    finally:
        conn.close()
    if not dates:
        raise SystemExit("ERROR: no joined participant+NIFTY rows. Run scraper.py to fill index_prices first.")

    # The static PNG stays FII-focused (the headline artifact); the JSON carries
    # all four participants so the frontend selector can switch between them.
    fii = series["FII"]
    fig = build_figure(dates, fii["fut"], fii["call"], fii["put"], close)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=args.dpi, facecolor="white")
    plt.close(fig)
    jout = write_json(dates, close, series, args.json)
    pout = write_participants_json(dates, close, series, args.participants_json)
    print(f"Range : {dates[0]} -> {dates[-1]}  ({len(dates)} trading days)")
    print(f"Wrote : {out.resolve()}  ({out.stat().st_size:,} bytes)")
    print(f"Wrote : {jout.resolve()}  ({jout.stat().st_size:,} bytes)")
    print(f"Wrote : {pout.resolve()}  ({pout.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
