#!/usr/bin/env python3
"""
plot_long_short.py
==================

Daily Long-vs-Short balance for the four NSE participants (Client, DII, FII, Pro)
on a single date, as three stacked panels -- Index Futures, Index Calls, Index
Puts. Read-only against nse_data.db.

For each participant + instrument we normalise that cell's own long/short to 100%:

    long%  = long  / (long + short) * 100
    short% = short / (long + short) * 100

So the bars express each participant's long-vs-short *balance* within one
instrument on that day -- not raw contract counts, and not comparable in size
across participants. (These are open-interest levels in contracts.)

Styling: Long = amber (#F4B400), Short = black (#000000), white background,
rounded % label above every bar, participant names on the x-axis.

    python plot_long_short.py                       # 2026-07-20 (default)
    python plot_long_short.py --date 2026-07-17
    python plot_long_short.py --out somewhere.png
"""

import argparse
import sqlite3
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

GOLD = "#F4B400"
BLACK = "#000000"
MUTED = "#9E9A92"
GRID = "#E5E1D8"

ACTORS = ["Client", "DII", "FII", "Pro"]          # exclude TOTAL
# (key, nice name, long column, short column)
INSTRUMENTS = [
    ("futures", "Index Futures", "future_index_long", "future_index_short"),
    ("calls",   "Index Calls",   "option_index_call_long", "option_index_call_short"),
    ("puts",    "Index Puts",    "option_index_put_long",  "option_index_put_short"),
]


def fmt_compact(n):
    """Readable contract count for small cards: Indian lakh/crore units so a
    7-digit number never overrides its neighbour (3,777,033 -> '37.8L')."""
    n = int(n)
    if n >= 10_000_000:
        return f"{n / 10_000_000:.2f}Cr"
    if n >= 100_000:
        return f"{n / 100_000:.1f}L"
    return f"{n:,}"


def load(db_path, day):
    """Read the four participants' long/short for `day`. Read-only (mode=ro)."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        cols = []
        for _, _, lc, sc in INSTRUMENTS:
            cols += [lc, sc]
        rows = {}
        for a in ACTORS:
            r = conn.execute(
                f"SELECT {', '.join(cols)} FROM participant_oi "
                f"WHERE date = ? AND participant_type = ?", (day, a)).fetchone()
            rows[a] = r
    finally:
        conn.close()
    return rows


def pct_table(rows):
    """Return {instrument: {actor: (long_pct, short_pct, long_raw, short_raw)}}
    plus a printable table."""
    out = {}
    lines = []
    for _key, name, lc, sc in INSTRUMENTS:
        out[name] = {}
        lines.append(f"\n{name} Long/Short  (long% / short%  --  raw long / short)")
        lines.append(f"  {'Actor':7} {'Long%':>7} {'Short%':>7}   {'Long':>12} {'Short':>12}")
        for a in ACTORS:
            r = rows[a]
            lo = r[lc] if r and r[lc] is not None else 0
            sh = r[sc] if r and r[sc] is not None else 0
            tot = lo + sh
            lp = 100.0 * lo / tot if tot else 0.0
            sp = 100.0 * sh / tot if tot else 0.0
            out[name][a] = (lp, sp, lo, sh)
            lines.append(f"  {a:7} {lp:7.1f} {sp:7.1f}   {lo:12,} {sh:12,}")
    return out, "\n".join(lines)


def build_figure(pcts, day):
    from matplotlib.patches import Patch

    x = np.arange(len(ACTORS))
    w = 0.34

    # roomier canvas + generous vertical gaps = breathing space
    fig, axes = plt.subplots(3, 1, figsize=(10.5, 13))
    fig.patch.set_facecolor("white")

    for ax, (_key, name, _, _) in zip(axes, INSTRUMENTS):
        longs = [pcts[name][a][0] for a in ACTORS]
        shorts = [pcts[name][a][1] for a in ACTORS]
        longs_raw = [pcts[name][a][2] for a in ACTORS]
        shorts_raw = [pcts[name][a][3] for a in ACTORS]

        b1 = ax.bar(x - w / 2, longs, w, color=GOLD, label="Long", zorder=3)
        b2 = ax.bar(x + w / 2, shorts, w, color=BLACK, label="Short", zorder=3)

        # Each bar labelled with BOTH the % (bold, near the bar) and the real
        # contract count (muted, just above the %).
        for bars, vals, raws in ((b1, longs, longs_raw), (b2, shorts, shorts_raw)):
            for rect, v, raw in zip(bars, vals, raws):
                cx = rect.get_x() + rect.get_width() / 2
                ax.text(cx, v + 2.0, f"{round(v)}%", ha="center", va="bottom",
                        fontsize=11.5, color="#12151C", fontweight="bold")
                ax.text(cx, v + 9.5, f"{raw:,}", ha="center", va="bottom",
                        fontsize=8.5, color=MUTED)

        ax.set_title(f"{name} Long/Short", loc="left", fontsize=14.5,
                     fontweight="bold", color="#12151C", pad=14)
        ax.set_xticks(x)
        ax.set_xticklabels(ACTORS, fontsize=11.5, color="#12151C")
        ax.set_ylim(0, 128)
        ax.set_yticks([0, 50, 100])
        ax.set_yticklabels(["0", "50", "100"], fontsize=9, color=MUTED)
        ax.grid(axis="y", color=GRID, lw=0.7, alpha=0.7, zorder=0)
        ax.set_axisbelow(True)
        ax.margins(x=0.08)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color(GRID)
        ax.tick_params(length=0)

    fig.suptitle(f"Participant Long-vs-Short balance  ·  {day}",
                 x=0.02, ha="left", fontsize=16.5, fontweight="bold",
                 color="#12151C", y=0.985)
    fig.text(0.02, 0.963, "Long/short normalised to 100% per instrument (% = balance); "
             "raw contract counts above each bar.", fontsize=9.5, color=MUTED)

    # figure-level legend in the header band, below the subtitle and above panel 1
    handles = [Patch(color=GOLD, label="Long"), Patch(color=BLACK, label="Short")]
    fig.legend(handles=handles, loc="upper right", bbox_to_anchor=(0.965, 0.945),
               frameon=False, fontsize=11, ncol=2, handlelength=1.2, columnspacing=1.4)

    fig.subplots_adjust(left=0.065, right=0.965, top=0.90, bottom=0.045, hspace=0.42)
    return fig


def build_one(pcts, name, actor, day):
    """A SINGLE participant's Long-vs-Short for one instrument -> its own card.
    Two bars set far apart, big labels that can't collide, participant as title."""
    long_p, short_p, long_r, short_r = pcts[name][actor]
    x = [0, 1]
    fig, ax = plt.subplots(figsize=(3.4, 2.4))   # short, compact card
    fig.patch.set_facecolor("white")

    bars = ax.bar(x, [long_p, short_p], width=0.62, color=[GOLD, BLACK], zorder=3)
    for rect, v, raw in zip(bars, [long_p, short_p], [long_r, short_r]):
        cx = rect.get_x() + rect.get_width() / 2
        # raw count on top (muted), % below it (bold) — a wide gap so they never touch
        ax.text(cx, v + 15, fmt_compact(raw), ha="center", va="bottom",
                fontsize=9, color=MUTED)
        ax.text(cx, v + 2, f"{round(v)}%", ha="center", va="bottom",
                fontsize=13, fontweight="bold", color="#12151C")

    ax.set_title(actor, loc="center", fontsize=14.5, fontweight="bold",
                 color="#12151C", pad=8)
    ax.set_xticks(x)
    ax.set_xticklabels(["Long", "Short"], fontsize=12, color="#12151C")
    ax.set_ylim(0, 150)
    ax.set_yticks([0, 50, 100])
    ax.set_yticklabels(["0", "50", "100"], fontsize=9.5, color=MUTED)
    ax.grid(axis="y", color=GRID, lw=0.8, alpha=0.7, zorder=0)
    ax.set_axisbelow(True)
    ax.margins(x=0.28)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(length=0)

    fig.subplots_adjust(left=0.13, right=0.93, top=0.88, bottom=0.12)
    return fig


def main():
    p = argparse.ArgumentParser(description="Daily Long-vs-Short % bars for the four NSE participants.")
    p.add_argument("--db", default="nse_data.db")
    p.add_argument("--date", default="2026-07-20", help="Trading date YYYY-MM-DD (default: 2026-07-20).")
    p.add_argument("--out", default=None,
                   help="Output PNG (default: frontend/public/long_short_<date>.png).")
    p.add_argument("--dpi", type=int, default=130)
    args = p.parse_args()

    out = Path(args.out) if args.out else Path(f"frontend/public/long_short_{args.date}.png")

    rows = load(args.db, args.date)
    if all(rows[a] is None for a in ACTORS):
        raise SystemExit(f"ERROR: no participant_oi rows for {args.date}.")

    pcts, table = pct_table(rows)
    print(f"Date  : {args.date}")
    print(table)

    out.parent.mkdir(parents=True, exist_ok=True)

    # combined 3-panel image (kept as a standalone artifact)
    fig = build_figure(pcts, args.date)
    fig.savefig(out, dpi=args.dpi, facecolor="white")
    plt.close(fig)
    print(f"\nWrote : {out.resolve()}  ({out.stat().st_size:,} bytes)")

    # one image per PARTICIPANT per instrument -> the frontend gives each its
    # own card (4 participants x 3 instruments = 12 cards).
    made = 0
    for key, name, _, _ in INSTRUMENTS:
        for actor in ACTORS:
            ofig = build_one(pcts, name, actor, args.date)
            opath = out.parent / f"long_short_{key}_{actor.lower()}_{args.date}.png"
            ofig.savefig(opath, dpi=args.dpi, facecolor="white")
            plt.close(ofig)
            made += 1
    print(f"Wrote : {made} per-participant cards (e.g. long_short_futures_fii_{args.date}.png) "
          f"-> {out.parent.resolve()}")


if __name__ == "__main__":
    main()
