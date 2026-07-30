// ─────────────────────────────────────────────────────────────────────────────
// Series maths for the participant charts.
//
// Everything here is pure and framework-free so it can be reasoned about (and
// tested) without React. The chart component does layout and SVG; this module
// decides WHAT numbers get drawn.
// ─────────────────────────────────────────────────────────────────────────────

/** One participant's columnar series, all parallel to the shared `dates` axis. */
export interface ParticipantSeries {
  futures: (number | null)[];
  calls: (number | null)[];
  puts: (number | null)[];
  // Gross legs (always ≥ 0) — the Long Book / Short Book modes plot these.
  futuresLong: (number | null)[];
  futuresShort: (number | null)[];
  callsLong: (number | null)[];
  callsShort: (number | null)[];
  putsLong: (number | null)[];
  putsShort: (number | null)[];
  longBook: (number | null)[];
  shortBook: (number | null)[];
  longBookDelta: (number | null)[];
  shortBookDelta: (number | null)[];
}

/** Evidence travelling with a signal, so a number can never render without it. */
export interface SignalValidation {
  status: string; // "validated" | "descriptive" | "NOT VALIDATED"
  attacksSurvived?: string; // "5/5"
  failed?: string[];
  note: string;
}

/** One historical firing of the saturation rule, with what followed. */
export interface SaturationEpisode {
  date: string;
  peakPercentile: number | null;
  sessions: number;
  niftyAt: number | null;
  niftyAfter: number | null;
  forwardPct: number | null;
  complete: boolean;
}

/**
 * Short-book saturation — the only rule in this project that survives all five
 * validation attacks. Emitted by signals.build_saturation_block().
 *
 * ABSENT rather than zeroed when history is too short to rank, so the UI
 * renders nothing instead of a confident-looking default.
 */
export interface SaturationBlock {
  schemaVersion: number;
  actor: string; // "FII"
  window: number; // 250 sessions
  horizon: number; // 30 sessions
  triggerPercentile: number; // 98
  armedPercentile: number; // 90
  latest: {
    date: string;
    shortBook: number;
    percentile: number;
    state: "quiet" | "armed" | "firing" | "unknown";
    triggerLevel: number;
    gapContracts: number;
    gapPercent: number | null;
    rangeLow: number;
    rangeHigh: number;
  };
  episodes: SaturationEpisode[];
  episodeCount: number;
  episodesUp: number;
  episodesComplete: number;
  validation: SignalValidation;
}

/** One FIRE event as SERVED by signals.build_machine_block. The card computes
 *  its own (see runPeakReversal) so the threshold can be changed live; this type
 *  describes the pre-computed default that ships in the payload. */
export interface ServedMachineEvent {
  date: string;
  peakDate: string | null;
  peak: number;
  fireLevel: number;
  shortBook: number;
  offPeakPct: number;
  niftyAt: number | null;
  niftyAfter: number | null;
  forwardPct: number | null;
  complete: boolean;
}

/** The served machine's reading at ONE duration. */
export interface ServedMachineDuration {
  window: number;
  state: "idle" | "active" | "armed" | "fired";
  shortBook: number | null;
  trailingPeak: number;
  activateLevel: number;
  pctOfPeak: number | null;
  fireLevelIfPeakNow: number;
  events: ServedMachineEvent[];
  eventCount: number;
  eventsUp: number;
  eventsComplete: number;
}

/**
 * Peak-reversal machine — enters on the ROLL-OVER, not the extreme.
 * IDLE -> ACTIVE (book >= 90% of trailing peak) -> ARMED (stops making highs)
 * -> FIRED (falls back to 90% of that peak). Evaluated per duration, because
 * the "past peak" for a 1Y view is not the same number as for a 3Y view.
 */
export interface ServedMachineBlock {
  schemaVersion: number;
  actor: string;
  activateFraction: number;
  fireFraction: number;
  hold: number;
  correlation: {
    dailyChangeVsReturn: number | null;
    levelVsClose: number | null;
  };
  durations: Record<string, ServedMachineDuration>;
  validation: SignalValidation;
}

// ─── peak-reversal machine, client side ──────────────────────────────────────
//
// Ported from signals.peak_reversal_machine so the activation threshold can be
// changed in the UI and the NUMBERS re-run, not just the drawing. The Python
// implementation stays the reference used by the backtests
// (research/experiments/phase5_machine.py); at the default 90% the two agree on
// event count and dates for every window — check with that script if this is
// edited.

export const MACHINE_WINDOWS: { key: string; label: string; sessions: number }[] = [
  { key: "1M", label: "1M", sessions: 21 },
  { key: "6M", label: "6M", sessions: 126 },
  { key: "1Y", label: "1Y", sessions: 250 },
  { key: "3Y", label: "3Y", sessions: 750 },
  { key: "ALL", label: "All Time", sessions: Number.MAX_SAFE_INTEGER },
];

/** 40%…90% in 5-point steps. 90 is the researched default; the rest are the
 *  user's own risk, which the dropdown says out loud. */
export const ACTIVATION_CHOICES = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
export const ACTIVATION_DEFAULT = 90;
export const MACHINE_HOLD = 30;

export type MachineState = "idle" | "active" | "armed" | "fired";

export interface MachineEvent {
  date: string;
  peakDate: string | null;
  peak: number;
  shortBook: number;
  offPeakPct: number;
  niftyAt: number | null;
  niftyAfter: number | null;
  forwardPct: number | null;
  complete: boolean;
}

export interface MachineResult {
  state: MachineState;
  shortBook: number | null;
  trailingPeak: number;
  activateLevel: number;
  /** where today's book sits as a % of the trailing peak — the meter's position */
  pctOfPeak: number | null;
  runPeak: number;
  fireLevel: number;
  events: MachineEvent[];
  eventsComplete: number;
  eventsUp: number;
  medianForward: number | null;
  baselineMedian: number | null;
  winRate: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * IDLE → ACTIVE (book ≥ frac of trailing peak) → ARMED (stops making new highs)
 * → FIRED (falls back to frac of the peak it just made). A new high while ARMED
 * lifts the peak and moves the fire level with it.
 *
 * Only information available on the day is used: `runPeak` is the running
 * maximum so far, never the eventual maximum.
 */
export function runPeakReversal(
  dates: string[],
  close: (number | null)[],
  book: (number | null)[],
  sessions: number,
  activateFrac: number,
  hold: number = MACHINE_HOLD,
): MachineResult {
  const n = book.length;
  const events: MachineEvent[] = [];
  let state: MachineState = "idle";
  let runPeak = 0;
  let peakDate: string | null = null;
  let cooldown = 0;
  let trailingPeak = 0;

  // rolling max over `sessions`; for ALL the window exceeds n so it is the
  // all-time high to date
  const peakAt = (i: number): number => {
    const lo = Math.max(0, i - sessions + 1);
    let mx = 0;
    for (let k = lo; k <= i; k++) {
      const v = book[k];
      if (v != null && v > mx) mx = v;
    }
    return mx;
  };

  for (let i = 0; i < n; i++) {
    const b = book[i];
    const ref = peakAt(i);
    trailingPeak = ref;
    if (b == null || ref <= 0) continue;

    if (state === "fired") {
      cooldown -= 1;
      if (cooldown <= 0 && b < activateFrac * ref) state = "idle";
      continue;
    }
    if (state === "idle") {
      if (b >= activateFrac * ref) {
        state = "active";
        runPeak = b;
        peakDate = dates[i];
      }
    } else if (state === "active") {
      if (b >= runPeak) {
        runPeak = b;
        peakDate = dates[i];
      } else state = "armed";
    } else if (state === "armed") {
      if (b >= runPeak) {
        runPeak = b;
        peakDate = dates[i];
        state = "active";
      } else if (b <= activateFrac * runPeak) {
        const j = Math.min(i + hold, n - 1);
        const a = close[i];
        const z = close[j];
        events.push({
          date: dates[i],
          peakDate,
          peak: Math.round(runPeak),
          shortBook: Math.round(b),
          offPeakPct: Math.round((b / runPeak - 1) * 1000) / 10,
          niftyAt: a,
          niftyAfter: z,
          forwardPct: a == null || z == null || a === 0 ? null : Math.round((z / a - 1) * 10000) / 100,
          complete: i + hold < n,
        });
        state = "fired";
        cooldown = hold;
      }
    }
  }

  const done = events.filter((e) => e.complete && e.forwardPct != null);
  const fwd = done.map((e) => e.forwardPct as number);

  // unconditional forward move over the same horizon — without it a positive
  // median means nothing, because NIFTY drifts up
  const base: number[] = [];
  for (let i = Math.min(sessions, 250); i < n - hold - 1; i++) {
    const a = close[i];
    const z = close[i + hold];
    if (a != null && z != null && a !== 0) base.push((z / a - 1) * 100);
  }

  const i = n - 1;
  const b = book[i];
  return {
    state,
    shortBook: b ?? null,
    trailingPeak,
    activateLevel: Math.round(activateFrac * trailingPeak),
    pctOfPeak: b != null && trailingPeak > 0 ? Math.round((b / trailingPeak) * 1000) / 10 : null,
    runPeak: Math.round(runPeak),
    fireLevel: Math.round(activateFrac * (runPeak || trailingPeak)),
    events,
    eventsComplete: done.length,
    eventsUp: fwd.filter((v) => v > 0).length,
    medianForward: median(fwd),
    baselineMedian: median(base),
    winRate: fwd.length ? fwd.filter((v) => v > 0).length / fwd.length : null,
  };
}

/** Bump in lockstep with signals.SIGNAL_SCHEMA_VERSION. A mismatch is rendered
 *  as a visible warning rather than silently blank fields. */
export const SIGNAL_SCHEMA_EXPECTED = 2;

export interface ParticipantsData {
  symbol: string;
  start: string;
  end: string;
  count: number;
  dates: string[];
  dateDisplay: string[]; // "20 Jul 2026"
  day: string[]; // "Monday"
  expiry: boolean[]; // weekly expiry flag
  nifty: (number | null)[];
  participants: Record<string, ParticipantSeries>;
  saturation?: SaturationBlock; // additive; absent on older payloads
  machine?: ServedMachineBlock; // additive; absent on older payloads
}

/**
 * A two-anchor measurement on ONE participant's line.
 *
 * The index unit is chart-local and deliberately asymmetric:
 *   §3 (ParticipantChart) stores RAW indices into the full `dates` array — its
 *      displayed points are decimated and re-index whenever range OR metric
 *      changes (Δ views are never thinned), so a displayed position would
 *      silently come to mean a different date.
 *   §4 (DriverFuturesChart) is handed an already-sliced, undecimated window, so
 *      indices there are window-relative and are cleared when the range moves.
 *
 * `b` is null while the second anchor is still being picked.
 */
export interface ChartSelection {
  participant: string;
  a: number;
  b: number | null;
}

/** Fixed across BOTH themes — series colour must never shift mid-analysis. */
/** 1 -> 1st, 13 -> 13th. Mirrors signals.ordinal() so percentile text matches
 *  the CLI and the backtest output word for word. */
export function ordinal(n: number | null | undefined): string {
  if (n == null) return "n/a";
  const i = Math.round(n);
  const suffix =
    i % 100 >= 10 && i % 100 <= 20
      ? "th"
      : { 1: "st", 2: "nd", 3: "rd" }[i % 10] ?? "th";
  return `${i}${suffix}`;
}

export const PV_PARTICIPANTS = ["Client", "DII", "FII", "Pro"] as const;
export type ParticipantName = (typeof PV_PARTICIPANTS)[number];

export const PV_COLORS: Record<string, string> = {
  Client: "#3FA9F5", // blue
  DII: "#E8A33D", // amber
  FII: "#B08FE8", // purple
  Pro: "#4CC77C", // green
};

/** Role parentheticals — they read better than bare acronyms in a legend. */
export const PV_ROLE: Record<string, string> = {
  Client: "Client (Retail)",
  DII: "DII (Domestic Funds)",
  FII: "FII (Smart Money)",
  Pro: "Pro (Prop Desks)",
};

// ── Book mode ────────────────────────────────────────────────────────────────

export type BookMode = "main" | "longBook" | "shortBook";

export const PV_MODES: { key: BookMode; label: string }[] = [
  { key: "main", label: "Main" },
  { key: "longBook", label: "Long Book" },
  { key: "shortBook", label: "Short Book" },
];

/** The suffix each mode gives its metric pills: Net → Long → Short. */
const MODE_SUFFIX: Record<BookMode, string> = {
  main: "Net",
  longBook: "Long",
  shortBook: "Short",
};

// ── Metrics ──────────────────────────────────────────────────────────────────

export type MetricKey =
  | "futures"
  | "futuresDelta"
  | "calls"
  | "callsDelta"
  | "puts"
  | "putsDelta";

/** Which raw field each (mode, instrument) pair reads. */
const FIELD: Record<BookMode, { futures: keyof ParticipantSeries; calls: keyof ParticipantSeries; puts: keyof ParticipantSeries }> = {
  main: { futures: "futures", calls: "calls", puts: "puts" },
  longBook: { futures: "futuresLong", calls: "callsLong", puts: "putsLong" },
  shortBook: { futures: "futuresShort", calls: "callsShort", puts: "putsShort" },
};

export const PV_METRICS: { key: MetricKey; instrument: "futures" | "calls" | "puts"; isDelta: boolean; noun: string }[] = [
  { key: "futures", instrument: "futures", isDelta: false, noun: "Index Futures" },
  { key: "futuresDelta", instrument: "futures", isDelta: true, noun: "Index Futures" },
  { key: "calls", instrument: "calls", isDelta: false, noun: "Index Calls" },
  { key: "callsDelta", instrument: "calls", isDelta: true, noun: "Index Calls" },
  { key: "puts", instrument: "puts", isDelta: false, noun: "Index Puts" },
  { key: "putsDelta", instrument: "puts", isDelta: true, noun: "Index Puts" },
];

/** "Index Futures (Δ Long)" etc. — the label adapts to the active book mode. */
export function metricLabel(key: MetricKey, mode: BookMode): string {
  const m = PV_METRICS.find((x) => x.key === key)!;
  const suffix = MODE_SUFFIX[mode];
  return `${m.noun} (${m.isDelta ? "Δ " : ""}${suffix})`;
}

/** Resolve a (metric, mode) pair to the raw field name plus a delta flag. */
export function resolveMetric(key: MetricKey, mode: BookMode): { field: keyof ParticipantSeries; isDelta: boolean } {
  const m = PV_METRICS.find((x) => x.key === key)!;
  return { field: FIELD[mode][m.instrument], isDelta: m.isDelta };
}

// ── Deltas ───────────────────────────────────────────────────────────────────

/**
 * Day-over-day change.
 *
 * MUST be computed on the FULL array before any range slicing — deriving it
 * from an already-sliced window makes the first point of every range null (or
 * silently wrong, if you back-fill it). Index 0 of the full series is genuinely
 * unknowable and stays null.
 */
export function toDelta(vals: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(vals.length).fill(null);
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1];
    const b = vals[i];
    out[i] = a === null || a === undefined || b === null || b === undefined ? null : b - a;
  }
  return out;
}

// ── Time ranges ──────────────────────────────────────────────────────────────

export type RangeKey = "1M" | "3M" | "6M" | "1Y" | "3Y" | "ALL";

export const PV_RANGES: { key: RangeKey; label: string; months: number | null }[] = [
  { key: "1M", label: "1M", months: 1 },
  { key: "3M", label: "3M", months: 3 },
  { key: "6M", label: "6M", months: 6 },
  { key: "1Y", label: "1Y", months: 12 },
  { key: "3Y", label: "3Y", months: 36 },
  { key: "ALL", label: "All", months: null },
];

/**
 * First index inside `range`, measured backwards in CALENDAR months from the
 * last date in the file (not a fixed row count — trading days per month vary).
 * Returns 0 for "ALL" or when the file is shorter than the requested window.
 */
export function rangeStartIndex(dates: string[], range: RangeKey): number {
  if (!dates.length) return 0;
  const spec = PV_RANGES.find((r) => r.key === range);
  if (!spec || spec.months === null) return 0;

  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const cutoff = new Date(last);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - spec.months);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const i = dates.findIndex((d) => d >= cutoffISO);
  return i < 0 ? 0 : i;
}

// ── Decimation ───────────────────────────────────────────────────────────────

/** Above this many points we thin LEVEL series before drawing. */
export const DECIMATE_ABOVE = 800;

/**
 * Evenly-strided indices covering [0, n), always including the first and last
 * point so the axis endpoints still match the selected range label.
 *
 * Never call this for a Δ series: stride-sampling drops exactly the one-day
 * spikes a delta chart exists to show.
 */
export function decimateIndices(n: number, max: number = DECIMATE_ABOVE): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const step = (n - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(Math.round(k * step));
  out[0] = 0;
  out[out.length - 1] = n - 1;
  // Rounding can repeat an index; de-dupe while preserving order.
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

// ── Whole-dataset slicing ────────────────────────────────────────────────────
// These operate on a full ParticipantsData rather than a single series. They
// were moved here out of App.tsx so there is exactly ONE implementation of
// range/decimation logic in the codebase.

/** Alias kept for the §4/§5 call sites that predate this module. */
export const pvRangeStart = rangeStartIndex;
export const PV_MAX_POINTS = DECIMATE_ABOVE;

/**
 * Which indices survive decimation, or null when none is needed.
 *
 * ALWAYS keeps the first and — critically — the LAST index: header chips read
 * `series[N-1]`, and a plain `i += stride` walk ends on the last multiple of
 * stride, not on N-1, which would silently show a stale day at wide ranges.
 */
export function pvKeepIndices(n: number, max: number): number[] | null {
  if (n <= max) return null;
  const stride = Math.ceil((n - 1) / (max - 1));
  const keep: number[] = [];
  for (let i = 0; i < n - 1; i += stride) keep.push(i);
  keep.push(n - 1);
  return keep;
}

/**
 * Apply ONE index set to every parallel array in lockstep — the date axis, the
 * NIFTY closes, the expiry flags and every field of every participant series.
 * Series fields are iterated generically: `ParticipantSeries` has 13 keys and a
 * hand-written list would silently yield `undefined` for whichever one it missed.
 */
export function pvPick(data: ParticipantsData, idx: number[]): ParticipantsData {
  const take = <T,>(arr: T[]): T[] => idx.map((i) => arr[i]);
  const participants: Record<string, ParticipantSeries> = {};
  for (const [p, s] of Object.entries(data.participants)) {
    const out: Record<string, (number | null)[]> = {};
    for (const k of Object.keys(s)) out[k] = take((s as unknown as Record<string, (number | null)[]>)[k]);
    participants[p] = out as unknown as ParticipantSeries;
  }
  return {
    ...data,
    count: idx.length,
    start: data.dates[idx[0]] ?? data.start,
    end: data.dates[idx[idx.length - 1]] ?? data.end,
    dates: take(data.dates),
    dateDisplay: take(data.dateDisplay),
    day: take(data.day),
    expiry: take(data.expiry),
    nifty: take(data.nifty),
    participants,
  };
}

/** The window [i0 .. i1], every parallel array cut identically. */
export function sliceParticipantsData(data: ParticipantsData, i0: number, i1: number): ParticipantsData {
  const lo = Math.max(0, Math.min(i0, data.dates.length - 1));
  const hi = Math.max(lo, Math.min(i1, data.dates.length - 1));
  if (lo === 0 && hi === data.dates.length - 1) return data;
  const idx: number[] = [];
  for (let i = lo; i <= hi; i++) idx.push(i);
  return pvPick(data, idx);
}

/**
 * Stride-sample a wide window down to a drawable number of points. ONLY safe
 * for LEVEL panels: §5 reads day-over-day Δs, and sampling would quietly turn
 * those into multi-day Δs and mis-attribute the daily driver.
 */
export function decimateParticipantsData(data: ParticipantsData, max: number): ParticipantsData {
  const idx = pvKeepIndices(data.dates.length, max);
  return idx ? pvPick(data, idx) : data;
}

// ── Domain ───────────────────────────────────────────────────────────────────

/**
 * Min/max across every supplied series, padded ~6%.
 *
 * Guards the degenerate case: DII's index option columns are literally 0 in the
 * older NSE files, so in Long/Short Book calls/puts DII is a flat line at zero.
 * That is correct data, not a bug — but min === max would collapse the scale to
 * a division by zero, so we widen it to a readable band.
 */
export function domainOf(series: (number | null)[][], includeZero: boolean): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** 171181 → "171.181k", -1_250_000 → "-1.25M". Matches the reference tooltips. */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `${(v / 1000).toFixed(3).replace(/\.?0+$/, "")}k`;
  return `${Math.round(v)}`;
}

/** Terser variant for axis ticks: 30000 → "30k". */
export function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1000) return `${Math.round(v / 1000)}k`;
  return `${Math.round(v)}`;
}

/** "2026-07-24" → "24/07/2026", the format the reference charts use. */
export function fmtDateDMY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ── Smoothing ────────────────────────────────────────────────────────────────

/**
 * Monotone-ish cubic path through the points, matching the smoothed look of the
 * reference charts. Control points are pulled back to 1/3 of each gap, which
 * keeps the curve from overshooting into visual artefacts on spiky Δ series.
 */
export function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Split into runs of consecutive non-null points so gaps break the line. */
export function segmentsOf(
  vals: (number | null)[],
  idx: number[],
  xOf: (i: number) => number,
  yOf: (v: number) => number,
): { x: number; y: number }[][] {
  const segs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  idx.forEach((i, k) => {
    const v = vals[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else {
      cur.push({ x: xOf(k), y: yOf(v) });
    }
  });
  if (cur.length) segs.push(cur);
  return segs;
}
