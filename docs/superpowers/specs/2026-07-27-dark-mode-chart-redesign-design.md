# Dark Mode + Selector-Driven Chart Redesign

**Date:** 2026-07-27
**Status:** Approved

## Goal

Replicate a competitor's dark chart UI in Equinext Pulse while keeping the NIFTY
price panel — the feature they lack — as the anchor of every view.

## Decisions

| Question | Decision |
|---|---|
| Theme | Light + dark **toggle**; dark is the default on first load |
| Chart layout | NIFTY panel on top + **one** selector-driven panel below |
| Top-level tabs | **Index F&O only** (Stock F&O / Total Positions deferred) |
| Section 3 (`sec-positioning`) | **Deleted** |
| Section 5 (`sec-driver`) | **Kept**, restyled dark |
| Series palette | Fixed across both themes — never shifts mid-analysis |

## Series palette

Adopted from the reference images. These are **constants, not theme tokens**.

| Series | Colour | Legend label |
|---|---|---|
| Client | `#3FA9F5` blue | Client (Retail) |
| DII | `#E8A33D` amber | DII (Domestic Funds) |
| FII | `#B08FE8` purple | FII (Smart Money) |
| Pro | `#4CC77C` green | Pro (Prop Desks) |

## Surface tokens

Defined in `src/styles/theme.css` under `:root` (light) and `.dark`.
`.dark` is applied to `document.documentElement`.

| Token | Light | Dark |
|---|---|---|
| `--surface-page` | `#F7F6F2` | `#0B0F14` |
| `--surface-card` | `#FFFFFF` | `#131A22` |
| `--surface-inset` | `#EDECEA` | `#0E141B` |
| `--surface-raised` (active pill) | `#FFFFFF` | `#1C2733` |
| `--ink` | `#12151C` | `#E6EDF3` |
| `--ink-muted` | `#9E9A92` | `#8B949E` |
| `--grid` | `#E5E1D8` | `#1F2933` |
| `--border` | `rgba(18,21,28,0.09)` | `#1E2A36` |

`--surface-card` and `--surface-raised` must stay distinct — mapping both to one
token makes active toggle pills invisible in dark mode.

Sentiment tints use low-alpha semantic colours, not pale pastels, so they survive
on a near-black page: `rgba(76,199,124,0.12)` bullish, `rgba(192,54,44,0.15)` bearish.

## Chart structure

Top-level book mode (3) × metric pill (6) = **18 combinations**.

Pill labels adapt to the active book mode:

| Pill | Main | Long Book | Short Book |
|---|---|---|---|
| Index Futures | `futures` (Net) | `futuresLong` (Long) | `futuresShort` (Short) |
| Index Futures Δ | Δ`futures` | Δ`futuresLong` | Δ`futuresShort` |
| Index Calls | `calls` | `callsLong` | `callsShort` |
| Index Calls Δ | Δ`calls` | Δ`callsLong` | Δ`callsShort` |
| Index Puts | `puts` | `putsLong` | `putsShort` |
| Index Puts Δ | Δ`puts` | Δ`putsLong` | Δ`putsShort` |

The NIFTY panel persists across all 18 combinations.

### Render modes

`Line` (spline-smoothed, dots at each point) and `Bar` (grouped, four bars per date).
White dashed vertical crosshair on hover; dark tooltip with date header and one
colour-chipped row per participant.

## Time ranges

`1M · 3M · 6M · 1Y · 3Y · All`, **default 1M**.

Ranges are calendar-relative to the last date in the file, not fixed row counts.
Slicing is a single index range `[i0, i1]` applied in lockstep to `dates`,
`nifty`, `expiry` and every participant series — they are parallel columnar arrays.

## Correctness constraints

1. **Δ computed before slicing.** Derive day-over-day deltas on the full array,
   then slice. Slicing first makes the first point of every range null or wrong.
   `longBookDelta`/`shortBookDelta` exist in the JSON; the gross-leg deltas
   (`futuresLong` etc.) do not and are derived client-side.
2. **Decimation never applies to Δ pills.** Stride-sampling a Δ series hides the
   spikes it exists to show. Decimate only the level pills, above ~800 points.
   Always preserve index `0` and `n−1` so axis endpoints match the range label.
3. **Summary tiles ignore the range filter.** They show the latest day, always.
4. **Zero-variance series must not crash the y-domain.** DII's index option
   columns are literally `0` in the older data. DII renders as a flat line at zero
   in Long/Short Book calls/puts — that is correct, not a bug. Guard `min === max`.

## Cleanup

Deleting section 3 orphans `FiiNiftyChart`, `fii_vs_nifty.json`, the `caveats`
array and the `participant` state. Remove them rather than leaving dead code.
Section 5 keeps its own `dfHover`/`dfFull` state and is not merged into the new
chart's state.

## Verification

`npm run build` proves nothing about theme correctness. Run the dev server and
step all 18 combinations in **both themes** at **1M** and at **All**.

### Results (2026-07-27)

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors (tsconfig.json added — the project had none) |
| `vite build` | clean, 30 modules, 210 kB JS / 92 kB CSS |
| Dev server, fresh port | all modules transform, no errors |
| Series logic tests | **37/37 pass** |
| Visual pass over 18 combos × 2 themes | **NOT DONE** — needs a human |

Logic tests cover: Δ-before-slice (asserts the two orderings genuinely differ),
decimation preserving index `0` and `n−1` under the 800 cap, `domainOf` surviving
zero-variance input, calendar-relative range starts, and metric/label resolution
across all three book modes.

### Known limitations

- **§1's long/short cards are matplotlib PNGs** with baked-in light backgrounds.
  They will read as bright plates in dark mode until `plot_long_short.py` is
  re-run with a dark style. Not fixable from the frontend.
- **`participant_report.json` is still 127 days (0.65 MB).** Regenerating it over
  the full archive lands it near 13 MB, fetched twice with `cache: "no-store"`.
  Split it before backfilling §2.
- **`fii_vs_nifty.json` (0.83 MB) is now orphaned** — §3 was its only consumer,
  but `plot_fii_vs_nifty.py` still writes it.
