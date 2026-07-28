"""Single source of truth for loading the dataset.

Every experiment loads through here so that no two experiments can silently
disagree about what "the data" is.

The `cutoff` argument exists for wall-testing: pass a date and nothing after it
is readable, which is how you simulate standing at a past morning without being
able to peek. Use it.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

DB_PATH = Path(__file__).resolve().parent.parent / "nse_data.db"
INDEX_SYMBOL = "NIFTY 50"
PARTICIPANTS = ("Client", "DII", "FII", "Pro")


def load(cutoff: str | None = None, db_path: Path | str | None = None) -> pd.DataFrame:
    """Return one date-indexed frame of prices + participant positioning.

    cutoff: ISO date. Rows after it are not read at all -- not filtered later,
            not read. This is the wall.
    """
    path = Path(db_path) if db_path else DB_PATH
    if not path.exists():
        raise FileNotFoundError(f"database not found: {path}")

    where_oi = f"where date <= '{cutoff}'" if cutoff else ""
    where_px = f"and date <= '{cutoff}'" if cutoff else ""

    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        oi = pd.read_sql(
            f"select * from participant_oi {where_oi}", conn, parse_dates=["date"]
        )
        px = pd.read_sql(
            "select date, open, high, low, close from index_prices "
            f"where symbol = '{INDEX_SYMBOL}' {where_px}",
            conn,
            parse_dates=["date"],
        )

    oi = oi[oi.participant_type.isin(PARTICIPANTS)].copy()

    # Net = long - short. This is the only place the convention is defined.
    oi["fut_net"] = oi.future_index_long - oi.future_index_short
    oi["call_net"] = oi.option_index_call_long - oi.option_index_call_short
    oi["put_net"] = oi.option_index_put_long - oi.option_index_put_short

    wide = []
    for col, prefix in [
        ("fut_net", "fut"),
        ("call_net", "call"),
        ("put_net", "put"),
        ("future_index_long", "futlong"),
        ("future_index_short", "futshort"),
    ]:
        piv = oi.pivot(index="date", columns="participant_type", values=col)
        piv.columns = [f"{prefix}_{c}" for c in piv.columns]
        wide.append(piv)

    frame = pd.concat(wide, axis=1).join(px.set_index("date"), how="inner")
    frame = frame.sort_index()

    # Sanity check the zero-sum identity. If this ever fires, the data is wrong,
    # not the model -- so fail loudly rather than silently modelling garbage.
    net_sum = frame[[f"fut_{p}" for p in PARTICIPANTS]].sum(axis=1).abs()
    if (net_sum > 1000).any():
        bad = net_sum[net_sum > 1000]
        raise ValueError(
            f"participant nets do not sum to ~0 on {len(bad)} dates "
            f"(worst {bad.max():,.0f}); first offender {bad.index[0].date()}"
        )

    return frame


def describe(frame: pd.DataFrame) -> str:
    return (
        f"{len(frame)} trading days, "
        f"{frame.index.min().date()} to {frame.index.max().date()}"
    )
