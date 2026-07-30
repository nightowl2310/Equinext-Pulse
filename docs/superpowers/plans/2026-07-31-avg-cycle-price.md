# Avg Accumulation/Distribution Price per Position Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each participant (FII, DII, Pro, Client), detect confirmed peak/trough
turns in their net long-futures book and compute an OI-weighted average NIFTY
price across each leg, then surface it on the dashboard as chart overlay bands
plus a table.

**Architecture:** A new zigzag turn-detector and leg-pricing function live in
`signals.py` (stdlib-only, mirroring the existing `saturation_*` functions),
called from `plot_fii_vs_nifty.py`'s `write_participants_json()` to add an
additive `cycles` key to `participants_vs_nifty.json`. The frontend gets new
types in `series.ts`, a new `CycleStrip.tsx` table component (modeled on
`SaturationStrip.tsx`), and overlay bands + dashed avg-price lines drawn
directly inside `ParticipantChart.tsx`.

**Tech Stack:** Python 3 (stdlib only for `signals.py`; pandas for the
research-side DB loader), React + TypeScript + Vite, no test framework
(project convention is plain executable scripts for Python, no frontend
tests exist).

## Global Constraints

- `signals.py` has **zero third-party imports** — stdlib only (`math`). New
  functions must not import pandas/numpy.
- No pytest anywhere in this repo. All Python tests are plain scripts with a
  `main() -> int`, printed PASS/FAIL lines, `raise SystemExit(main())`, run
  via `python -m research.experiments.<module_name>`.
- No frontend test infrastructure exists (no vitest/jest, no `*.test.tsx`).
  Verify frontend changes with `npx tsc --noEmit` (type check) and a manual
  check in the running dev server (`npm run dev` from `frontend/`).
- New top-level JSON keys are **additive only** — absent when there isn't
  enough history, never breaking older payloads. Follow the exact pattern of
  `saturation`/`machine`: compute, check for `None`, conditionally set on
  `payload`.
- The OI-weighted average price formula uses **NIFTY close** as the price
  input, identically for both leg directions (no separate buy/sell
  semantics) — confirmed in `docs/superpowers/specs/2026-07-31-avg-cycle-price-design.md`.
- Turn detection operates on `futuresLong` (gross long index-futures
  contracts, i.e. `future_index_long` / the `fut_l` field / `futlong_<actor>`
  column), not `longBook`.

---

### Task 1: Turn detection + leg pricing algorithm in `signals.py`

**Files:**
- Modify: `signals.py` (insert after `build_saturation_block()`, and add a
  `"cycles"` key to the existing `VALIDATION` dict)
- Test: `research/experiments/test_cycle_detect.py` (new)

**Interfaces:**
- Produces: `signals.detect_turns(dates: list[str], values: list[Num], min_retracement_pct: float = CYCLE_MIN_RETRACEMENT_PCT, min_hold_sessions: int = CYCLE_MIN_HOLD_SESSIONS) -> list[dict]` — each dict is `{"date": str, "type": "peak"|"trough", "value": Num, "index": int}`.
- Produces: `signals.cycle_legs(turns: list[dict], dates: list[str], close: list[Num], values: list[Num]) -> list[dict]` — each dict is `{"type": "accumulation"|"distribution", "startDate": str, "endDate": str, "avgPrice": float|None, "oiStart": int, "oiEnd": int, "niftyStart": float|None, "niftyEnd": float|None, "durationSessions": int, "spread"?: float}`.
- Produces: `signals.build_cycles_block(dates: list[str], close: list[Num], long_books: dict[str, list[Num]], actors: list[str] = CYCLE_ACTORS) -> dict | None`.
- Produces: `signals.CYCLE_ACTORS = ["Client", "DII", "FII", "Pro"]`, `signals.CYCLE_MIN_RETRACEMENT_PCT = 20.0`, `signals.CYCLE_MIN_HOLD_SESSIONS = 3`.

- [ ] **Step 1: Write the failing synthetic test**

Create `research/experiments/test_cycle_detect.py`:

```python
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

    turns = signals.detect_turns(DATES, VALUES)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m research.experiments.test_cycle_detect`
Expected: `AttributeError: module 'signals' has no attribute 'detect_turns'`

- [ ] **Step 3: Implement `detect_turns`, `cycle_legs`, `build_cycles_block` in `signals.py`**

Find this exact block in `signals.py` (the end of `build_saturation_block()`):

```python
        "episodes": episodes,
        "episodeCount": len(episodes),
        "episodesUp": ups,
        "episodesComplete": len(done),
        "validation": VALIDATION["saturation"],
    }
```

Insert immediately after it (same indentation level, i.e. back at column 0):

```python


# --- position cycles: OI-weighted avg price across each peak<->trough leg ----
CYCLE_MIN_RETRACEMENT_PCT = 20.0   # a reversal must retrace this % of the leg's own range
CYCLE_MIN_HOLD_SESSIONS = 3        # ...and hold for this many sessions to confirm
CYCLE_ACTORS = ["Client", "DII", "FII", "Pro"]


def detect_turns(
    dates: list[str],
    values: list[Num],
    min_retracement_pct: float = CYCLE_MIN_RETRACEMENT_PCT,
    min_hold_sessions: int = CYCLE_MIN_HOLD_SESSIONS,
) -> list[dict]:
    """Zigzag turning points in `values` (a participant's futuresLong series).

    A pending extreme is confirmed as a peak/trough only once price retraces
    at least `min_retracement_pct` of the CURRENT leg's own range (the leg
    from the last confirmed turn to the pending extreme) AND the reversal
    direction holds for `min_hold_sessions` consecutive sessions without a
    new extreme invalidating it. Both conditions guard against single-day
    whipsaws that a threshold-only or duration-only rule would each miss.

    The leg before the first confirmed turn and after the last confirmed turn
    are never reported by `cycle_legs` -- a legitimate leg needs both
    endpoints confirmed, so a still-pending swing at either end of the series
    is deliberately left out.
    """
    idxs = [i for i, v in enumerate(values) if v is not None]
    if len(idxs) < 2:
        return []

    turns: list[dict] = []
    anchor_i = idxs[0]
    anchor_v = values[anchor_i]
    extreme_i = anchor_i
    extreme_v = anchor_v
    direction: str | None = None

    def _record(i: int, kind: str) -> None:
        turns.append({"date": dates[i], "type": kind, "value": values[i], "index": i})

    pos = 1
    while pos < len(idxs):
        i = idxs[pos]
        v = values[i]

        if direction is None:
            if v > extreme_v:
                extreme_v, extreme_i, direction = v, i, "up"
            elif v < extreme_v:
                extreme_v, extreme_i, direction = v, i, "down"
            pos += 1
            continue

        if direction == "up":
            if v >= extreme_v:
                extreme_v, extreme_i = v, i
                pos += 1
                continue
            leg_range = extreme_v - anchor_v
            retrace = 0.0 if leg_range <= 0 else (extreme_v - v) / leg_range * 100
            if retrace >= min_retracement_pct:
                window = idxs[pos : pos + min_hold_sessions]
                holds = len(window) >= min_hold_sessions and all(
                    values[k] < extreme_v for k in window
                )
                if holds:
                    _record(extreme_i, "peak")
                    anchor_i, anchor_v = extreme_i, extreme_v
                    extreme_v, extreme_i, direction = v, i, "down"
            pos += 1
            continue

        # direction == "down"
        if v <= extreme_v:
            extreme_v, extreme_i = v, i
            pos += 1
            continue
        leg_range = anchor_v - extreme_v
        retrace = 0.0 if leg_range <= 0 else (v - extreme_v) / leg_range * 100
        if retrace >= min_retracement_pct:
            window = idxs[pos : pos + min_hold_sessions]
            holds = len(window) >= min_hold_sessions and all(
                values[k] > extreme_v for k in window
            )
            if holds:
                _record(extreme_i, "trough")
                anchor_i, anchor_v = extreme_i, extreme_v
                extreme_v, extreme_i, direction = v, i, "up"
        pos += 1

    return turns


def cycle_legs(
    turns: list[dict], dates: list[str], close: list[Num], values: list[Num]
) -> list[dict]:
    """One record per leg between consecutive turns, with the OI-weighted avg
    NIFTY close across that leg:

        avgPrice = sum(close[t] * |values[t] - values[t-1]|) / sum(|values[t] - values[t-1]|)

    for t in (legStart, legEnd] -- i.e. weighted by how much the position
    actually moved each day, not by session count. `type` is "accumulation"
    for a trough->peak leg (long being built) and "distribution" for a
    peak->trough leg (long being sold down). A completed accumulation
    immediately followed by a distribution also gets `spread` on the
    distribution leg = its avgPrice minus the accumulation leg's avgPrice.
    """
    legs: list[dict] = []
    for a, b in zip(turns, turns[1:]):
        start_i, end_i = a["index"], b["index"]
        weighted_sum = 0.0
        weight_sum = 0.0
        for t in range(start_i + 1, end_i + 1):
            prev, cur = values[t - 1], values[t]
            px = close[t]
            if prev is None or cur is None or px is None:
                continue
            w = abs(cur - prev)
            weighted_sum += float(px) * w
            weight_sum += w
        avg_price = round(weighted_sum / weight_sum, 2) if weight_sum > 0 else None
        leg_type = "accumulation" if a["type"] == "trough" else "distribution"
        legs.append({
            "type": leg_type,
            "startDate": a["date"],
            "endDate": b["date"],
            "avgPrice": avg_price,
            "oiStart": int(a["value"]),
            "oiEnd": int(b["value"]),
            "niftyStart": None if close[start_i] is None else round(float(close[start_i]), 2),
            "niftyEnd": None if close[end_i] is None else round(float(close[end_i]), 2),
            "durationSessions": end_i - start_i,
        })

    for leg, nxt in zip(legs, legs[1:]):
        if leg["type"] == "accumulation" and nxt["type"] == "distribution" \
                and leg["avgPrice"] is not None and nxt["avgPrice"] is not None:
            nxt["spread"] = round(nxt["avgPrice"] - leg["avgPrice"], 2)

    return legs


def build_cycles_block(
    dates: list[str],
    close: list[Num],
    long_books: dict[str, list[Num]],
    actors: list[str] = CYCLE_ACTORS,
) -> dict | None:
    """Confirmed peak/trough turns and per-leg avg price, for every actor with
    enough history to find at least one full leg. `long_books` is
    {"FII": [...], ...} of GROSS long index-futures contracts (futuresLong).
    Returns None when no actor has any legs yet.
    """
    result: dict[str, list[dict]] = {}
    for actor in actors:
        book = long_books.get(actor)
        if not book:
            continue
        turns = detect_turns(dates, book)
        legs = cycle_legs(turns, dates, close, book)
        if legs:
            result[actor] = legs

    if not result:
        return None

    return {
        "schemaVersion": SIGNAL_SCHEMA_VERSION,
        "minRetracementPct": CYCLE_MIN_RETRACEMENT_PCT,
        "minHoldSessions": CYCLE_MIN_HOLD_SESSIONS,
        "legs": result,
        "validation": VALIDATION["cycles"],
    }
```

Then find this exact block (the end of the `VALIDATION` dict):

```python
    "bias": {
        "status": "NOT VALIDATED",
        "attacksSurvived": "2/5",
        "note": (
            "Directional bias read off FII delta. Tested as hypothesis H4: "
            "walk-forward OOS R2 -0.27%, era split -1.53%, crisis drop -1.35%. "
            "FII delta has no measurable directional edge out of sample. Display "
            "with a caveat; do not trade from it. See docs/validation-log.md."
        ),
    },
}
```

Replace it with (adds the `"cycles"` key before the closing brace):

```python
    "bias": {
        "status": "NOT VALIDATED",
        "attacksSurvived": "2/5",
        "note": (
            "Directional bias read off FII delta. Tested as hypothesis H4: "
            "walk-forward OOS R2 -0.27%, era split -1.53%, crisis drop -1.35%. "
            "FII delta has no measurable directional edge out of sample. Display "
            "with a caveat; do not trade from it. See docs/validation-log.md."
        ),
    },
    "cycles": {
        "status": "descriptive",
        "note": (
            "Peak/trough turns in each participant's net long-futures book, "
            "confirmed by a zigzag rule (>=20% retracement of the leg's own "
            "range, held >=3 sessions), with an OI-change-weighted average "
            "NIFTY close across each leg. A derived positioning summary, not "
            "a backtested trading signal -- no forward-return claim is made."
        ),
    },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m research.experiments.test_cycle_detect`
Expected: `ALL CYCLE-DETECT CHECKS PASS.` and process exit code 0

- [ ] **Step 5: Commit**

```bash
git add signals.py research/experiments/test_cycle_detect.py
git commit -m "$(cat <<'EOF'
Add zigzag turn detection and OI-weighted leg pricing to signals.py

detect_turns confirms peak/trough turns in a participant's futuresLong
series (retracement % + hold-session confirmation), cycle_legs prices
each leg's NIFTY close weighted by daily OI change, and
build_cycles_block assembles the per-actor block for the dashboard.
EOF
)"
```

---

### Task 2: Wire `cycles` into `participants_vs_nifty.json` + DB-based invariant test

**Files:**
- Modify: `plot_fii_vs_nifty.py` (inside `write_participants_json()`)
- Test: `research/experiments/test_cycle_parity.py` (new)

**Interfaces:**
- Consumes: `signals.build_cycles_block`, `signals.detect_turns`, `signals.cycle_legs` from Task 1.
- Consumes: `research.data.load()` (returns a pandas `DataFrame` indexed by date, with columns `futlong_<actor>` and `close`) and `research.data.PARTICIPANTS = ("Client", "DII", "FII", "Pro")`.
- Produces: `frontend/public/data/participants_vs_nifty.json` gains an additive top-level `"cycles"` key (same shape `build_cycles_block` returns).

- [ ] **Step 1: Wire `build_cycles_block` into `write_participants_json()`**

Find this exact block in `plot_fii_vs_nifty.py`:

```python
    # Peak-reversal machine: the tradable form, evaluated at every duration the
    # chart's range selector offers. Additive key, same absence contract.
    machine = signals.build_machine_block(list(dates), _closes, _shorts)
    if machine is not None:
        payload["machine"] = machine
    out = Path(out_path)
```

Replace it with:

```python
    # Peak-reversal machine: the tradable form, evaluated at every duration the
    # chart's range selector offers. Additive key, same absence contract.
    machine = signals.build_machine_block(list(dates), _closes, _shorts)
    if machine is not None:
        payload["machine"] = machine

    # Position cycles: confirmed peak/trough turns in each participant's net
    # long-futures book, with an OI-weighted avg NIFTY price per leg. Additive
    # key, same absence contract as saturation/machine.
    _longs = {a: _ints(series[a]["fut_l"]) for a in ACTORS}
    cycles = signals.build_cycles_block(list(dates), _closes, _longs)
    if cycles is not None:
        payload["cycles"] = cycles

    out = Path(out_path)
```

- [ ] **Step 2: Regenerate the JSON and verify the key is present**

Run: `python plot_fii_vs_nifty.py`
Expected: prints `Wrote : ...participants_vs_nifty.json  (N bytes)` with no traceback.

Run: `python -c "import json; d=json.load(open('frontend/public/data/participants_vs_nifty.json')); print('cycles' in d, list(d.get('cycles',{}).get('legs',{}).keys()))"`
Expected: `True [...]` with a non-empty list of actor names (e.g. `True ['Client', 'DII', 'FII', 'Pro']`). If the list is empty, see the tuning note in Step 4 below before moving on.

- [ ] **Step 3: Write the DB-based invariant test**

Create `research/experiments/test_cycle_parity.py`:

```python
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
```

- [ ] **Step 4: Run the test and sanity-check the leg counts**

Run: `python -m research.experiments.test_cycle_parity`
Expected: `CYCLE CHECKS PASS.` and exit code 0.

Inspect the printed `-- <actor>: N legs over ...` lines. This is the tuning
anchor referenced in the design spec ("3-8 confirmed cycles/year on
historical FII data"):
- If FII shows **0 legs**, halve `CYCLE_MIN_RETRACEMENT_PCT` in `signals.py`
  (20.0 -> 10.0), re-run Step 2's JSON regeneration and this test.
- If FII shows **more than ~15 legs per year** of history (i.e. `N /
  years_of_data > 15`), double `CYCLE_MIN_RETRACEMENT_PCT` (20.0 -> 40.0),
  re-run Step 2's JSON regeneration and this test.
- Otherwise, keep the defaults as-is.

- [ ] **Step 5: Commit**

```bash
git add plot_fii_vs_nifty.py research/experiments/test_cycle_parity.py frontend/public/data/participants_vs_nifty.json
git commit -m "$(cat <<'EOF'
Wire position cycles into participants_vs_nifty.json

Adds an additive "cycles" block via signals.build_cycles_block, driven
by each participant's futuresLong (fut_l) series, plus an invariant
test recomputing from research.data.load() independently of the
dashboard export path.
EOF
)"
```

---

### Task 3: Frontend types for the `cycles` payload

**Files:**
- Modify: `frontend/src/app/lib/series.ts`

**Interfaces:**
- Consumes: nothing new (pure type addition).
- Produces: `CycleLeg` and `CyclesBlock` types, and `ParticipantsData.cycles?: CyclesBlock`, for Tasks 4 and 5 to import.

- [ ] **Step 1: Add `CycleLeg` and `CyclesBlock` types**

Find this exact block in `frontend/src/app/lib/series.ts` (the end of the
`SaturationBlock` interface):

```ts
  episodes: SaturationEpisode[];
  episodeCount: number;
  episodesUp: number;
  episodesComplete: number;
  validation: SignalValidation;
}
```

Insert immediately after it:

```ts

export interface CycleLeg {
  type: "accumulation" | "distribution";
  startDate: string;
  endDate: string;
  avgPrice: number | null;
  oiStart: number;
  oiEnd: number;
  niftyStart: number | null;
  niftyEnd: number | null;
  durationSessions: number;
  spread?: number;
}

export interface CyclesBlock {
  schemaVersion: number;
  minRetracementPct: number;
  minHoldSessions: number;
  legs: Record<string, CycleLeg[]>;
  validation: SignalValidation;
}
```

- [ ] **Step 2: Add `cycles` to the top-level payload type**

Find this exact block (the `ParticipantsData` interface):

```ts
  nifty: (number | null)[];
  participants: Record<string, ParticipantSeries>;
  saturation?: SaturationBlock; // additive; absent on older payloads
  machine?: MachineBlock; // additive; absent on older payloads
}
```

Replace it with:

```ts
  nifty: (number | null)[];
  participants: Record<string, ParticipantSeries>;
  saturation?: SaturationBlock; // additive; absent on older payloads
  machine?: MachineBlock; // additive; absent on older payloads
  cycles?: CyclesBlock; // additive; absent on older payloads
}
```

- [ ] **Step 3: Type-check**

Run (from the repo root): `cd frontend && npx tsc --noEmit`
Expected: no new errors (the file compiles; any pre-existing unrelated
errors, if present, are not introduced by this change).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/lib/series.ts
git commit -m "$(cat <<'EOF'
Add CycleLeg/CyclesBlock types for the position-cycles payload

Additive cycles?: CyclesBlock field on ParticipantsData, matching the
saturation/machine block pattern.
EOF
)"
```

---

### Task 4: `CycleStrip.tsx` component + wire into `App.tsx`

**Files:**
- Create: `frontend/src/app/components/CycleStrip.tsx`
- Modify: `frontend/src/app/App.tsx`

**Interfaces:**
- Consumes: `CycleLeg`, `CyclesBlock`, `ParticipantsData`, `PV_COLORS`, `PV_PARTICIPANTS` from `../lib/series` (Task 3).
- Produces: `export default function CycleStrip({ data }: { data: ParticipantsData })`, rendered in `App.tsx` next to `<SaturationStrip data={pvData} />`.

- [ ] **Step 1: Create `CycleStrip.tsx`**

Create `frontend/src/app/components/CycleStrip.tsx`:

```tsx
import type { CycleLeg, ParticipantsData } from "../lib/series";
import { PV_COLORS, PV_PARTICIPANTS } from "../lib/series";

const TYPE_LABEL: Record<CycleLeg["type"], string> = {
  accumulation: "Accumulation",
  distribution: "Distribution",
};

const TYPE_TINT: Record<CycleLeg["type"], string> = {
  accumulation: "var(--ink-bull)",
  distribution: "var(--ink-bear)",
};

function fmtPrice(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtOi(v: number): string {
  return v.toLocaleString("en-IN");
}

function LegRow({ leg }: { leg: CycleLeg }) {
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td className="px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5" style={{ color: TYPE_TINT[leg.type] }}>
          <span
            style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_TINT[leg.type], display: "inline-block" }}
          />
          {TYPE_LABEL[leg.type]}
        </span>
      </td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{leg.startDate}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{leg.endDate}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink-muted)" }}>{leg.durationSessions}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtOi(leg.oiStart)}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtOi(leg.oiEnd)}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtPrice(leg.avgPrice)}</td>
      <td
        className="text-right px-3 py-1.5"
        style={{ color: leg.spread === undefined ? "var(--ink-muted)" : leg.spread >= 0 ? "var(--ink-bull)" : "var(--ink-bear)" }}
      >
        {fmtPrice(leg.spread)}
      </td>
    </tr>
  );
}

export default function CycleStrip({ data }: { data: ParticipantsData }) {
  const cycles = data.cycles;
  if (!cycles?.legs) return null;

  const actors = PV_PARTICIPANTS.filter((p) => cycles.legs[p]?.length);
  if (!actors.length) return null;

  return (
    <div className="mb-5 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--surface-card)" }}>
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-[11px]" style={{ color: "var(--ink)" }}>
          <b>Position cycles</b>{" "}
          <span style={{ color: "var(--ink-muted)" }}>
            · avg NIFTY close across each accumulation/distribution leg, OI-change weighted ·
            turn confirmed at ≥{cycles.minRetracementPct}% retracement held ≥{cycles.minHoldSessions} sessions
          </span>
        </span>
      </div>
      {actors.map((actor) => (
        <div key={actor} className="px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ink)" }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: PV_COLORS[actor], display: "inline-block" }} />
            <b>{actor}</b>
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ color: "var(--ink-muted)" }}>
                <th className="text-left font-normal px-3 py-1.5">Leg</th>
                <th className="text-right font-normal px-3 py-1.5">Start</th>
                <th className="text-right font-normal px-3 py-1.5">End</th>
                <th className="text-right font-normal px-3 py-1.5">Sessions</th>
                <th className="text-right font-normal px-3 py-1.5">OI start</th>
                <th className="text-right font-normal px-3 py-1.5">OI end</th>
                <th className="text-right font-normal px-3 py-1.5">Avg price</th>
                <th className="text-right font-normal px-3 py-1.5">Spread</th>
              </tr>
            </thead>
            <tbody>
              {cycles.legs[actor].map((leg) => (
                <LegRow key={`${actor}-${leg.startDate}-${leg.endDate}`} leg={leg} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="px-3 py-2 text-[10px]" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-inset)", color: "var(--ink-muted)" }}>
        {cycles.validation.note}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Find this exact line in `frontend/src/app/App.tsx`:

```tsx
import SaturationStrip from "./components/SaturationStrip";
import MachineStrip from "./components/MachineStrip";
```

Replace it with:

```tsx
import SaturationStrip from "./components/SaturationStrip";
import MachineStrip from "./components/MachineStrip";
import CycleStrip from "./components/CycleStrip";
```

Find this exact block:

```tsx
              <MachineStrip data={pvData} />
              <SaturationStrip data={pvData} />
```

Replace it with:

```tsx
              <MachineStrip data={pvData} />
              <SaturationStrip data={pvData} />
              <CycleStrip data={pvData} />
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/components/CycleStrip.tsx frontend/src/app/App.tsx
git commit -m "$(cat <<'EOF'
Add CycleStrip table and wire it into the participants-vs-NIFTY section

Lists each participant's accumulation/distribution legs with avg
price, OI change, and round-trip spread, modeled on SaturationStrip.
EOF
)"
```

---

### Task 5: Overlay cycle bands + avg-price lines on `ParticipantChart.tsx`

**Files:**
- Modify: `frontend/src/app/components/ParticipantChart.tsx`

**Interfaces:**
- Consumes: `data.cycles?.legs` (Task 3 type), and this component's own existing `xOf`, `mainY`, `mainTop`, `mainH`, `kOfRaw`, `dimOf`, `PV_COLORS`, `PV_PARTICIPANTS`.

- [ ] **Step 1: Add a date -> raw-index lookup**

Find this exact line in `frontend/src/app/components/ParticipantChart.tsx`:

```tsx
  const { idx, fullIdx, series, isDelta, decimated } = view;
```

Replace it with:

```tsx
  const { idx, fullIdx, series, isDelta, decimated } = view;
  const dateIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    data.dates.forEach((d, i) => m.set(d, i));
    return m;
  }, [data.dates]);
```

- [ ] **Step 2: Draw the leg bands and avg-price lines**

Find this exact block (the end of the "measured band" JSX, right before the
"NIFTY strip" comment):

```tsx
        {bandLo !== null && bandHi !== null && selP && (
          <rect
            x={xOf(bandLo)}
            y={PAD_T}
            width={Math.max(1.5, xOf(bandHi) - xOf(bandLo))}
            height={niftyH + 26 + mainH}
            fill={PV_COLORS[selP]}
            opacity={0.14}
            pointerEvents="none"
          />
        )}

        {/* ── NIFTY strip ── */}
```

Replace it with:

```tsx
        {bandLo !== null && bandHi !== null && selP && (
          <rect
            x={xOf(bandLo)}
            y={PAD_T}
            width={Math.max(1.5, xOf(bandHi) - xOf(bandLo))}
            height={niftyH + 26 + mainH}
            fill={PV_COLORS[selP]}
            opacity={0.14}
            pointerEvents="none"
          />
        )}

        {/* ── cycle legs ── accumulation/distribution bands + avg-price dashed
            lines, one pass per participant with legs overlapping the visible
            window. Always drawn (not gated on a measurement selection) since
            this is the headline reading, not an incidental annotation; an
            active selection still dims the participants it isn't focused on,
            reusing the same dimOf() the lines and bars already respect. */}
        {data.cycles && (() => {
          const cyclesLegs = data.cycles.legs;
          return PV_PARTICIPANTS.flatMap((p) => {
            const legs = cyclesLegs[p];
            if (!legs?.length) return [];
            const op = dimOf(p);
            return legs.map((leg, li) => {
              const startRaw = dateIndexOf.get(leg.startDate);
              const endRaw = dateIndexOf.get(leg.endDate);
              if (startRaw === undefined || endRaw === undefined || leg.avgPrice === null) return null;
              const kStart = kOfRaw(startRaw);
              const kEnd = kOfRaw(endRaw);
              if (kStart === null || kEnd === null) return null;
              const x0 = xOf(kStart);
              const x1 = xOf(kEnd);
              const fill = leg.type === "accumulation" ? "var(--ink-bull)" : "var(--ink-bear)";
              return (
                <g key={`${p}-cycle-${li}`} pointerEvents="none">
                  <rect
                    x={Math.min(x0, x1)}
                    y={mainTop}
                    width={Math.max(1, Math.abs(x1 - x0))}
                    height={mainH}
                    fill={fill}
                    opacity={0.09 * op}
                  />
                  <line
                    x1={x0}
                    x2={x1}
                    y1={mainY(leg.avgPrice)}
                    y2={mainY(leg.avgPrice)}
                    stroke={PV_COLORS[p]}
                    strokeWidth="1.4"
                    strokeDasharray="4 3"
                    opacity={0.65 * op}
                  />
                </g>
              );
            });
          });
        })()}

        {/* ── NIFTY strip ── */}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/components/ParticipantChart.tsx
git commit -m "$(cat <<'EOF'
Overlay accumulation/distribution cycle bands on ParticipantChart

Shades each leg's date range (green = accumulation, red =
distribution) with a dashed line at the leg's OI-weighted avg NIFTY
price, dimmed the same way the existing lines/bars dim when a
different participant is being measured.
EOF
)"
```

---

### Task 6: Manual verification in the running dashboard

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run (from `frontend/`): `npm run dev`
Expected: Vite prints a local URL (e.g. `http://localhost:5173`).

- [ ] **Step 2: Visually confirm the feature**

Open the dashboard in a browser, scroll to "NIFTY vs All Participants".
Confirm:
- A "Position cycles" strip appears above the chart, below `MachineStrip`/`SaturationStrip`, listing each participant's accumulation/distribution legs with dates, OI start/end, avg price, and spread (spread only on distribution rows).
- The chart itself shows faint green/red shaded bands behind the `futuresLong`-driven lines, each with a dashed horizontal line at that leg's avg price, in the participant's own line color.
- Clicking a line to start a measurement (the existing two-anchor tool) dims the cycle bands of the other three participants, matching how their price lines already dim.
- Switching the book-mode/metric/range selectors does not throw a console error, and bands re-align correctly when the visible date range changes.

- [ ] **Step 3: Stop the dev server**

Press `Ctrl+C` in the terminal running `npm run dev`.

No commit for this task — it is a verification-only pass. If any check in
Step 2 fails, fix the relevant task above and re-run this task before
considering the plan complete.

---

## Self-Review Notes

- **Spec coverage:** turn detection (Task 1) · leg avg-price formula (Task 1)
  · `build_cycles_block` additive JSON key (Task 2) · frontend types (Task 3)
  · dedicated table display (Task 4) · chart overlay display (Task 5) ·
  validation/sanity checks (Tasks 1 and 2) · manual UI confirmation (Task 6).
  All design-doc sections are covered.
- **Deviation from the design doc's validation wording, noted explicitly:**
  the design doc says "matches a standalone recompute from the DB" — Task 2
  implements this as an independent load via `research.data.load()` plus
  invariant checks (alternating turn types, avg price within the leg's own
  NIFTY range, and `build_cycles_block` agreeing with `cycle_legs`), the same
  pattern `test_signal_parity.py` already uses for other signals in this
  codebase. It is **not** a second independent zigzag implementation (unlike
  `research/episodes.py`'s pandas reimplementation of `rolling_percentile`) —
  writing a second, subtly-different turn detector purely to satisfy a
  parity test would risk the two diverging for reasons unrelated to
  correctness, which is worse than the single-implementation invariant test
  this plan uses instead.
- **Type consistency:** `CycleLeg`/`CyclesBlock` (Task 3) are used identically
  in `CycleStrip.tsx` (Task 4) and `ParticipantChart.tsx` (Task 5) — same
  field names (`avgPrice`, `oiStart`, `oiEnd`, `startDate`, `endDate`,
  `durationSessions`, `spread`, `type`).
