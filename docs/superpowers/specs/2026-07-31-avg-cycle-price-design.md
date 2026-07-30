# Avg Accumulation/Distribution Price per Position Cycle

**Date:** 2026-07-31
**Status:** Approved

## Goal

For each participant (FII, DII, Pro, Client), find the swing peaks/troughs in
their net long-futures position and compute an OI-weighted average NIFTY price
across each leg — the "average price at which the long was built" (trough→peak)
and "average price at which it was sold" (peak→trough). Show both on the
dashboard alongside the existing chart and saturation strip.

## Why this is derived, not read

The DB (`participant_oi`, `index_prices`) has no per-participant execution
price — only daily OI contract counts and NIFTY OHLC (shared across all
participants). There is no existing peak/trough turn-detector in the repo;
the current signal engine (`signals.py`, `research/episodes.py`) only does
percentile-threshold episodes, not local-extrema turns. This feature adds a
new, separate mechanism rather than reusing the saturation engine.

## Decisions

| Question | Decision |
|---|---|
| Which series defines "long" | `futuresLong` (net index-futures long) — not total `longBook` |
| Turn confirmation rule | Combined: reversal ≥ R% of the current leg's range **and** holds ≥ D sessions |
| Price source for the average | NIFTY close (the only price series available; shared across participants) |
| Averaging formula | OI-change-weighted: `Σ(nifty[t] × |Δlong[t]|) / Σ|Δlong[t]|` over the leg |
| Same formula both directions | Yes — no separate buy/sell semantics, "avg sell price" was shorthand for VWAP-of-leg |
| Display | Both: shaded overlay bands + avg-price dashed line on `ParticipantChart`, plus a new `CycleStrip` table |

## Backend: turn detection

New module `research/cycles.py` (sibling to `research/episodes.py`).

- Input: a participant's `futuresLong[]` paired with `dates[]` and `nifty[]`
  from `participants_vs_nifty.json`.
- Zigzag swing detector with two independently-tunable thresholds:
  - `min_retracement_pct` — reversal must retrace at least this % of the
    pending leg's range before a turn is provisionally flagged.
  - `min_hold_sessions` — the new direction must persist at least this many
    sessions before the turn is confirmed (rejects single-day whipsaws).
  - A provisional turn that doesn't hold for `min_hold_sessions` is discarded
    and the prior swing extends through the whipsaw.
- Defaults are tuned per participant (FII/DII/Pro/Client have different OI
  scales) — start from values that produce 3–8 confirmed cycles/year on
  historical FII data as a sanity anchor, then hand-tune per participant.
- Output: ordered turns `[{date, type: 'peak'|'trough', futuresLong}]`.

## Backend: leg average-price computation

For each consecutive turn pair (trough→peak = accumulation, peak→trough =
distribution):

```
avgPrice(leg) = Σ( nifty[t] × |Δfutureslong[t]| ) / Σ|Δfutureslong[t]|   for t in (legStart, legEnd]
```

Each leg record: `{startDate, endDate, type, avgPrice, oiStart, oiEnd,
niftyStart, niftyEnd, durationSessions}`. For a completed
trough→peak→trough round trip, also compute:

```
spread = distributionAvgPrice - accumulationAvgPrice
```

as a rough "did this round trip work out" indicator.

`build_cycles_block()` (alongside the existing `build_saturation_block()`)
appends a new top-level `cycles: { FII: [...], DII: [...], Pro: [...],
Client: [...] }` block to `participants_vs_nifty.json`, generated through the
same pipeline that produces `saturation` today.

## Frontend

- `series.ts`: add `CycleLeg` and `CyclesBlock` types; extend the top-level
  payload type with `cycles`.
- `ParticipantChart.tsx`: shade each leg's date range behind the
  `futuresLong` line — green for accumulation, red for distribution — with a
  dashed horizontal line at that leg's `avgPrice` spanning the shaded region.
- New `CycleStrip.tsx` (modeled on `SaturationStrip.tsx`): a table below the
  chart per participant — start/end date, leg type, avg price, OI change, and
  `spread` for completed round trips. Wired into `App.tsx` next to the
  existing `SaturationStrip`.

## Validation

- One parity test (alongside `test_signal_parity.py`'s pattern) confirming
  the dashboard's `cycles` block matches a standalone recompute from the DB.
- Sanity check: each leg's `avgPrice` must fall within that leg's own NIFTY
  high/low range over the same date span — a violation means the weighting
  formula or date alignment is broken.

## Out of scope

- No new price data source — NIFTY close remains the only price input.
- No change to the existing saturation/percentile signal engine.
- `SignalStrip.tsx` (currently dead/unwired) is untouched by this work.
