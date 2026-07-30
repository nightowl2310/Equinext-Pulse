"""Unit tests for the position-cycle turn detector and leg pricing in signals.py.

Uses a hand-constructed synthetic series (not the DB) so the exact expected
turns and avg prices can be verified by arithmetic, independent of any real
participant data.

    run:  python -m research.experiments.test_cycle_detect
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import signals  # noqa: E402

DATES = [f"2024-01-{i + 1:02d}" for i in range(21)]
VALUES = [140, 130, 120, 110, 100, 110, 120, 130, 140, 150,
          140, 130, 120, 110, 100, 90, 100, 110, 120, 130, 140]
CLOSE = [200 + 2 * i for i in range(21)]


def _check(name: str, got, expected) -> bool:
    ok = got == expected
    print(f"  {'PASS' if ok else 'FAIL'} {name:28s} got={got!r} expected={expected!r}")
    return ok


def main() -> int:
    results = []

    turns = signals.detect_turns(DATES, VALUES, min_retracement_pct=20.0, min_hold_sessions=3)
    results.append(_check(
        "detect_turns types",
        [(t["date"], t["type"], t["value"]) for t in turns],
        [
            ("2024-01-05", "trough", 100),
            ("2024-01-10", "peak", 150),
            ("2024-01-16", "trough", 90),
        ],
    ))

    legs = signals.cycle_legs(turns, DATES, CLOSE, VALUES)
    results.append(_check("leg count", len(legs), 2))

    if len(legs) == 2:
        acc, dist = legs
        results.append(_check("leg[0].type", acc["type"], "accumulation"))
        results.append(_check("leg[0].avgPrice", acc["avgPrice"], 214.0))
        results.append(_check("leg[0].startDate", acc["startDate"], "2024-01-05"))
        results.append(_check("leg[0].endDate", acc["endDate"], "2024-01-10"))
        results.append(_check("leg[1].type", dist["type"], "distribution"))
        results.append(_check("leg[1].avgPrice", dist["avgPrice"], 225.0))
        results.append(_check("leg[1].spread", dist.get("spread"), 11.0))

    print()
    if all(results):
        print("ALL CYCLE-DETECT CHECKS PASS.")
        return 0
    print("CYCLE-DETECT CHECKS FAILED.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
