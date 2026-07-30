"""Recompute the position-cycles block independently from research.data.load()
and check every leg's invariants -- this is the "standalone recompute from
the DB" check for signals.build_cycles_block, the same role
test_signal_parity.py plays for the saturation/percentile numbers.

    run:  python -m research.experiments.test_cycle_parity
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import signals  # noqa: E402
from research import data  # noqa: E402


def _check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'} {name:45s}{('  ' + detail) if detail else ''}")
    return ok


def main() -> int:
    frame = data.load()
    dates = [d.strftime("%Y-%m-%d") for d in frame.index]
    close = [None if v is None else float(v) for v in frame.close]

    results = []
    for actor in data.PARTICIPANTS:
        book = [None if v is None else float(v) for v in frame[f"futlong_{actor}"]]
        turns = signals.detect_turns(dates, book)

        results.append(_check(
            f"{actor}: turns alternate peak/trough",
            all(a["type"] != b["type"] for a, b in zip(turns, turns[1:])),
            f"{len(turns)} turns",
        ))

        legs = signals.cycle_legs(turns, dates, close, book)
        for leg in legs:
            if leg["avgPrice"] is None:
                continue
            i0 = dates.index(leg["startDate"])
            i1 = dates.index(leg["endDate"])
            window = [c for c in close[i0 : i1 + 1] if c is not None]
            in_range = min(window) <= leg["avgPrice"] <= max(window)
            results.append(_check(
                f"{actor}: {leg['startDate']}->{leg['endDate']} avgPrice in range",
                in_range,
                f"{leg['avgPrice']} in [{min(window)}, {max(window)}]",
            ))

        block = signals.build_cycles_block(dates, close, {actor: book}, actors=[actor])
        results.append(_check(
            f"{actor}: build_cycles_block leg count matches cycle_legs",
            block is not None and len(block["legs"].get(actor, [])) == len(legs),
        ))

        print(f"  -- {actor}: {len(legs)} legs over {data.describe(frame)}")

    print()
    if all(results):
        print("CYCLE CHECKS PASS.")
        return 0
    print("CYCLE CHECKS FAILED.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
