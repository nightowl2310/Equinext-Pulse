import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BookMode,
  type ChartSelection,
  type MetricKey,
  type ParticipantSeries,
  type ParticipantsData,
  type RangeKey,
  PV_COLORS,
  PV_METRICS,
  PV_MODES,
  PV_PARTICIPANTS,
  PV_RANGES,
  metricLabel,
  pvRangeStart,
  sliceParticipantsData,
} from "./lib/series";
import { ParticipantChart, type RenderMode } from "./components/ParticipantChart";
import PeakReversalCard from "./components/PeakReversalCard";
import CycleStrip from "./components/CycleStrip";

type Tab = "daily" | "weekly" | "monthly";
type Section = "weekly" | "participant" | "oi";
type Sentiment = "bullish" | "bearish";

// ─── data contract ───────────────────────────────────────────────────────────
// These types mirror, exactly, the JSON that analysis.py writes to
// frontend/public/data/{daily,weekly,monthly}.json. This page does no maths:
// every value below comes from the backend. See the README ("Data contract").
//
// `pct` is null (never 0, never Infinity) when the old value was 0 -> "N/A".

interface Move {
  field: string;
  oldVal: number;
  newVal: number;
  change: number;
  pct: number | null;
  note: string; // e.g. "adding index call longs" — not rendered yet (see gap report)
}

interface Book {
  longChange: number | null;
  longPct: number | null;
  shortChange: number | null;
  shortPct: number | null;
}

interface Actor {
  name: string;
  coverage: boolean;
  book: Book;
  moves: Move[];
}

interface Signal {
  text: string;
  sentiment: Sentiment;
}

interface DateInfo {
  iso: string;
  display: string; // "09 Jul 2026 (Thu · expiry)" — pre-composed by the backend
  dateOnly: string;
  weekday: string;
  expiry: boolean;
}

interface Total {
  field: string;
  oldVal: number;
  newVal: number;
  change: number;
}

interface Read {
  score: number;
  tilt: string;
  signals: Signal[];
}

interface BriefData {
  timeframe: Tab;
  available: boolean;
  reason: string | null;
  marketLabel: string;
  generatedAt: string;
  generatedAtDisplay: string;
  asOf: { iso: string; display: string };
  dateA: DateInfo | null;
  dateB: DateInfo | null;
  headline: string | null;
  note: string | null; // "Client hidden — …" when an actor was held back
  notes: string[];
  actors: Actor[];
  total: Total | null;
  read: Read | null;
  action: string | null;
  disclaimer: string;
  footnote: string;
}

// ─── palette constants ───────────────────────────────────────────────────────
const GREEN = "var(--ink-bull)";
const RED = "var(--ink-bear)";
const TEAL = "#0EA5A4";
const INK = "var(--ink)";
const BG = "var(--surface-page)";
const GRID = "var(--grid)";

// ─── number helpers ──────────────────────────────────────────────────────────
const MUTED = "var(--ink-muted)";

function fmt(v: number): string {
  return Math.abs(v).toLocaleString("en-US");
}
function signed(v: number): string {
  // No sign on zero: "+0" would read as an increase (and get coloured green).
  if (v === 0) return "0";
  return (v > 0 ? "+" : "−") + fmt(v);
}
function pctStr(v: number | null): string {
  // The backend sends null when the old value was 0, so a percentage would be
  // meaningless. Show "N/A" rather than a fake number or Infinity.
  if (v === null || v === undefined) return "N/A";
  if (v === 0) return "0.0%";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}
/** Green up, red down, muted for flat/unknown — never colour a zero. */
function toneOf(v: number | null): string {
  if (v === null || v === undefined || v === 0) return MUTED;
  return v > 0 ? GREEN : RED;
}

// ─── sub-components ──────────────────────────────────────────────────────────

function Gauge({ score }: { score: number }) {
  const cx = 100;
  const cy = 88;
  const r = 65;
  const theta = ((score + 1) / 2) * Math.PI;
  const nx = cx - r * Math.cos(theta);
  const ny = cy - r * Math.sin(theta);
  const arcPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <svg viewBox="0 0 200 100" className="w-full" aria-label={`Gauge: ${score}`}>
      {/* Track */}
      <path d={arcPath} fill="none" stroke="var(--grid)" strokeWidth="10" strokeLinecap="round" />
      {/* Bearish end */}
      <circle cx={cx - r} cy={cy} r="5" fill={RED} />
      {/* Bullish end */}
      <circle cx={cx + r} cy={cy} r="5" fill={GREEN} />
      {/* Neutral tick */}
      <circle cx={cx} cy={cy - r} r="3" fill="var(--hairline)" />
      {/* Needle shaft */}
      <line
        x1={cx}
        y1={cy}
        x2={nx}
        y2={ny}
        stroke={INK}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Needle tip */}
      <circle cx={nx} cy={ny} r="5" fill={TEAL} />
      {/* Hub */}
      <circle cx={cx} cy={cy} r="4" fill={INK} />
    </svg>
  );
}

function BookChip({
  label,
  change,
  pctV,
}: {
  label: string;
  change: number | null;
  pctV: number | null;
}) {
  if (change === null || change === undefined) return null; // backend had no total for this actor
  const flat = change === 0;
  const pos = change > 0;
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs"
      style={{
        fontFamily: "'DM Mono', monospace",
        background: flat ? "var(--tint-flat)" : pos ? "var(--tint-bull)" : "var(--tint-bear)",
        color: flat ? MUTED : pos ? GREEN : RED,
        border: `1px solid ${flat ? "var(--grid)" : pos ? "var(--edge-bull)" : "var(--edge-bear)"}`,
      }}
    >
      {label} {signed(change)} ({pctStr(pctV)})
    </span>
  );
}

function ActorCard({ actor }: { actor: Actor }) {
  return (
    <div
      className="rounded-xl border border-border overflow-hidden"
      style={{ background: "var(--surface-card)" }}
    >
      {/* Card header */}
      <div className="px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center gap-2.5 mb-3">
          <span
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "'DM Sans', sans-serif", color: INK }}
          >
            {actor.name}
          </span>
          {actor.coverage && (
            <span
              className="text-xs uppercase tracking-widest border border-border rounded px-1.5 py-0.5"
              style={{ color: "var(--ink-muted)" }}
            >
              coverage
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <BookChip label="Long" change={actor.book.longChange} pctV={actor.book.longPct} />
          <BookChip label="Short" change={actor.book.shortChange} pctV={actor.book.shortPct} />
        </div>
      </div>

      {/* Moves table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[560px]">
          <thead>
            <tr className="border-b border-border" style={{ color: "var(--ink-muted)" }}>
              <th className="text-left px-6 py-2.5 font-normal">Field</th>
              <th className="text-right px-4 py-2.5 font-normal whitespace-nowrap">
                Old → New
              </th>
              <th className="text-right px-4 py-2.5 font-normal">Change</th>
              <th className="text-right px-4 py-2.5 font-normal">%</th>
            </tr>
          </thead>
          <tbody style={{ fontFamily: "'DM Mono', monospace" }}>
            {actor.moves.map((move, i) => (
              <tr
                key={i}
                className="border-b border-border/40 last:border-0 transition-colors"
                style={{ "--tw-bg-opacity": "1" } as React.CSSProperties}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = BG)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = "transparent")
                }
              >
                <td className="px-6 py-2.5 whitespace-nowrap" style={{ color: "var(--ink-soft)" }}>
                  {move.field}
                </td>
                <td
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  style={{ color: "var(--ink-muted)" }}
                >
                  {fmt(move.oldVal)} → {fmt(move.newVal)}
                </td>
                <td
                  className="px-4 py-2.5 text-right font-medium whitespace-nowrap"
                  style={{ color: toneOf(move.change) }}
                >
                  {signed(move.change)}
                </td>
                <td
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  style={{ color: toneOf(move.pct) }}
                >
                  {pctStr(move.pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReadPanel({ data }: { data: BriefData }) {
  const read = data.read;
  if (!read) return null;
  const scoreDisplay = (read.score > 0 ? "+" : "") + read.score.toFixed(2);
  return (
    <div className="space-y-3">
      {/* Gauge */}
      <div
        className="rounded-xl border border-border p-5"
        style={{ background: "var(--surface-card)" }}
      >
        <p
          className="text-xs uppercase tracking-widest mb-3"
          style={{ color: "var(--ink-muted)" }}
        >
          Market Read
        </p>
        <Gauge score={read.score} />
        <div className="text-center mt-1">
          <span
            className="text-sm font-semibold"
            style={{ fontFamily: "'DM Sans', sans-serif", color: INK }}
          >
            {read.tilt} tilt
          </span>
          <span
            className="text-xs ml-2"
            style={{ fontFamily: "'DM Mono', monospace", color: TEAL }}
          >
            {scoreDisplay}
          </span>
        </div>
        <p
          className="text-xs text-center mt-1"
          style={{ color: "var(--ink-muted)", fontFamily: "'DM Mono', monospace" }}
        >
          −1 bearish · 0 neutral · +1 bullish
        </p>
      </div>

      {/* Signals */}
      <div
        className="rounded-xl border border-border p-5 space-y-3"
        style={{ background: "var(--surface-card)" }}
      >
        <p
          className="text-xs uppercase tracking-widest"
          style={{ color: "var(--ink-muted)" }}
        >
          Signals
        </p>
        {read.signals.map((s, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span
              className="shrink-0 text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded mt-0.5"
              style={{
                background: s.sentiment === "bullish" ? "var(--tint-bull)" : "var(--tint-bear)",
                color: s.sentiment === "bullish" ? GREEN : RED,
              }}
            >
              {s.sentiment}
            </span>
            <span
              className="text-xs leading-relaxed"
              style={{
                fontFamily: "'DM Mono', monospace",
                color: "var(--ink-soft)",
              }}
            >
              {s.text}
            </span>
          </div>
        ))}
      </div>

      {/* Action */}
      <div
        className="rounded-xl border border-border p-5"
        style={{ background: "var(--surface-card)" }}
      >
        <p
          className="text-xs uppercase tracking-widest mb-2"
          style={{ color: "var(--ink-muted)" }}
        >
          Action
        </p>
        <p className="text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          {data.action}
        </p>
        <p
          className="text-xs mt-3 pt-3 border-t border-border"
          style={{ color: "var(--ink-muted)" }}
        >
          {data.disclaimer}
        </p>
      </div>
    </div>
  );
}


function priceStr(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Split a series into continuous segments (breaking on null) so the polyline
 *  gaps rather than plotting NaN across missing days. */
function pvSegments(
  vals: (number | null)[],
  xOf: (i: number) => number,
  yOf: (v: number) => number,
): string[] {
  const segs: string[] = [];
  let cur: string[] = [];
  vals.forEach((v, i) => {
    if (v === null || v === undefined) {
      if (cur.length > 1) segs.push(cur.join(" "));
      cur = [];
    } else {
      cur.push(`${xOf(i)},${yOf(v)}`);
    }
  });
  if (cur.length > 1) segs.push(cur.join(" "));
  return segs;
}


// §5 runs on ONE instrument at a time. `inverted` marks the leg where a RISING
// net position is bearish: buying puts is a bet on a fall, so a put build-up
// "agrees" with a DOWN move. Futures and calls read the natural way. (Same
// convention the dossier copy already uses for the put leg.)
// `long`/`short` are the GROSS legs, used as the conviction denominator. The net
// must NOT be used there: for options it is a small difference between two huge
// legs (Client calls: 3.51M long − 3.46M short = 47k net), so an ordinary daily
// Δ divided by it reads as 100–270% "conviction". Divided by the gross book the
// figure behaves the same way across all three instruments — median ~2-3%, p90
// ~9-12% over the full history — so the 8% / 3% wording thresholds still hold.
const DF_INSTRUMENTS: {
  key: keyof ParticipantSeries;
  label: string;
  panel: string;
  word: string;
  inverted: boolean;
  long: keyof ParticipantSeries;
  short: keyof ParticipantSeries;
}[] = [
  { key: "futures", label: "Index Futures", panel: "Net index futures", word: "futures", inverted: false, long: "futuresLong", short: "futuresShort" },
  { key: "calls", label: "Index Calls", panel: "Net index calls", word: "calls", inverted: false, long: "callsLong", short: "callsShort" },
  { key: "puts", label: "Index Puts", panel: "Net index puts", word: "puts", inverted: true, long: "putsLong", short: "putsShort" },
];
// Below this the book is too thin for a ratio to mean anything (DII barely
// trades index options, and a few hundred contracts produce four-digit
// percentages). Conviction reads "—" there rather than a fake number.
const DF_MIN_BOOK = 1000;
// The table lists participants in a FIXED order — smart money first, retail last
// — so a row never moves between days. (It used to re-sort by |Δ|, which made
// the same participant jump around and defeated day-to-day comparison.)
const DF_ROW_ORDER = ["FII", "Pro", "DII", "Client"];

/** "Who derived the move" for one index instrument. Reuses the
 *  participants_vs_nifty data (net-position lines as CONTEXT), adds a per-day
 *  "who drove" ribbon, and below a driver/absorber table with conviction +
 *  persistence. Pure render; hover state is lifted to the parent so the inline
 *  card and the full-screen overlay stay perfectly in sync. */
function DriverFuturesChart({
  data,
  hover,
  setHover,
  selection,
  setSelection,
  tall,
  instrument,
}: {
  data: ParticipantsData;
  hover: number | null;
  setHover: (i: number | null) => void;
  selection: ChartSelection | null;
  setSelection: (s: ChartSelection | null) => void;
  tall?: boolean;
  instrument: string;
}) {
  const I = DF_INSTRUMENTS.find((o) => o.key === instrument) ?? DF_INSTRUMENTS[0];
  const IK = I.key;
  const dirOf = (d: number) => (I.inverted ? -d : d); // directional reading of a raw Δ
  const [width, setWidth] = useState(0);
  const [availH, setAvailH] = useState(0); // measured plot-box height (for full-screen fit)
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setAvailH(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const N = data.dates.length;
  const active = hover ?? N - 1;

  // driver per day = the biggest 1-day futures Δ that AGREES with the NIFTY move.
  const drivers = useMemo(() => {
    const arr: ({ key: string; delta: number } | null)[] = new Array(N).fill(null);
    for (let i = 1; i < N; i++) {
      const nf = data.nifty[i];
      const np = data.nifty[i - 1];
      if (nf === null || np === null) continue;
      const move = nf - np;
      if (move === 0) continue;
      const up = move > 0;
      let best: { key: string; delta: number } | null = null;
      for (const p of PV_PARTICIPANTS) {
        const v = data.participants[p][IK][i];
        const pv = data.participants[p][IK][i - 1];
        if (v === null || pv === null) continue;
        const d = v - pv;
        // compare on the DIRECTIONAL delta (puts invert), rank on the raw size
        if (up ? dirOf(d) > 0 : dirOf(d) < 0) {
          if (!best || Math.abs(d) > Math.abs(best.delta)) best = { key: p, delta: d };
        }
      }
      if (best) arr[i] = best;
    }
    return arr;
  }, [data, N, IK, I.inverted]);

  const persistenceAt = (i: number) => {
    if (!drivers[i]) return 0;
    let n = 1;
    for (let j = i - 1; j >= 0; j--) {
      if (drivers[j] && drivers[j]!.key === drivers[i]!.key) n++;
      else break;
    }
    return n;
  };

  // active-day analysis
  const move =
    active > 0 && data.nifty[active] !== null && data.nifty[active - 1] !== null
      ? (data.nifty[active] as number) - (data.nifty[active - 1] as number)
      : null;
  // Fixed row order — no re-sorting, so a participant holds its row every day.
  // Conviction denominator = the participant's GROSS book in this instrument.
  const bookAt = (p: string, i: number) => {
    const l = data.participants[p][I.long][i];
    const s = data.participants[p][I.short][i];
    return l === null || s === null ? null : l + s;
  };
  const convOf = (d: number | null, book: number | null) =>
    d === null || book === null || book < DF_MIN_BOOK ? null : (Math.abs(d) / book) * 100;
  const rows = DF_ROW_ORDER.map((p) => {
    const v = data.participants[p][IK][active];
    const prev = active > 0 ? data.participants[p][IK][active - 1] : null;
    const d = v !== null && prev !== null ? v - prev : null;
    return { p, v, prev, d, conv: convOf(d, bookAt(p, active)) };
  });
  const driver = drivers[active];
  const absorber = (() => {
    if (!driver || move === null) return null;
    const up = move > 0;
    let best: { key: string; d: number } | null = null;
    for (const p of PV_PARTICIPANTS) {
      const v = data.participants[p][IK][active];
      const pv = data.participants[p][IK][active - 1];
      if (v === null || pv === null) continue;
      const d = v - pv;
      if (up ? dirOf(d) < 0 : dirOf(d) > 0) if (!best || Math.abs(d) > Math.abs(best.d)) best = { key: p, d };
    }
    return best?.key ?? null;
  })();
  const drvConv = driver ? convOf(driver.delta, bookAt(driver.key, active)) : null;
  const convWord = (c: number | null) => (c === null ? "" : c >= 8 ? "high conviction" : c >= 3 ? "moderate" : "low — inertia");
  const per = persistenceAt(active);

  // geometry — same margins (12) + generous gaps idiom as the sibling chart.
  // Full-screen (tall): distribute the measured box height across the NIFTY +
  // futures panels so the whole chart fits the viewport with no scroll.
  const padL = 12;
  const padR = 12;
  const gap = tall ? 34 : 32;
  const ribbonGap = 16;
  const axisH = 30;
  const niftyTop = 16;
  const ribbonH = tall ? 24 : 18;
  let niftyH: number;
  let futH: number;
  if (tall && availH > 0) {
    const chrome = niftyTop + gap + ribbonGap + ribbonH + axisH;
    const avail = Math.max(200, availH - chrome);
    niftyH = avail * 0.42;
    futH = avail * 0.58; // futures panel (the four lines) gets the larger share
  } else {
    niftyH = tall ? 220 : 140;
    futH = tall ? 300 : 178;
  }
  const niftyBottom = niftyTop + niftyH;
  const futTop = niftyBottom + gap;
  const futBottom = futTop + futH;
  const ribbonTop = futBottom + ribbonGap;
  const ribbonBottom = ribbonTop + ribbonH;
  const chartBottom = ribbonBottom;
  const height = chartBottom + axisH;
  const plotL = padL;
  const plotR = Math.max(padL + 1, width - padR);
  const plotW = plotR - plotL;
  const xOf = (i: number) => plotL + (N <= 1 ? 0 : (i / (N - 1)) * plotW);
  const cellW = N > 1 ? plotW / (N - 1) : plotW;

  // scales
  const niftyVals = data.nifty.filter((v): v is number => v !== null);
  let nlo = niftyVals.length ? Math.min(...niftyVals) : 0;
  let nhi = niftyVals.length ? Math.max(...niftyVals) : 1;
  {
    const r = nhi - nlo || 1;
    nlo -= r * 0.12;
    nhi += r * 0.14;
  }
  const nY = (v: number) => niftyBottom - ((v - nlo) / (nhi - nlo)) * (niftyBottom - niftyTop);
  let flo = 0;
  let fhi = 0;
  for (const p of PV_PARTICIPANTS)
    for (const v of data.participants[p][IK])
      if (v !== null) {
        if (v < flo) flo = v;
        if (v > fhi) fhi = v;
      }
  {
    const r = fhi - flo || 1;
    flo -= r * 0.1;
    fhi += r * 0.14;
  }
  const fY = (v: number) => futBottom - ((v - flo) / (fhi - flo)) * (futBottom - futTop);

  // ONE clientX → day-index conversion, shared by hover and click so the
  // crosshair and the anchor you drop can never land on different days.
  const iAt = (clientX: number, rect: DOMRect) => {
    if (N < 2) return 0;
    const i = Math.round(((clientX - rect.left - plotL) / plotW) * (N - 1));
    return Math.max(0, Math.min(N - 1, i));
  };

  const onMove = (e: React.MouseEvent) => {
    if (!svgRef.current || N < 2) return;
    setHover(iAt(e.clientX, svgRef.current.getBoundingClientRect()));
  };

  // ── measurement selection ────────────────────────────────────────────────
  // This chart is handed an already-sliced, undecimated window, so anchors are
  // window-relative indices — and the parent clears them whenever range moves.
  const sel = selection;
  const selP = sel?.participant ?? null;
  const selA = sel && sel.a >= 0 && sel.a < N ? sel.a : null;
  // While the second anchor is pending the crosshair previews it live.
  const selBRaw = sel ? (sel.b ?? hover) : null;
  const selB = selBRaw !== null && selBRaw >= 0 && selBRaw < N ? selBRaw : null;
  const bandLo = selA !== null && selB !== null ? Math.min(selA, selB) : null;
  const bandHi = selA !== null && selB !== null ? Math.max(selA, selB) : null;

  const onClick = (e: React.MouseEvent) => {
    if (!svgRef.current || N < 2) return;
    const rect = svgRef.current.getBoundingClientRect();
    const i = iAt(e.clientX, rect);
    // The pending branch MUST stay first: were the dismiss guard below it, the
    // second click of a new measurement would cancel instead of locking B.
    if (sel && sel.b === null) return setSelection({ ...sel, b: i });
    // A COMPLETED measurement is dismissed by the next click, so getting back to
    // plain hovering never requires finding Esc or the Clear button. Starting a
    // fresh span is therefore click-to-dismiss, click-to-anchor.
    if (sel) return setSelection(null);

    // A fresh measurement: the line you clicked is whichever participant sits
    // nearest the pointer vertically on that day.
    const y = e.clientY - rect.top;
    let pick: string | null = null;
    let bestD = Infinity;
    for (const p of PV_PARTICIPANTS) {
      const v = data.participants[p][IK][i];
      if (v === null || v === undefined) continue;
      const d = Math.abs(fY(v) - y);
      if (d < bestD) {
        bestD = d;
        pick = p;
      }
    }
    if (pick) setSelection({ participant: pick, a: i, b: null });
  };

  const anchors: { i: number; locked: boolean }[] = [];
  if (selA !== null) anchors.push({ i: selA, locked: true });
  if (selB !== null && selB !== selA) anchors.push({ i: selB, locked: sel?.b !== null && sel?.b !== undefined });

  const thursdays = data.expiry.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  const ticks: number[] = [];
  const step = Math.max(1, Math.round(N / 8));
  for (let i = 0; i < N; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== N - 1) ticks.push(N - 1);

  const niftyClose = data.nifty[active];
  const pill = (good: boolean): React.CSSProperties => ({
    fontFamily: "'DM Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.04em",
    padding: "1px 6px",
    borderRadius: 4,
    marginLeft: 8,
    textTransform: "uppercase",
    background: good ? "rgba(21,138,78,0.14)" : "rgba(192,54,44,0.12)",
    color: good ? "var(--ink-bull)" : "var(--ink-bear)",
  });
  const num = (v: number) => v.toLocaleString("en-US");
  const sgn = (v: number) => (v > 0 ? "+" : "−") + Math.abs(Math.round(v)).toLocaleString("en-US");

  return (
    <div className="w-full" style={tall ? { height: "100%", display: "flex", flexDirection: "column" } : undefined}>
      {/* readout — date + NIFTY + 1-day move + the day's driver */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 mb-4 shrink-0">
        <div className="text-base" style={{ fontFamily: "'DM Mono', monospace" }}>
          <span style={{ color: INK, fontWeight: 600 }}>{data.dateDisplay[active]}</span>
          <span style={{ color: MUTED }}>
            {" · "}
            {data.day[active]}
            {data.expiry[active] ? " · expiry" : ""}
            {hover === null ? " · latest" : ""}
          </span>
        </div>
        <div className="flex items-end gap-x-7 gap-y-2 flex-wrap">
          <div className="flex flex-col leading-tight">
            <span className="text-xs uppercase tracking-wider" style={{ color: MUTED }}>
              NIFTY 50
            </span>
            <span className="text-lg font-semibold" style={{ fontFamily: "'DM Mono', monospace", color: TEAL }}>
              {niftyClose === null ? "—" : priceStr(niftyClose)}
            </span>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs uppercase tracking-wider" style={{ color: MUTED }}>
              1-day move
            </span>
            <span
              className="text-lg font-semibold"
              style={{ fontFamily: "'DM Mono', monospace", color: move === null ? MUTED : move > 0 ? GREEN : RED }}
            >
              {move === null ? "—" : (move > 0 ? "+" : "−") + Math.abs(move).toFixed(0)}
            </span>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs uppercase tracking-wider" style={{ color: MUTED }}>
              Driver
            </span>
            <span
              className="text-lg font-semibold"
              style={{ fontFamily: "'DM Mono', monospace", color: driver ? PV_COLORS[driver.key] : MUTED }}
            >
              {driver ? driver.key : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* legend */}
      <div
        className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs shrink-0"
        style={{ fontFamily: "'DM Mono', monospace", color: "var(--ink-soft)" }}
      >
        {PV_PARTICIPANTS.map((p) => (
          <span key={p} className="inline-flex items-center gap-2">
            <span style={{ width: 14, height: 3, borderRadius: 2, background: PV_COLORS[p], display: "inline-block" }} />
            {p}
          </span>
        ))}
        <span style={{ color: MUTED, marginLeft: "auto" }}>Ribbon = the day&apos;s driver · a run of one colour = persistence</span>
      </div>

      {/* chart */}
      <div
        ref={boxRef}
        className="w-full"
        style={tall ? { position: "relative", flex: "1 1 0", minHeight: 0, overflow: "hidden" } : { position: "relative" }}
      >
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            style={{ display: "block", touchAction: "none" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onClick={onClick}
          >
            {/* measured band — first, so every line stays legible on top of it */}
            {bandLo !== null && bandHi !== null && selP && (
              <rect
                x={xOf(bandLo)}
                y={niftyTop}
                width={Math.max(1.5, xOf(bandHi) - xOf(bandLo))}
                height={ribbonBottom - niftyTop}
                fill={PV_COLORS[selP]}
                opacity={0.14}
                pointerEvents="none"
              />
            )}

            {thursdays.map((i) => (
              <line key={"t" + i} x1={xOf(i)} x2={xOf(i)} y1={niftyTop} y2={futBottom} stroke={MUTED} strokeWidth={0.6} opacity={0.14} />
            ))}

            {/* NIFTY panel */}
            <text x={plotL + 1} y={niftyTop - 5} fontSize={12} fill={MUTED} style={{ fontFamily: "'DM Sans', sans-serif" }}>
              NIFTY 50 close <tspan fill="var(--hairline)">· pts</tspan>
            </text>
            {pvSegments(data.nifty, xOf, nY).map((pts, si) => (
              <polyline key={"n" + si} points={pts} fill="none" stroke={TEAL} strokeWidth={1.8} strokeLinejoin="round" />
            ))}
            {niftyClose !== null && (
              <circle cx={xOf(active)} cy={nY(niftyClose)} r={3.5} fill={TEAL} stroke="var(--surface-card)" strokeWidth={1.2} />
            )}

            {/* Futures net panel (context) */}
            <text x={plotL + 1} y={futTop - 5} fontSize={12} fill={MUTED} style={{ fontFamily: "'DM Sans', sans-serif" }}>
              {I.panel} <tspan fill="var(--hairline)">· contracts (position)</tspan>
            </text>
            <line x1={plotL} x2={plotR} y1={fY(0)} y2={fY(0)} stroke={MUTED} strokeWidth={1} opacity={0.5} />
            {PV_PARTICIPANTS.map((p) => {
              const series = data.participants[p][IK];
              const v = series[active];
              const isDrv = driver?.key === p;
              // The measured stretch of the picked line, redrawn heavier on top
              // of the ordinary stroke — that is the "selected part".
              const measured =
                p === selP && bandLo !== null && bandHi !== null
                  ? pvSegments(series.slice(bandLo, bandHi + 1), (i) => xOf(bandLo + i), fY)
                  : [];
              return (
                <g key={p} opacity={sel && p !== selP ? 0.26 : 1}>
                  {pvSegments(series, xOf, fY).map((pts, si) => (
                    <polyline key={si} points={pts} fill="none" stroke={PV_COLORS[p]} strokeWidth={1.5} strokeLinejoin="round" />
                  ))}
                  {measured.map((pts, si) => (
                    <polyline key={"m" + si} points={pts} fill="none" stroke={PV_COLORS[p]} strokeWidth={3.6} strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                  {v !== null && (
                    <circle
                      cx={xOf(active)}
                      cy={fY(v)}
                      r={isDrv ? 4.6 : 3}
                      fill={PV_COLORS[p]}
                      stroke="var(--surface-card)"
                      strokeWidth={isDrv ? 1.5 : 1.1}
                    />
                  )}
                </g>
              );
            })}

            {/* Driver ribbon — each day coloured by its driver; streak = persistence */}
            <text x={plotL + 1} y={ribbonTop - 5} fontSize={12} fill={MUTED} style={{ fontFamily: "'DM Sans', sans-serif" }}>
              Who drove that day <tspan fill="var(--hairline)">· flow</tspan>
            </text>
            {data.dates.map((_, i) => {
              const dv = drivers[i];
              return (
                <rect
                  key={"r" + i}
                  x={xOf(i) - cellW / 2}
                  y={ribbonTop}
                  width={cellW + 0.6}
                  height={ribbonH}
                  fill={dv ? PV_COLORS[dv.key] : "var(--surface-inset)"}
                  opacity={dv ? 0.85 : 0.5}
                />
              );
            })}
            <rect x={plotL} y={ribbonTop} width={plotW} height={ribbonH} fill="none" stroke={GRID} strokeWidth={1} />
            <rect
              x={xOf(active) - cellW / 2}
              y={ribbonTop}
              width={cellW + 0.6}
              height={ribbonH}
              fill="none"
              stroke={INK}
              strokeWidth={1.5}
            />

            {/* crosshair spanning both panels + the ribbon */}
            <line
              x1={xOf(active)}
              x2={xOf(active)}
              y1={niftyTop}
              y2={ribbonBottom}
              stroke={INK}
              strokeWidth={1}
              opacity={hover === null ? 0.28 : 0.55}
              strokeDasharray="3 3"
            />

            {/* measurement anchors — on the picked line AND the NIFTY panel */}
            {selP &&
              anchors.map((an, ai) => {
                const av = data.participants[selP][IK][an.i];
                const nv = data.nifty[an.i];
                return (
                  <g key={"anc" + ai} pointerEvents="none">
                    <line
                      x1={xOf(an.i)}
                      x2={xOf(an.i)}
                      y1={niftyTop}
                      y2={ribbonBottom}
                      stroke={PV_COLORS[selP]}
                      strokeWidth={1.4}
                      strokeDasharray={an.locked ? undefined : "3 3"}
                      opacity={0.9}
                    />
                    {nv !== null && (
                      <circle
                        cx={xOf(an.i)}
                        cy={nY(nv)}
                        r={4}
                        fill={an.locked ? TEAL : "var(--surface-card)"}
                        stroke={TEAL}
                        strokeWidth={1.6}
                      />
                    )}
                    {av !== null && (
                      <circle
                        cx={xOf(an.i)}
                        cy={fY(av)}
                        r={5}
                        fill={an.locked ? PV_COLORS[selP] : "var(--surface-card)"}
                        stroke={PV_COLORS[selP]}
                        strokeWidth={2}
                      />
                    )}
                  </g>
                );
              })}

            {ticks.map((i) => (
              <text
                key={"x" + i}
                x={xOf(i)}
                y={chartBottom + 16}
                fontSize={12}
                fill={MUTED}
                textAnchor="middle"
                style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700 }}
              >
                {data.dateDisplay[i].slice(0, 6)}
              </text>
            ))}
          </svg>
        )}
      </div>

      {/* ── measurement readout ────────────────────────────────────────────
          Its OWN block, deliberately not folded into the header row above:
          that row falls back to `hover ?? N-1`, so leaving the chart would
          snap it to the latest day and silently rewrite the locked numbers. */}
      {sel && selP && selA !== null && (() => {
        const ia = selA;
        const ib = selB; // locked B, or the live preview while picking
        const pending = sel.b === null;
        const sessions = ib === null ? null : Math.abs(ib - ia);
        // No percentage off a zero base — that is Infinity, not a move.
        const pctOf = (a: number | null, b: number | null) => {
          if (a === null || b === null || a === 0) return "";
          const p = ((b - a) / Math.abs(a)) * 100;
          return ` (${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}%)`;
        };
        const rows: { key: string; color: string; a: number | null; b: number | null; price: boolean; picked: boolean }[] = [
          { key: "NIFTY 50", color: TEAL, a: data.nifty[ia], b: ib === null ? null : data.nifty[ib], price: true, picked: false },
          ...DF_ROW_ORDER.map((p) => ({
            key: p,
            color: PV_COLORS[p],
            a: data.participants[p][IK][ia],
            b: ib === null ? null : data.participants[p][IK][ib],
            price: false,
            picked: p === selP,
          })),
        ];
        const cell = (v: number | null, price: boolean) => (v === null ? "—" : price ? priceStr(v) : num(v));

        return (
          <div
            className="mt-4 rounded-xl overflow-hidden shrink-0"
            style={{ border: `1px solid ${PV_COLORS[selP]}55`, background: "var(--surface-subtle)", fontFamily: "'DM Mono', monospace" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="inline-flex items-center gap-2 text-xs" style={{ color: INK }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: PV_COLORS[selP], display: "inline-block" }} />
                <b>{selP}</b>
                <span style={{ color: MUTED }}>
                  {pending
                    ? "· click a second point to measure"
                    : `· ${sessions} session${sessions === 1 ? "" : "s"} apart · click the chart to dismiss`}
                </span>
              </span>
              <button
                onClick={() => setSelection(null)}
                className="rounded-md border border-border px-2 py-0.5 text-[11px]"
                style={{ color: MUTED, background: "var(--surface-card)" }}
              >
                Clear (Esc)
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr style={{ color: MUTED }}>
                    <th className="text-left font-normal px-4 py-2"> </th>
                    <th className="text-right font-normal px-3 py-2 whitespace-nowrap">{data.dateDisplay[ia]}</th>
                    <th className="text-right font-normal px-3 py-2 whitespace-nowrap">{ib === null ? "—" : data.dateDisplay[ib]}</th>
                    <th className="text-right font-normal px-4 py-2">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const d = r.a !== null && r.b !== null ? r.b - r.a : null;
                    return (
                      <tr key={r.key} style={{ borderTop: "1px solid var(--border)", background: r.picked ? `${PV_COLORS[selP]}18` : "transparent" }}>
                        <td className="px-4 py-2" style={{ color: MUTED }}>
                          <span className="inline-flex items-center gap-2">
                            <span style={{ width: 9, height: 9, borderRadius: "50%", background: r.color, display: "inline-block" }} />
                            {r.key}
                          </span>
                        </td>
                        <td className="text-right px-3 py-2" style={{ color: INK }}>{cell(r.a, r.price)}</td>
                        <td className="text-right px-3 py-2" style={{ color: INK }}>{cell(r.b, r.price)}</td>
                        <td
                          className="text-right px-4 py-2 whitespace-nowrap"
                          style={{ color: d === null || d === 0 ? MUTED : d > 0 ? GREEN : RED }}
                        >
                          {d === null ? "—" : r.price ? (d > 0 ? "+" : "−") + Math.abs(d).toFixed(2) : sgn(d)}
                          <span style={{ color: MUTED }}>{pctOf(r.a, r.b)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* participant table (FIXED order — rows never reshuffle) + the verdict */}
      <div className="mt-4 md:mt-6 grid gap-5 shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="rounded-xl border border-border overflow-x-auto" style={{ background: "var(--surface-card)" }}>
          <table className="w-full text-xs" style={{ fontFamily: "'DM Mono', monospace", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: MUTED }}>
                <th className="text-left font-normal px-4 py-2.5">Participant</th>
                <th className="text-right font-normal px-3 py-2.5">Prev net</th>
                <th className="text-right font-normal px-3 py-2.5">Net</th>
                <th className="text-right font-normal px-3 py-2.5">Δ 1-day</th>
                <th className="text-right font-normal px-4 py-2.5">Conv.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isDrv = driver?.key === r.p;
                const isAbs = absorber === r.p;
                const bg = isDrv ? "rgba(21,138,78,0.07)" : isAbs ? "rgba(192,54,44,0.06)" : "transparent";
                return (
                  <tr key={r.p} className="border-t border-border" style={{ background: bg }}>
                    <td className="px-4 py-2.5" style={{ color: INK }}>
                      <span className="inline-flex items-center gap-2">
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: PV_COLORS[r.p], display: "inline-block" }} />
                        {r.p}
                        {isDrv && <span style={pill(true)}>drove</span>}
                        {isAbs && <span style={pill(false)}>absorbed</span>}
                      </span>
                    </td>
                    <td className="text-right px-3 py-2.5" style={{ color: MUTED }}>
                      {r.prev === null ? "—" : num(r.prev)}
                    </td>
                    <td className="text-right px-3 py-2.5" style={{ color: INK }}>
                      {r.v === null ? "—" : num(r.v)}
                    </td>
                    <td
                      className="text-right px-3 py-2.5"
                      style={{ color: r.d === null ? MUTED : r.d > 0 ? GREEN : r.d < 0 ? RED : MUTED }}
                    >
                      {r.d === null ? "—" : sgn(r.d)}
                      {r.d !== null && r.d !== 0 && (
                        <span style={{ color: MUTED, marginLeft: 5 }}>{r.d > 0 ? "bought" : "sold"}</span>
                      )}
                    </td>
                    <td
                      className="text-right px-4 py-2.5"
                      style={{ color: r.conv === null ? MUTED : r.conv >= 8 ? GREEN : MUTED }}
                    >
                      {r.conv === null ? "—" : r.conv.toFixed(1) + "%"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-border px-5 py-4" style={{ background: "var(--surface-subtle)" }}>
          {!driver || move === null ? (
            <p className="text-xs leading-relaxed" style={{ color: MUTED, fontFamily: "'DM Mono', monospace" }}>
              No driver read for this day — it needs a previous trading day and a non-flat NIFTY move.
            </p>
          ) : (
            <>
              <p className="text-sm" style={{ color: INK }}>
                NIFTY{" "}
                <b style={{ color: move > 0 ? GREEN : RED }}>
                  {(move > 0 ? "+" : "−") + Math.abs(move).toFixed(0)} pts
                </b>{" "}
                — <b style={{ color: PV_COLORS[driver.key] }}>{driver.key}</b> drove it.
              </p>
              <div
                className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs"
                style={{ fontFamily: "'DM Mono', monospace", color: "var(--ink-soft)" }}
              >
                <span>
                  Δ <b style={{ color: INK }}>{sgn(driver.delta)}</b>
                </span>
                <span>
                  conviction{" "}
                  <b style={{ color: INK }}>{drvConv === null ? "—" : drvConv.toFixed(1) + "%"}</b>
                  {drvConv === null ? " (book too thin to rate)" : ` (${convWord(drvConv)})`}
                </span>
                <span>
                  persistence <b style={{ color: INK }}>{per} day{per > 1 ? "s" : ""}</b>
                </span>
                {absorber && (
                  <span>
                    absorbed by <b style={{ color: INK }}>{absorber}</b>
                  </span>
                )}
              </div>
              <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                Driver = biggest 1-day Δ in index {I.word} that agrees with the price move; absorber = biggest against it.
                {I.inverted
                  ? " Puts read inverted: building net long puts is a bearish bet, so a put build-up agrees with a fall."
                  : ""}{" "}
                Conviction = Δ ÷ the participant&apos;s <em>gross</em> book (long + short legs) in that instrument — dividing
                by the net would explode on options, where the net is a small difference between two very large legs.
                A positioning read, not proven causation; expiry days are rollover-distorted.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// §1 — one long-vs-short balance card per PARTICIPANT, drawn as inline SVG from
// the SAME participants_vs_nifty.json the other sections read. It used to be 12
// matplotlib PNGs (long_short_<inst>_<participant>_<date>.png) frozen on one
// date: a bitmap can't follow the theme toggle, and it went stale the moment the
// scraper ran. Both problems disappear by drawing it here — colours resolve
// through PV_COLORS (one hue per participant, shared with §3/§4/§5), and the
// date is always the file's last day.
const LS_INSTRUMENTS: { key: string; label: string; long: keyof ParticipantSeries; short: keyof ParticipantSeries }[] = [
  { key: "futures", label: "Index Futures", long: "futuresLong", short: "futuresShort" },
  { key: "calls", label: "Index Calls", long: "callsLong", short: "callsShort" },
  { key: "puts", label: "Index Puts", long: "putsLong", short: "putsShort" },
];
const LS_ACTORS = ["Client", "DII", "FII", "Pro"];

/** Compact figures for the raw contract counts above each bar: 2.2L / 65,941. */
function lsCount(v: number): string {
  if (v >= 100000) return (v / 100000).toFixed(v >= 1000000 ? 0 : 1) + "L";
  return v.toLocaleString("en-US");
}

/** One participant's long-vs-short split, normalised to 100%. Fixed viewBox, so
 *  it scales with its card without measuring anything. */
function ParticipantCard({
  actor,
  color,
  long,
  short,
}: {
  actor: string;
  color: string;
  long: number | null;
  short: number | null;
}) {
  const total = (long ?? 0) + (short ?? 0);
  const has = long !== null && short !== null && total > 0;
  const lp = has ? ((long as number) / total) * 100 : 0;
  const sp = has ? 100 - lp : 0;
  // plot band: y=150 is 0%, y=34 is 100%
  const y0 = 150;
  const yOf = (pct: number) => y0 - (pct / 100) * (y0 - 34);
  // Hue carries WHO (the card's participant, same key as §3/§4/§5); solid-vs-faded
  // carries the long/short split, which is also given by bar position and the
  // axis label under each — so the split never rests on opacity alone.
  //
  // The faded leg is 0.65, not a lighter-looking 0.45: measured against the dark
  // card, 0.45 leaves the short bar at 2.4:1 and 0.65 clears 3:1 for all four
  // hues. (On the light card no opacity reaches 3:1 — the base hues are only
  // 2.2–2.6:1 on white — so the count and % printed above every bar are doing
  // the work there, and must stay.)
  const bar = (x: number, pct: number, opacity: number) => (
    <rect x={x} y={yOf(pct)} width={52} height={Math.max(0, y0 - yOf(pct))} fill={color} opacity={opacity} />
  );
  return (
    <div className="rounded-2xl border border-border p-3" style={{ background: "var(--surface-card)" }}>
      <p className="text-center text-base font-bold mb-1" style={{ color: INK, fontFamily: "'DM Sans', sans-serif" }}>
        {actor}
      </p>
      {!has ? (
        <div className="px-2 py-10 text-center text-xs" style={{ color: MUTED }}>
          No open interest recorded.
        </div>
      ) : (
        <svg viewBox="0 0 230 186" className="w-full h-auto" role="img" aria-label={`${actor}: ${lp.toFixed(0)}% long, ${sp.toFixed(0)}% short.`}>
          {/* gridlines + axis ticks at 0 / 50 / 100 */}
          {[0, 50, 100].map((g) => (
            <g key={g}>
              <line x1={40} x2={222} y1={yOf(g)} y2={yOf(g)} stroke={GRID} strokeWidth={1} />
              <text x={34} y={yOf(g) + 4} fontSize={11} fill={MUTED} textAnchor="end" style={{ fontFamily: "'DM Mono', monospace" }}>
                {g}
              </text>
            </g>
          ))}
          {bar(62, lp, 1)}
          {bar(148, sp, 0.65)}
          {[
            { x: 88, pct: lp, raw: long as number, label: "Long" },
            { x: 174, pct: sp, raw: short as number, label: "Short" },
          ].map((b) => (
            <g key={b.label}>
              <text x={b.x} y={yOf(b.pct) - 20} fontSize={10} fill={MUTED} textAnchor="middle" style={{ fontFamily: "'DM Mono', monospace" }}>
                {lsCount(b.raw)}
              </text>
              <text x={b.x} y={yOf(b.pct) - 6} fontSize={15} fontWeight={700} fill={INK} textAnchor="middle" style={{ fontFamily: "'DM Mono', monospace" }}>
                {b.pct.toFixed(0)}%
              </text>
              <text x={b.x} y={172} fontSize={13} fill={INK} textAnchor="middle" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                {b.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

function LongShortChart({ data, instrument }: { data: ParticipantsData; instrument: string }) {
  const inst = LS_INSTRUMENTS.find((i) => i.key === instrument) ?? LS_INSTRUMENTS[0];
  const i = data.dates.length - 1; // always the latest day in the file
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
      {LS_ACTORS.map((a) => (
        <ParticipantCard
          key={a}
          actor={a}
          color={PV_COLORS[a]}
          long={data.participants[a]?.[inst.long]?.[i] ?? null}
          short={data.participants[a]?.[inst.short]?.[i] ?? null}
        />
      ))}
    </div>
  );
}

// A numbered, distinguished heading shared by the three sections of this view.
function SectionHeader({
  n,
  eyebrow,
  title,
  children,
}: {
  n: number;
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <span
        className="shrink-0 flex items-center justify-center rounded-full text-sm font-bold mt-0.5"
        style={{ width: 34, height: 34, background: INK, color: "var(--surface-page)", fontFamily: "'DM Mono', monospace" }}
      >
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs uppercase tracking-widest mb-1" style={{ color: MUTED }}>
          {eyebrow}
        </p>
        <p
          className="text-2xl md:text-3xl leading-snug font-semibold"
          style={{ fontFamily: "'Playfair Display', serif", color: INK }}
        >
          <em>{title}</em>
        </p>
        {children}
      </div>
    </div>
  );
}

// ── Last-12-Tuesdays positioning summary (data: export_tuesday_summary.py) ──
interface TueRow {
  date: string;
  display: string;
  day: string;
  net: Record<string, number | null>;
  delta: Record<string, number | null>;
  winner: string;
  bias: string;
}
interface TueInstrument { label: string; biasPolarity: number; rows: TueRow[] }
interface TueData {
  asOf: string;
  deltaBasis: string;
  tuesdays: string[];
  displays: string[];
  actors: string[];
  instruments: Record<string, TueInstrument>;
}

const TUE_ORDER = ["FII", "DII", "Pro", "Client"]; // table + legend order (matches the reference)
const TUE_COLORS: Record<string, string> = {
  FII: "#B08FE8",
  DII: "#E8A33D",
  Pro: "#4CC77C",
  Client: "#3FA9F5",
};
const TUE_INSTRUMENTS: { key: string; label: string }[] = [
  { key: "futures", label: "Index Futures" },
  { key: "calls", label: "Index Calls" },
  { key: "puts", label: "Index Puts" },
];

function compactNum(v: number | null): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}k`;
  return `${sign}${a}`;
}
function deltaStr(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return (v > 0 ? "+" : "") + compactNum(v);
}
function biasVisual(bias: string): { color: string; bg: string; strong: boolean } {
  const bull = bias.includes("Bullish");
  const bear = bias.includes("Bearish");
  return {
    color: bull ? GREEN : bear ? RED : MUTED,
    bg: bull ? "var(--tint-bull)" : bear ? "var(--tint-bear)" : "var(--tint-flat)",
    strong: bias.startsWith("Strong"),
  };
}

function TuesdayLineChart({ rows }: { rows: TueRow[] }) {
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const m = () => setW(el.clientWidth);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const N = rows.length;
  const height = 330;
  const padL = 54;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const plotL = padL;
  const plotR = Math.max(padL + 1, w - padR);
  const plotW = plotR - plotL;
  const plotT = padT;
  const plotB = height - padB;
  const plotH = plotB - plotT;
  const xOf = (i: number) => plotL + (N <= 1 ? 0 : (i / (N - 1)) * plotW);

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows)
    for (const a of TUE_ORDER) {
      const v = r.net[a];
      if (v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  lo = Math.min(lo, 0);
  hi = Math.max(hi, 0);
  const range = hi - lo || 1;
  lo -= range * 0.08;
  hi += range * 0.08;
  const yOf = (v: number) => plotB - ((v - lo) / (hi - lo)) * plotH;
  const yticks = Array.from({ length: 5 }, (_, k) => lo + (k / 4) * (hi - lo));

  const active = hover ?? N - 1;
  const ar = rows[active];

  const onMove = (e: React.MouseEvent) => {
    if (!svg.current || N < 2) return;
    const rect = svg.current.getBoundingClientRect();
    let i = Math.round(((e.clientX - rect.left - plotL) / plotW) * (N - 1));
    i = Math.max(0, Math.min(N - 1, i));
    setHover(i);
  };

  const tickEvery = Math.ceil(N / 8);

  return (
    <div>
      {/* legend + hovered-day readout (defaults to the latest Tuesday) */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 mb-3">
        <div className="text-sm" style={{ fontFamily: "'DM Mono', monospace" }}>
          <span style={{ color: INK, fontWeight: 600 }}>Tue {ar.display}</span>
          <span style={{ color: MUTED }}>{hover === null ? " · latest" : ""} · net (contracts)</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {TUE_ORDER.map((a) => (
            <span key={a} className="inline-flex items-center gap-1.5 text-sm" style={{ fontFamily: "'DM Mono', monospace" }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: TUE_COLORS[a], display: "inline-block" }} />
              <span style={{ color: MUTED }}>{a === "Pro" ? "PRO" : a}</span>
              <span style={{ color: TUE_COLORS[a], fontWeight: 600 }}>{compactNum(ar.net[a])}</span>
            </span>
          ))}
        </div>
      </div>

      <div ref={box} className="w-full" style={{ position: "relative" }}>
        {w > 0 && (
          <svg
            ref={svg}
            width={w}
            height={height}
            style={{ display: "block", touchAction: "none" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* y gridlines + labels */}
            {yticks.map((tv, i) => (
              <g key={"y" + i}>
                <line x1={plotL} x2={plotR} y1={yOf(tv)} y2={yOf(tv)} stroke={GRID} strokeWidth={0.7} opacity={0.7} />
                <text x={plotL - 8} y={yOf(tv) + 3} fontSize={12} fill={MUTED} textAnchor="end" style={{ fontFamily: "'DM Mono', monospace" }}>
                  {compactNum(Math.round(tv))}
                </text>
              </g>
            ))}
            {/* zero baseline emphasised */}
            {lo < 0 && hi > 0 && (
              <line x1={plotL} x2={plotR} y1={yOf(0)} y2={yOf(0)} stroke={MUTED} strokeWidth={1} opacity={0.55} />
            )}
            {/* x labels */}
            {rows.map((r, i) =>
              i % tickEvery === 0 || i === N - 1 ? (
                <text key={"x" + i} x={xOf(i)} y={plotB + 18} fontSize={12} fill={MUTED} textAnchor="middle" style={{ fontFamily: "'DM Mono', monospace" }}>
                  {r.display}
                </text>
              ) : null
            )}
            {/* crosshair */}
            {hover !== null && (
              <line x1={xOf(active)} x2={xOf(active)} y1={plotT} y2={plotB} stroke={INK} strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
            )}
            {/* one line per participant */}
            {TUE_ORDER.map((a) => {
              const pts = rows
                .map((r, i) => (r.net[a] == null ? null : `${xOf(i)},${yOf(r.net[a] as number)}`))
                .filter(Boolean)
                .join(" ");
              return <polyline key={a} points={pts} fill="none" stroke={TUE_COLORS[a]} strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round" />;
            })}
            {/* dots at the active Tuesday */}
            {hover !== null &&
              TUE_ORDER.map((a) =>
                ar.net[a] == null ? null : (
                  <circle key={"d" + a} cx={xOf(active)} cy={yOf(ar.net[a] as number)} r={3.5} fill={TUE_COLORS[a]} stroke="var(--surface-card)" strokeWidth={1.2} />
                )
              )}
          </svg>
        )}
      </div>
    </div>
  );
}

function TuesdaySection() {
  const [data, setData] = useState<TueData | null>(null);
  const [failed, setFailed] = useState(false);
  const [inst, setInst] = useState<string>("futures");

  useEffect(() => {
    let alive = true;
    fetch("/data/tuesday_summary.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: TueData) => {
        if (!alive) return;
        if (!d || !d.instruments) throw new Error("empty");
        setData(d);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Tuesday summary unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python export_tuesday_summary.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Loading summary…
      </div>
    );
  }

  const cur = data.instruments[inst];

  return (
    <div className="space-y-5">
      {/* heading — out of any card, on the gray page background */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-[20px] uppercase tracking-widest font-medium" style={{ color: MUTED }}>
            Summary Table · last 12 Tuesdays
          </p>
          <span style={{ color: "#F4B400", letterSpacing: 1, fontSize: "1.15rem" }}>★★★★★</span>
        </div>
        <p className="text-2xl md:text-3xl leading-snug font-semibold" style={{ fontFamily: "'Playfair Display', serif", color: INK }}>
          <em>Tuesday-over-Tuesday positioning — what analysts read first</em>
        </p>
        <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 640 }}>
          Each of the last 12 Tuesdays (to {data.asOf}) vs the Tuesday before it. Δ = change in
          net position ({data.deltaBasis}). Winner = who moved most; Market Bias reads off the FII Δ.
        </p>

        {/* instrument toggle — drives both the table and the chart */}
        <div className="inline-flex rounded-lg border border-border p-0.5 mt-4" style={{ background: "var(--surface-inset)" }}>
          {TUE_INSTRUMENTS.map((t) => (
            <button
              key={t.key}
              onClick={() => setInst(t.key)}
              className="px-3.5 py-1.5 rounded-md text-sm font-medium transition-all"
              style={{
                background: inst === t.key ? "var(--surface-raised)" : "transparent",
                color: inst === t.key ? INK : "var(--ink-muted)",
                boxShadow: inst === t.key ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* the table */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={{ background: "var(--surface-card)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-border" style={{ color: "var(--ink-muted)" }}>
                <th className="text-left px-3 py-2.5 font-normal">Tuesday</th>
                <th className="text-right px-3 py-2.5 font-normal">FII Δ</th>
                <th className="text-right px-3 py-2.5 font-normal">DII Δ</th>
                <th className="text-right px-3 py-2.5 font-normal">PRO Δ</th>
                <th className="text-right px-3 py-2.5 font-normal">Client Δ</th>
                <th className="text-left px-3 py-2.5 font-normal">Winner</th>
                <th className="text-left px-3 py-2.5 font-normal">Market Bias</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: "'DM Mono', monospace" }}>
              {/* most-recent Tuesday on top; the latest row is highlighted */}
              {[...cur.rows].reverse().map((r) => {
                const bv = biasVisual(r.bias);
                const latest = r.date === cur.rows[cur.rows.length - 1].date;
                return (
                  <tr
                    key={r.date}
                    className="border-b border-border/40 last:border-0"
                    style={latest ? { background: "var(--surface-inset)" } : undefined}
                  >
                    <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: INK }}>{r.display}</td>
                    {(["FII", "DII", "Pro", "Client"] as const).map((a) => (
                      <td key={a} className="px-3 py-2.5 text-right whitespace-nowrap" style={{ color: toneOf(r.delta[a]) }}>
                        {deltaStr(r.delta[a])}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 whitespace-nowrap font-medium" style={{ color: TUE_COLORS[r.winner] ?? INK }}>
                      {r.winner === "Pro" ? "PRO" : r.winner}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className="inline-block px-2 py-0.5 rounded-full text-xs"
                        style={{ background: bv.bg, color: bv.color, fontWeight: bv.strong ? 700 : 500 }}
                      >
                        {r.bias}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs mt-4 pt-3 border-t border-border" style={{ color: "var(--ink-muted)" }}>
          Immediately answers: who changed the most (Winner) · who dominated · what the bias was.
          {inst === "puts" ? "  Puts: adding net long puts reads bearish, so the FII-Δ sign is inverted for bias." : ""}
        </p>
      </div>

      {/* the line chart — net levels of all four participants across the 12 Tuesdays */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={{ background: "var(--surface-card)" }}>
        <p className="text-[20px] uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          {cur.label} · net position by participant (12 Tuesdays)
        </p>
        <TuesdayLineChart rows={cur.rows} />
      </div>
    </div>
  );
}

// Home / first menu: the last-12-Tuesdays weekday comparison lives on its own page.
function WeeklyComparisonView() {
  return (
    <div className="space-y-8">
      <TuesdaySection />
    </div>
  );
}

// Second menu ("Participant vs Market"): NIFTY overlay + participant long/short.
// ── Participant-Wise Report (data: participant_report.py) ──
interface PRCell { v: number | null; chg: number | null }
interface PRRow { label: string; kind: "field" | "net"; group?: string; cells: Record<string, PRCell> }
interface PRReport { date: string; display: string; compareDate: string | null; rows: PRRow[] }
interface PRData { generatedAt: string; dates: string[]; reports: Record<string, PRReport> }

const PR_COLS = ["Client", "DII", "FII", "Pro", "Total"];
// value keeps its own sign (NET rows go negative); no '+' on positives.
const valStr = (v: number) => (v < 0 ? "−" : "") + fmt(v);

function ParticipantReport() {
  const [data, setData] = useState<PRData | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/participant_report.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: PRData) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.dates) || d.dates.length === 0) throw new Error("empty");
        setData(d);
        setSel(d.dates[d.dates.length - 1]); // default to the latest date
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Participant report unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python participant_report.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Loading participant report…
      </div>
    );
  }

  const activeDate = sel && data.reports[sel] ? sel : data.dates[data.dates.length - 1];
  const report = data.reports[activeDate];

  return (
    <div className="rounded-2xl border border-border p-5 md:p-7" style={{ background: "var(--surface-card)" }}>
      {/* header: title + date, and the date picker */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm" style={{ fontFamily: "'DM Mono', monospace", color: INK }}>
          <span style={{ fontWeight: 600 }}>{report.display}</span>
          {report.compareDate && <span style={{ color: MUTED }}>{"  ·  vs "}{report.compareDate}</span>}
        </p>
        <select
          value={activeDate}
          onChange={(e) => setSel(e.target.value)}
          className="text-sm rounded-lg border border-border px-3 py-1.5"
          style={{ fontFamily: "'DM Mono', monospace", color: INK, background: "var(--surface-card)" }}
        >
          {[...data.dates].reverse().map((dd) => (
            <option key={dd} value={dd}>
              {data.reports[dd].display}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-border" style={{ color: MUTED }}>
              <th className="text-left px-3 py-2 font-normal">Field</th>
              {PR_COLS.map((c) => (
                <th key={c} className="text-right px-3 py-2 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody style={{ fontFamily: "'DM Mono', monospace" }}>
            {report.rows.map((row, i) => {
              const net = row.kind === "net";
              return (
                <tr
                  key={i}
                  className="border-b border-border/40 last:border-0"
                  style={net ? { background: "var(--tint-flat)" } : undefined}
                >
                  <td
                    className="px-3 py-2 whitespace-nowrap"
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      color: net ? INK : "var(--ink-soft)",
                      fontWeight: net ? 700 : 400,
                    }}
                  >
                    {row.label}
                  </td>
                  {PR_COLS.map((c) => {
                    const cell = row.cells[c];
                    return (
                      <td key={c} className="px-3 py-2 text-right whitespace-nowrap align-top">
                        <div style={{ color: net ? INK : "var(--ink-soft)", fontWeight: net ? 700 : 500 }}>
                          {cell && cell.v != null ? valStr(cell.v) : "—"}
                        </div>
                        {cell && cell.chg != null && (
                          <div className="text-xs" style={{ color: toneOf(cell.chg) }}>
                            {signed(cell.chg)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Participant "dossier" — an editorial one-day read, sourced entirely from
//    participant_report.json (net levels + one-day changes + gross longs). All
//    prose is derived from the numbers; nothing is hard-coded per date.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtISO = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d} ${MONTHS[+m - 1]} ${y}`;
};

const DOSSIER_INSTS = [
  { key: "futures", label: "Futures", word: "futures", longLabel: "Future Index Long", netGroup: "Future Index", section: "FUTURES" },
  { key: "calls", label: "Calls", word: "calls", longLabel: "Option Index Call Long", netGroup: "Option Index Call", section: "CALL" },
  { key: "puts", label: "Puts", word: "puts", longLabel: "Option Index Put Long", netGroup: "Option Index Put", section: "PUT" },
];
const DOSSIER_PARTS = ["Pro", "FII", "Client", "DII"];
// Participant chips carry PV_COLORS, which is fixed across BOTH themes — so the
// ink on them must be fixed too. `var(--surface-page)` would flip to near-white
// in light mode and land at 2.2–2.6:1 on these mid-tone hues; this near-black
// measures 6.9–8.5:1 against all four, so the chip reads in either theme.
const DOSSIER_CHIP_INK = "#12151C";
const DNAME: Record<string, { full: string; caps: string; short: string }> = {
  Pro: { full: "Proprietary desks", caps: "THE PROS", short: "PRO" },
  FII: { full: "Foreign institutions", caps: "THE FOREIGNERS", short: "FII" },
  Client: { full: "Retail (client)", caps: "THE CROWD", short: "CLIENT" },
  DII: { full: "Domestic institutions", caps: "THE DOMESTICS", short: "DII" },
};

interface InstNums { net: number | null; chg: number | null; long: number | null }
type Extracted = Record<string, Record<string, InstNums>>;

// Pull each participant's per-instrument net / one-day change / gross-long from one report.
function extractReport(report: PRReport): Extracted {
  const byLabel: Record<string, PRRow> = {};
  const byGroup: Record<string, PRRow> = {};
  for (const row of report.rows) {
    if (row.kind === "net" && row.group) byGroup[row.group] = row;
    else byLabel[row.label] = row;
  }
  const out: Extracted = {};
  for (const p of DOSSIER_PARTS) {
    out[p] = {};
    for (const inst of DOSSIER_INSTS) {
      const netRow = byGroup[inst.netGroup];
      const longRow = byLabel[inst.longLabel];
      out[p][inst.key] = {
        net: netRow?.cells?.[p]?.v ?? null,
        chg: netRow?.cells?.[p]?.chg ?? null,
        long: longRow?.cells?.[p]?.v ?? null,
      };
    }
  }
  return out;
}

const longShort = (net: number | null) =>
  net == null ? "—" : net >= 0 ? `long ${fmt(net)}` : `short ${fmt(net)}`;
const chgStr = (c: number | null) => (c == null ? "—" : signed(c));

function ParticipantDossier() {
  const [data, setData] = useState<PRData | null>(null);
  const [failed, setFailed] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [inst, setInst] = useState("calls"); // calls = the frame the sample used
  const [w, setW] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/participant_report.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: PRData) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.dates) || d.dates.length < 2) throw new Error("empty");
        setData(d);
        const dd = d.dates.filter((x) => d.reports[x] && d.reports[x].compareDate);
        setDate(dd[dd.length - 1]);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const m = () => setW(el.clientWidth);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  if (failed) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Dossier data unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python participant_report.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
        Loading dossier…
      </div>
    );
  }

  // only dates that HAVE a previous day (a "change" is defined)
  const dossierDates = data.dates.filter((d) => data.reports[d] && data.reports[d].compareDate);
  const activeDate = date && data.reports[date]?.compareDate ? date : dossierDates[dossierDates.length - 1];
  const report = data.reports[activeDate];
  const I = DOSSIER_INSTS.find((x) => x.key === inst) ?? DOSSIER_INSTS[1];
  const ex = extractReport(report);

  // this day's net change for the selected instrument, per participant
  const changes = DOSSIER_PARTS
    .map((p) => ({ p, chg: ex[p][I.key].chg }))
    .filter((x): x is { p: string; chg: number } => x.chg != null);
  const sorted = [...changes].sort((a, b) => b.chg - a.chg);
  // chart order: buyer(s) on top, then sellers biggest-first (a diverging fan)
  const bars = [
    ...sorted.filter((b) => b.chg >= 0),
    ...sorted.filter((b) => b.chg < 0).sort((a, b) => a.chg - b.chg),
  ];
  const buyer = sorted.length && sorted[0].chg > 0 ? sorted[0] : null;
  const last = sorted[sorted.length - 1];
  const seller = last && last.chg < 0 ? last : null;
  const sum = changes.reduce((s, x) => s + x.chg, 0);
  const sellers = changes.filter((x) => x.chg < 0).map((x) => DNAME[x.p].short);

  // superlative: is the buyer's move the biggest single-day buy for this instrument, ever in the range?
  let maxPos = 0;
  for (const dd of dossierDates) {
    const netRow = data.reports[dd].rows.find((r) => r.kind === "net" && r.group === I.netGroup);
    if (!netRow) continue;
    for (const p of DOSSIER_PARTS) {
      const c = netRow.cells?.[p]?.chg;
      if (c != null && c > maxPos) maxPos = c;
    }
  }
  const isRecord = buyer != null && buyer.chg === maxPos && maxPos > 0;

  // headline
  let headline: string;
  if (buyer && seller) headline = `${DNAME[buyer.p].caps} BOUGHT WHAT ${DNAME[seller.p].caps} SOLD.`;
  else if (buyer) headline = `${DNAME[buyer.p].caps} LED THE BUYING.`;
  else if (seller) headline = `${DNAME[seller.p].caps} LED THE SELLING.`;
  else headline = `A QUIET DAY IN INDEX ${I.section}S.`;

  // lede
  let lede: string;
  if (buyer && seller) {
    lede =
      `${DNAME[buyer.p].full} bought ${fmt(buyer.chg)} index ${I.word} net. ` +
      `${DNAME[seller.p].full} sold ${fmt(Math.abs(seller.chg))} into them.` +
      (isRecord ? ` That is the biggest single-day ${I.word} buy of this run.` : "");
  } else if (buyer) {
    lede = `${DNAME[buyer.p].full} added ${fmt(buyer.chg)} index ${I.word} net, with no single participant on the other side.`;
  } else if (seller) {
    lede = `${DNAME[seller.p].full} cut ${fmt(Math.abs(seller.chg))} index ${I.word} net, and found no single buyer.`;
  } else {
    lede = `Net index ${I.word} positioning barely moved across the four participants today.`;
  }

  // caption (the four nets sum to the market TOTAL = 0, so they net to flat)
  const caption =
    Math.abs(sum) < 3000 && buyer && sellers.length
      ? `Centre line is zero. The four participant nets sum to flat, so ${DNAME[buyer.p].short} is the buyer of what ${sellers.join(" and ")} wrote.`
      : `Centre line is zero. Right of it is a net add (bought); left is a net cut (sold).`;

  // pairing (derived)
  const proLong = (ex.Pro.futures.net ?? 0) > 0 || (ex.Pro.calls.net ?? 0) > 0;
  const fiiFut = ex.FII.futures.net ?? 0;
  const fiiCov = ex.FII.futures.chg ?? 0;
  let pairing: string;
  if (proLong && fiiFut < 0) {
    const pct = fiiCov > 0 ? (fiiCov / Math.abs(fiiFut)) * 100 : 0;
    pairing =
      `Pro long against FII short is the cleanest divergence on the board. FII ` +
      (fiiCov > 0 ? `covered ${pct.toFixed(0)}% of` : "added to") +
      ` a ${fmt(Math.abs(fiiFut))}-lot short futures book` +
      (fiiCov > 0 && pct < 5 ? " — conviction on one side, inertia on the other." : ".");
  } else {
    pairing = `Read it as one book: the participants who are net long are financing those who are net short. Today's flow shows who is pressing and who is fading.`;
  }

  // per-participant "read" — factual, gated on the numbers
  const readFor = (p: string) => {
    const d = ex[p];
    const fn = d.futures.net ?? 0;
    const fc = d.futures.chg ?? 0;
    let dir = fn > 0 ? `Net long futures ${fmt(fn)}` : fn < 0 ? `Net short futures ${fmt(Math.abs(fn))}` : "Flat futures";
    if (fn < 0 && fc > 0) {
      const pct = (fc / Math.abs(fn)) * 100;
      dir += pct < 5 ? ` — covered ${pct.toFixed(0)}% today, not turned` : ` — covering`;
    } else if (fn < 0 && fc < 0) dir += " — adding shorts";
    else if (fn > 0 && fc < 0) dir += " — trimming";
    else if (fn > 0 && fc > 0) dir += " — adding";
    const calls = (d.calls.chg ?? 0) > 0 ? "adding calls" : (d.calls.chg ?? 0) < 0 ? "cutting calls" : "flat calls";
    const puts = (d.puts.net ?? 0) < 0 ? "short puts" : "holds puts";
    return `${dir}; ${calls}; ${puts}.`;
  };

  // horizontal diverging bar-chart geometry.
  // Both gutters are sized to the WIDEST string they must hold, not to the
  // typical one: at 66/96 the longest labels ("CLIENT", "122,286 sold") ran into
  // each other on a big one-day move, which is exactly the day you most want to
  // read. 92 clears the swatch + a 6-character name; 130 clears "+122,286 bought".
  const labelW = 92;
  const rowH = 40;
  const chartH = sorted.length * rowH + 8;
  const cx = labelW + Math.max(1, w - labelW) / 2; // zero centre line
  const half = Math.max(20, (w - labelW) / 2 - 130); // room for the value labels
  const maxAbs = Math.max(1, ...sorted.map((b) => Math.abs(b.chg)));
  const barLen = (v: number) => (Math.abs(v) / maxAbs) * half;

  return (
    <div className="rounded-2xl border border-border overflow-hidden" style={{ background: "var(--surface-card)" }}>
      {/* masthead + controls */}
      <div className="px-6 md:px-8 pt-6 pb-4 border-b border-border">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-lg tracking-tight" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, color: INK }}>
            Equinext Pulse
          </span>
          <span className="text-xs uppercase tracking-widest" style={{ color: MUTED, fontFamily: "'DM Mono', monospace" }}>
            {I.label} · {fmtISO(activeDate)} · net one-day change
          </span>
        </div>
        <p className="text-xs italic mt-1" style={{ color: MUTED }}>
          Participant open-interest dossier — who holds what, and who moved.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5" style={{ background: "var(--surface-inset)" }}>
            {DOSSIER_INSTS.map((t) => (
              <button
                key={t.key}
                onClick={() => setInst(t.key)}
                className="px-3 py-1 rounded-md text-sm font-medium transition-all"
                style={{
                  background: inst === t.key ? "var(--surface-raised)" : "transparent",
                  color: inst === t.key ? INK : "var(--ink-muted)",
                  boxShadow: inst === t.key ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <select
            value={activeDate}
            onChange={(e) => setDate(e.target.value)}
            className="text-sm rounded-lg border border-border px-3 py-1.5"
            style={{ fontFamily: "'DM Mono', monospace", color: INK, background: "var(--surface-card)" }}
          >
            {[...dossierDates].reverse().map((dd) => (
              <option key={dd} value={dd}>
                {fmtISO(dd)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* headline + lede */}
      <div className="px-6 md:px-8 pt-6">
        <h2 className="font-bold" style={{ fontFamily: "'Playfair Display', serif", color: INK, lineHeight: 1.05, fontSize: "clamp(1.9rem, 3.4vw, 3rem)" }}>
          {headline}
        </h2>
        <p className="mt-3 text-base md:text-lg leading-relaxed" style={{ color: "var(--ink-soft)", maxWidth: 760 }}>
          {lede}
        </p>
      </div>

      {/* the chart */}
      <div className="px-6 md:px-8 pt-7">
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          Net index {I.word} open interest · one-day change ({fmtISO(activeDate)}, contracts)
        </p>
        <div ref={box} className="w-full">
          {w > 0 && sorted.length > 0 && (
            <svg width={w} height={chartH} style={{ display: "block" }}>
              <line x1={cx} x2={cx} y1={0} y2={chartH - 8} stroke={MUTED} strokeWidth={1} opacity={0.55} />
              {bars.map((b, i) => {
                const y = i * rowH + 6;
                const len = barLen(b.chg);
                const pos = b.chg >= 0;
                const bx = pos ? cx : cx - len;
                const label = pos ? `+${fmt(b.chg)} bought` : `${fmt(Math.abs(b.chg))} sold`;
                return (
                  <g key={b.p}>
                    {/* Swatch, because the row label sits half a chart-width away
                        from its own bar — without it the colour has nothing to
                        attach the name to. */}
                    <rect x={4} y={y + (rowH - 14) / 2 - 5} width={10} height={10} rx={2} fill={PV_COLORS[b.p]} />
                    <text x={labelW - 10} y={y + (rowH - 14) / 2} fontSize={14} textAnchor="end" dominantBaseline="middle" fill={INK} style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>
                      {DNAME[b.p].short}
                    </text>
                    {/* Colour carries WHO; the side of the centre line, the word
                        "bought"/"sold" and the row label all carry WHAT — so the
                        chart still reads with no colour at all. Sellers sit at
                        55% to keep the buyer the story, as the mono version did. */}
                    <rect
                      x={bx}
                      y={y}
                      width={Math.max(1, len)}
                      height={rowH - 14}
                      fill={PV_COLORS[b.p]}
                      opacity={pos ? 1 : 0.55}
                      rx={2}
                    />
                    <text
                      x={pos ? bx + len + 8 : bx - 8}
                      y={y + (rowH - 14) / 2}
                      fontSize={14}
                      textAnchor={pos ? "start" : "end"}
                      dominantBaseline="middle"
                      fill={pos ? INK : "var(--ink-muted)"}
                      style={{ fontFamily: "'DM Mono', monospace", fontWeight: pos ? 700 : 400 }}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <p className="text-xs italic mt-2" style={{ color: MUTED }}>
          {caption}
        </p>
      </div>

      {/* who holds what */}
      <div className="px-6 md:px-8 pt-7">
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          Who holds what · NSE participant OI ({fmtISO(activeDate)}, net contracts)
        </p>
        <div className="space-y-3">
          {DOSSIER_PARTS.map((p) => {
            const d = ex[p];
            return (
              <div key={p} className="flex items-start gap-3 pb-3 border-b border-border/40 last:border-0">
                <span
                  className="shrink-0 text-xs uppercase tracking-wider font-bold rounded px-2 py-1 mt-0.5"
                  style={{ background: PV_COLORS[p], color: DOSSIER_CHIP_INK, fontFamily: "'DM Mono', monospace" }}
                >
                  {DNAME[p].short}
                </span>
                <div className="min-w-0 text-sm" style={{ color: "var(--ink-soft)" }}>
                  {/* Same green-up / red-down tone the tables in this file use, so
                      the day's move is findable in a dense monospace paragraph.
                      Built by loop rather than repeated inline — three near
                      identical clauses had to stay in sync by hand before. */}
                  <span style={{ fontFamily: "'DM Mono', monospace" }}>
                    {DOSSIER_INSTS.map((inst, k) => (
                      <span key={inst.key}>
                        {inst.label} net {longShort(d[inst.key].net)} (
                        <span style={{ color: toneOf(d[inst.key].chg), fontWeight: 600 }}>{chgStr(d[inst.key].chg)}</span>
                        {k === 0 ? " today" : ""}).{" "}
                      </span>
                    ))}
                    Gross longs — futures {fmt(d.futures.long ?? 0)}, calls {fmt(d.calls.long ?? 0)}, puts {fmt(d.puts.long ?? 0)}.
                  </span>
                  <span className="block mt-1 text-xs font-medium" style={{ color: INK }}>
                    {readFor(p)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* pairing */}
      <div className="px-6 md:px-8 py-6 mt-2" style={{ background: "var(--surface-page)" }}>
        <p className="text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          <span style={{ fontWeight: 700 }}>The pairing: </span>
          {pairing}
        </p>
      </div>
    </div>
  );
}


function ParticipantView() {
  const [lsInst, setLsInst] = useState("futures"); // Long/Short instrument selector

  // "NIFTY vs All Participants" — shared state lifted here so the inline card and
  // the full-screen overlay render the SAME ParticipantChart, always in sync.
  const [pvData, setPvData] = useState<ParticipantsData | null>(null);
  const [pvFailed, setPvFailed] = useState(false);
  const [pvHover, setPvHover] = useState<number | null>(null);
  // Two-anchor measurement. Lifted for the same reason as `hover`: both charts
  // render twice (inline + overlay) and a local state would leave the overlay
  // showing nothing. Separate per chart — §3 and §4 measure different things.
  const [pvSel, setPvSel] = useState<ChartSelection | null>(null);
  const [pvFull, setPvFull] = useState(false);
  const [bookMode, setBookMode] = useState<BookMode>("main"); // §4: net / gross-long / gross-short
  const [metric, setMetric] = useState<MetricKey>("futures"); // which instrument panel
  const [renderMode, setRenderMode] = useState<RenderMode>("line");
  // Visible time window, shared by §4 and §5. Defaults to 1M, NOT All: the
  // archive is ~2,600 days and first paint has to stay cheap.
  const [range, setRange] = useState<RangeKey>("1M");

  // "Who derived the move" — its own hover + full-screen, reusing the SAME pvData.
  const [dfHover, setDfHover] = useState<number | null>(null);
  const [dfSel, setDfSel] = useState<ChartSelection | null>(null);
  const [dfFull, setDfFull] = useState(false);
  const [dfInst, setDfInst] = useState<string>("futures"); // §5: futures / calls / puts

  useEffect(() => {
    let alive = true;
    fetch("/data/participants_vs_nifty.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: ParticipantsData) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.dates) || d.dates.length < 2) throw new Error("empty");
        setPvData(d);
      })
      .catch(() => alive && setPvFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // Esc clears a live measurement FIRST and only then closes an overlay —
  // otherwise clearing a selection you made in full screen would eject you from
  // full screen. While EITHER overlay is open, lock the page behind it so the
  // home screen never scrolls under the full-screen view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pvFull) {
        if (pvSel) setPvSel(null);
        else setPvFull(false);
        return;
      }
      if (dfFull) {
        if (dfSel) setDfSel(null);
        else setDfFull(false);
        return;
      }
      setPvSel(null);
      setDfSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pvFull, dfFull, pvSel, dfSel]);

  useEffect(() => {
    if (!pvFull && !dfFull) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [pvFull, dfFull]);

  // The visible window, computed ONCE and shared by §4 and §5 so both sections
  // always show the same span. Slicing happens here, before render — the charts
  // never receive days they aren't drawing.
  const pvWindow = useMemo(
    () => (pvData ? sliceParticipantsData(pvData, pvRangeStart(pvData.dates, range), pvData.dates.length - 1) : null),
    [pvData, range],
  );

  // Changing range invalidates both hover indices (they address the OLD, longer
  // array). Clear them in the same handler rather than in an effect, so no render
  // ever runs with an out-of-bounds index. §4's measurement anchors are
  // window-relative and go with them; §3's are RAW indices and survive — it
  // re-resolves them, and says so when one falls outside the new window.
  const applyRange = (k: RangeKey) => {
    setRange(k);
    setPvHover(null);
    setDfHover(null);
    setDfSel(null);
  };

  // Range selector — sibling of the mode selector below, same markup and styling.
  // Used in BOTH inline cards and BOTH full-screen overlays, driving the same
  // lifted `range` so every view stays in sync.
  // ONE pill-row idiom behind every selector in §4/§5, so they read as siblings
  // and a styling change lands in a single place. Used in BOTH the inline cards
  // and the full-screen overlays, always driving the same lifted state.
  const pillRow = <T extends string>(
    opts: readonly { key: T; label: string }[],
    active: T,
    onPick: (k: T) => void,
  ) => (
    <div
      className="inline-flex flex-wrap rounded-lg border border-border p-0.5"
      style={{ background: "var(--surface-inset)" }}
    >
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onPick(o.key)}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
          style={{
            background: active === o.key ? "var(--surface-raised)" : "transparent",
            color: active === o.key ? "var(--ink)" : "var(--ink-muted)",
            boxShadow: active === o.key ? "var(--pill-shadow)" : "none",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  const rangeSelector = pillRow(PV_RANGES, range, applyRange);
  // Book mode swaps WHICH leg every metric reads: net → gross long → gross short.
  const bookSelector = pillRow(PV_MODES, bookMode, setBookMode);
  // Metric labels follow the active book mode: "(Net)" → "(Long)" → "(Short)".
  const metricSelector = pillRow(
    PV_METRICS.map((m) => ({ key: m.key, label: metricLabel(m.key, bookMode) })),
    metric,
    setMetric,
  );
  const renderToggle = pillRow(
    [
      { key: "line" as RenderMode, label: "Line" },
      { key: "bar" as RenderMode, label: "Bar" },
    ],
    renderMode,
    setRenderMode,
  );
  // §5 runs on one instrument at a time — futures / calls / puts.
  const dfInstSelector = pillRow(
    DF_INSTRUMENTS.map((o) => ({ key: o.key as string, label: o.label })),
    dfInst,
    setDfInst,
  );
  return (
    <div className="space-y-14">
      {/* ── 1 · Who's long, who's short ── */}
      <section id="sec-long-short">
        <SectionHeader
          n={1}
          eyebrow={`Long vs Short balance · ${pvData ? pvData.dateDisplay[pvData.dates.length - 1] : "latest session"}`}
          title="Who's long, who's short — by participant"
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            Each participant&apos;s open interest normalised to 100% long-vs-short within the chosen
            instrument. A balance, not a size — bars aren&apos;t comparable in magnitude across participants.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            {/* instrument selector — Futures / Calls / Puts (kept at its own larger
                size; the pillRow idiom is the compact in-card variant) */}
            <div className="inline-flex rounded-lg border border-border p-0.5" style={{ background: "var(--surface-inset)" }}>
              {LS_INSTRUMENTS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLsInst(t.key)}
                  className="px-3.5 py-1.5 rounded-md text-sm font-medium transition-all"
                  style={{
                    background: lsInst === t.key ? "var(--surface-raised)" : "transparent",
                    color: lsInst === t.key ? INK : "var(--ink-muted)",
                    boxShadow: lsInst === t.key ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {/* Legend. Each card is drawn in its OWN participant colour now, so
                this can no longer be two fixed hues — it shows the solid/faded
                split instead, and the participant key lives on the card titles. */}
            <div className="flex items-center gap-5 text-xs" style={{ fontFamily: "'DM Mono', monospace", color: "var(--ink-soft)" }}>
              <span className="inline-flex items-center gap-2">
                <span style={{ width: 13, height: 13, background: INK, borderRadius: 3, display: "inline-block" }} />
                Long
              </span>
              <span className="inline-flex items-center gap-2">
                <span style={{ width: 13, height: 13, background: INK, opacity: 0.65, borderRadius: 3, display: "inline-block" }} />
                Short
              </span>
              <span style={{ color: MUTED }}>· each card in its participant&apos;s colour</span>
            </div>
          </div>
        </SectionHeader>
        <div className="mt-6">
          {pvFailed ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
              Live chart data unavailable. Generate it with{" "}
              <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
            </div>
          ) : !pvData ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
              Loading chart…
            </div>
          ) : (
            <LongShortChart data={pvData} instrument={lsInst} />
          )}
        </div>
      </section>

      {/* ── 2 · Participant-Wise Report ── (name lives out here, on the gray bg) */}
      <section id="sec-participant-report" className="pt-12 border-t border-border">
        <SectionHeader n={2} eyebrow="Daily snapshot · one trading day" title="Participant-Wise Report">
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            Every OI line for the four participants on a single day, each cell with its day-over-day
            change. NET rows are highlighted; pick any trading day from the dropdown.
          </p>
        </SectionHeader>
        <div className="mt-6">
          <ParticipantReport />
        </div>
      </section>

      {/* ── 3 · Strategies ──
          Its own section, deliberately ABOVE the participant chart. A signal is
          a different kind of object from a chart: nested under the chart's
          controls it read as a caption to the chart rather than a conclusion
          drawn from it. This section grows as strategies are added. */}
      <section id="sec-strategies" className="pt-12 border-t border-border">
        <SectionHeader
          n={3}
          eyebrow="Strategies · signals derived from participant positioning"
          title="Strategy signals"
        >
          <p className="mt-2 text-sm" style={{ color: "var(--ink-muted)", maxWidth: 640 }}>
            Rules built on participant open interest, each with its live state, the reference period it
            is measured against, and every historical firing it has produced. All are research
            strategies under evaluation — the numbers are measured, not promises.
          </p>
        </SectionHeader>
        <div className="mt-6 space-y-6">
          {pvFailed ? (
            <div
              className="rounded-2xl border border-border px-7 py-8 text-sm"
              style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
            >
              Strategy data unavailable. Generate it with{" "}
              <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
            </div>
          ) : !pvData ? (
            <div
              className="rounded-2xl border border-border px-7 py-8 text-sm"
              style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
            >
              Loading strategies…
            </div>
          ) : (
            <>
              <PeakReversalCard data={pvData} />
              <CycleStrip data={pvData} />
            </>
          )}
        </div>
      </section>

      {/* ── 4 · NIFTY vs All Participants ── (was §4; old §3 removed) */}
      <section id="sec-participants-nifty" className="pt-12 border-t border-border">
        <SectionHeader
          n={4}
          eyebrow="NIFTY vs All Participants"
          title="All four participants against NIFTY 50"
        >
          <p className="mt-2 text-sm" style={{ color: "var(--ink-muted)", maxWidth: 640 }}>
            NIFTY 50 on top, every participant below it on one colour key. The book selector swaps
            which leg each metric reads — the net position, or the gross long or short leg behind
            it. Δ views show the one-day change instead of the level. Nothing is normalised; hover
            any day to read all four participants together.
          </p>
        </SectionHeader>
        <div className="mt-6">
          {pvFailed ? (
            <div
              className="rounded-2xl border border-border px-7 py-8 text-sm"
              style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
            >
              Live chart data unavailable. Generate it with{" "}
              <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
            </div>
          ) : !pvData ? (
            <div
              className="rounded-2xl border border-border px-7 py-8 text-sm"
              style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
            >
              Loading chart…
            </div>
          ) : (
            <div
              className="rounded-2xl border border-border p-5 md:p-7"
              style={{ background: "var(--surface-card)" }}
            >
              {/* Signal above the chart: it is a reading, and the chart below is
                  the evidence you check it against. Renders nothing when the
                  payload has no `saturation` key (older exports). */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {bookSelector}
                <div className="flex flex-wrap items-center gap-3">
                  {renderToggle}
                  <button
                    onClick={() => setPvFull(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors"
                    style={{ color: "var(--ink)", background: "var(--surface-inset)" }}
                  >
                    ⤢ Full screen
                  </button>
                </div>
              </div>
              <div className="mt-3">{metricSelector}</div>
              <div className="mt-3">{rangeSelector}</div>
              <div className="mt-5">
                {/* The FULL dataset goes in, not a pre-sliced window: Δ must be
                    derived before slicing or the first day of every range is wrong. */}
                <ParticipantChart
                  data={pvData}
                  mode={bookMode}
                  metric={metric}
                  range={range}
                  render={renderMode}
                  hover={pvHover}
                  setHover={setPvHover}
                  selection={pvSel}
                  setSelection={setPvSel}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* full-screen overlay — SAME component + SAME shared state, sized to fit
          the viewport with no scroll (flex column: fixed header + flex-1 chart). */}
      {pvFull && pvData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "var(--surface-page)",
            overflow: "hidden",
            padding: "16px 24px 18px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3 shrink-0">
            <p className="text-lg font-semibold" style={{ fontFamily: "'Playfair Display', serif", color: "var(--ink)" }}>
              <em>All four participants against NIFTY 50</em>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {renderToggle}
              <button
                onClick={() => setPvFull(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors"
                style={{ color: "var(--ink)", background: "var(--surface-card)" }}
              >
                ✕ Close (Esc)
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 mb-3 shrink-0">
            {bookSelector}
            {metricSelector}
            {rangeSelector}
          </div>
          <div style={{ flex: "1 1 0", minHeight: 0 }}>
            <ParticipantChart
              data={pvData}
              mode={bookMode}
              metric={metric}
              range={range}
              render={renderMode}
              hover={pvHover}
              setHover={setPvHover}
              selection={pvSel}
              setSelection={setPvSel}
              tall
            />
          </div>
        </div>
      )}

      {/* ── 4 · Who derived the move ── (driver / absorber on the futures flow) */}
      <section id="sec-driver" className="pt-12 border-t border-border">
        <SectionHeader
          n={5}
          eyebrow={`Who derived the move · ${DF_INSTRUMENTS.find((o) => o.key === dfInst)?.label ?? "Index Futures"}`}
          title="Who drove each day — driver, absorber & conviction"
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 640 }}>
            The four net lines are context; the ribbon beneath them names the day&apos;s <em>driver</em> — the
            biggest one-day change in the chosen instrument that agrees with the NIFTY move. A run of one colour is
            persistence. Hover to rank every player by today&apos;s Δ, with conviction (Δ vs their own book) and
            who absorbed it.
          </p>
        </SectionHeader>
        <div className="mt-6">
          {pvFailed ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
              Live chart data unavailable. Generate it with{" "}
              <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
            </div>
          ) : !pvData ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "var(--surface-card)", color: MUTED }}>
              Loading chart…
            </div>
          ) : (
            <div className="rounded-2xl border border-border p-5 md:p-7" style={{ background: "var(--surface-card)" }}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
                <div className="flex flex-wrap items-center gap-3">
                  {dfInstSelector}
                  {rangeSelector}
                </div>
                <button
                  onClick={() => setDfFull(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{ color: INK, background: "var(--surface-page)" }}
                >
                  ⤢ Full screen
                </button>
              </div>
              {pvWindow && (
                <DriverFuturesChart
                  data={pvWindow}
                  hover={dfHover}
                  setHover={setDfHover}
                  selection={dfSel}
                  setSelection={setDfSel}
                  instrument={dfInst}
                />
              )}
            </div>
          )}
        </div>
      </section>

      {/* full-screen overlay — SAME DriverFuturesChart + SAME shared state, sized
          to fit the viewport with no scroll (flex column: header + flex-1 chart). */}
      {dfFull && pvData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: BG,
            overflow: "hidden",
            padding: "16px 24px 18px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div className="flex items-center justify-between mb-3 shrink-0">
            <p className="text-lg font-semibold" style={{ fontFamily: "'Playfair Display', serif", color: INK }}>
              <em>Who drove each day — {DF_INSTRUMENTS.find((o) => o.key === dfInst)?.label ?? "Index Futures"}</em>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {dfInstSelector}
              {rangeSelector}
              <button
                onClick={() => setDfFull(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors"
                style={{ color: INK, background: "var(--surface-card)" }}
              >
                ✕ Close (Esc)
              </button>
            </div>
          </div>
          <div style={{ flex: "1 1 0", minHeight: 0 }}>
            {pvWindow && (
              <DriverFuturesChart
                data={pvWindow}
                hover={dfHover}
                setHover={setDfHover}
                selection={dfSel}
                setSelection={setDfSel}
                tall
                instrument={dfInst}
              />
            )}
          </div>
        </div>
      )}

      {/* ── 5 · The dossier — who holds what, and who moved ── */}
      <section id="sec-dossier" className="pt-12 border-t border-border">
        <SectionHeader
          n={6}
          eyebrow="Daily dossier · net-OI one-day change"
          title="The one-day read — who holds what"
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            An editorial read of a single day: who bought what who sold, each participant&apos;s book,
            and the pairing that matters. Switch instrument or day inside the card.
          </p>
        </SectionHeader>
        <div className="mt-6">
          <ParticipantDossier />
        </div>
      </section>
    </div>
  );
}

// ─── nav ─────────────────────────────────────────────────────────────────────
// `section` → a real, clickable in-app view (switches the main content).
// `soon`    → a planned feature (greyed, inert, "Soon" pill).
const NAV_ITEMS: {
  label: string;
  section?: Section;
  soon?: boolean;
}[] = [
  { label: "Participant vs Market", section: "participant" },
  { label: "Weekly Comparison", section: "weekly" },
  { label: "FII / DII Flows", soon: true },
  { label: "Option Chain", soon: true },
  { label: "Delivery Data", soon: true },
  { label: "Open Interest", section: "oi" },
];

const TABS: { key: Tab; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

// ─── app ─────────────────────────────────────────────────────────────────────
/** Reads the saved choice once, before first paint, so there is no flash of the
 *  wrong theme. Defaults to dark when nothing has been saved yet. */
function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem("pulse-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* private mode / storage disabled — fall through to the default */
  }
  return "dark";
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [section, setSection] = useState<Section>("participant");
  const [activeTab, setActiveTab] = useState<Tab>("daily");
  const [data, setData] = useState<BriefData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the brief for the selected timeframe. Each tab is its own JSON file,
  // written by:  python analysis.py --export-dashboard
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);

    // Vite serves frontend/public/ at the site root, so these files live at
    // /data/*.json. no-store because the daily job rewrites them in place.
    fetch(`/data/${activeTab}.json`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${activeTab}.json — HTTP ${r.status}`);
        return r.json();
      })
      .then((d: BriefData) => alive && setData(d))
      .catch((e) => alive && setError(e.message ?? String(e)));

    return () => {
      alive = false;
    };
  }, [activeTab]);

  // One class on <html> flips every --token in theme.css at once.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("pulse-theme", theme);
    } catch {
      /* storage unavailable — the theme still applies for this session */
    }
  }, [theme]);

  return (
    <div
      className="min-h-screen bg-background"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      {/* ── Navbar ── (bar spans full width; inner content shares the body's max width) */}
      <nav
        className="sticky top-0 z-50 h-14 border-b"
        style={{ background: "var(--nav-bg)", borderColor: "rgba(255,255,255,0.07)" }}
      >
        <div className="w-[80%] mx-auto h-full flex items-center gap-0">
        {/* Wordmark */}
        <span
          className="text-white text-lg mr-8 shrink-0 select-none tracking-tight"
          style={{ fontFamily: "'Playfair Display', serif", fontWeight: 600 }}
        >
          Equinext Pulse
        </span>

        {/* Theme toggle — pinned right, mirrors the nav's own light-on-dark idiom */}
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="order-last ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors"
          style={{
            color: "rgba(255,255,255,0.72)",
            background: "rgba(255,255,255,0.07)",
            fontFamily: "'DM Mono', monospace",
          }}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☾ Dark" : "☀ Light"}
        </button>

        {/* Nav items */}
        <div className="hidden md:flex items-center">
          {NAV_ITEMS.map((item) => {
            const isActive = item.section === section;
            const clickable = !!item.section;
            return (
              <div
                key={item.label}
                onClick={clickable ? () => setSection(item.section!) : undefined}
                className="flex items-center gap-1.5 px-3 h-14 text-sm border-b-2 transition-colors"
                style={{
                  color: isActive ? "#FFFFFF" : "rgba(255,255,255,0.35)",
                  borderBottomColor: isActive ? TEAL : "transparent",
                  cursor: clickable ? "pointer" : "default",
                }}
              >
                {item.label}
                {item.soon && (
                  <span
                    className="text-xs uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.3)",
                    }}
                  >
                    Soon
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Timestamp — from the data file, not the browser clock.
            "Updated" is when this JSON was written; it is a different day from
            the trading date, so the two are labelled separately rather than
            run together (which would imply a clock time on the trading day). */}
        <div
          className="ml-auto text-xs shrink-0 hidden sm:block"
          style={{
            fontFamily: "'DM Mono', monospace",
            color: "rgba(255,255,255,0.32)",
          }}
        >
          {data ? `${data.marketLabel} · Updated ${data.generatedAtDisplay}` : ""}
        </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <div className="border-b border-border">
        <div className="w-[80%] mx-auto py-10 md:py-14 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1
              className="text-4xl md:text-[2.75rem] leading-[1.18] tracking-tight text-foreground"
              style={{ fontFamily: "'Playfair Display', serif", fontWeight: 400, maxWidth: 1200 }}
            >
              Everything you need to know before you invest —
              <br />
              <em
                style={{
                  fontStyle: "italic",
                  fontWeight: 600,
                  color: TEAL,
                }}
              >
                on your desk by 8 AM.
              </em>
            </h1>
            <p
              className="mt-4 text-base"
              style={{ color: "var(--ink-muted)", maxWidth: 400 }}
            >
              NSE participant positioning, refreshed every trading morning.
            </p>
          </div>
          <div
            className="shrink-0 self-start md:self-auto text-xs px-3.5 py-2 rounded-lg border border-border"
            style={{
              fontFamily: "'DM Mono', monospace",
              color: "var(--ink-muted)",
              background: "rgba(18,21,28,0.03)",
            }}
          >
            {/* The chip answers "which day is this brief about?" — that is a
                trading DATE, not a clock time. The page's own freshness is the
                navbar's "Updated …" stamp. */}
            Data as of
            <br />
            <span className="text-foreground font-medium">
              {data ? data.asOf.display : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="w-[80%] mx-auto py-8 space-y-5">

        {/* Weekly Comparison (home) — last-12-Tuesdays weekday comparison */}
        {section === "weekly" && <WeeklyComparisonView />}

        {/* Participant vs Market — NIFTY overlay + participant long/short */}
        {section === "participant" && <ParticipantView />}

        {/* Open Interest — the daily/weekly/monthly participant brief */}
        {section === "oi" && (
        <>
        {/* Tab selector + date context */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div
            className="inline-flex rounded-lg border border-border p-0.5 self-start"
            style={{ background: "var(--surface-inset)" }}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className="px-4 py-1.5 rounded-md text-sm font-medium transition-all"
                style={{
                  background: activeTab === t.key ? "var(--surface-raised)" : "transparent",
                  color: activeTab === t.key ? INK : "var(--ink-muted)",
                  boxShadow:
                    activeTab === t.key
                      ? "0 1px 3px rgba(18,21,28,0.08)"
                      : "none",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            className="text-sm flex items-center gap-2"
            style={{ fontFamily: "'DM Mono', monospace" }}
          >
            {data?.dateA && data?.dateB && (
              <>
                <span style={{ color: INK, fontWeight: 500 }}>{data.dateA.display}</span>
                <span style={{ color: "var(--ink-muted)" }}>vs</span>
                <span style={{ color: "var(--ink-muted)" }}>{data.dateB.display}</span>
              </>
            )}
          </div>
        </div>

        {/* Loading / error / unavailable states */}
        {error && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "var(--surface-card)" }}
          >
            <p className="text-sm" style={{ color: RED }}>
              Could not load {error}
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--ink-muted)" }}>
              Generate the data first: <code>python analysis.py --export-dashboard</code>
            </p>
          </div>
        )}

        {!data && !error && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "var(--surface-card)" }}
          >
            <p className="text-sm" style={{ color: "var(--ink-muted)" }}>Loading…</p>
          </div>
        )}

        {data && !data.available && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "var(--surface-card)" }}
          >
            <p className="text-xs uppercase tracking-widest mb-2" style={{ color: "var(--ink-muted)" }}>
              Not available
            </p>
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>{data.reason}</p>
          </div>
        )}

        {data && data.available && (
          <>
            {/* Headline card */}
            <div
              className="rounded-xl border border-border px-6 py-5"
              style={{ background: "var(--surface-card)" }}
            >
              <p
                className="text-xs uppercase tracking-widest mb-2"
                style={{ color: "var(--ink-muted)" }}
              >
                Biggest Move
              </p>
              <p
                className="text-xl md:text-2xl leading-snug font-semibold"
                style={{ fontFamily: "'Playfair Display', serif", color: INK }}
              >
                <em>{data.headline}</em>
              </p>
            </div>

            {/* Muted note chip — only when the backend held an actor back */}
            {data.note && (
              <p
                className="text-xs"
                style={{ fontFamily: "'DM Mono', monospace", color: "var(--ink-muted)" }}
              >
                {data.note}
              </p>
            )}

            {/* 2-column layout: actor cards + read panel */}
            <div className="grid lg:grid-cols-[1fr_288px] gap-5 items-start">
              {/* Actor cards */}
              <div className="space-y-4 min-w-0">
                {data.actors.map((actor) => (
                  <ActorCard key={actor.name + activeTab} actor={actor} />
                ))}
              </div>

              {/* Read panel — sticky on large screens */}
              <div className="lg:sticky lg:top-[72px]">
                <ReadPanel data={data} />
              </div>
            </div>

            {/* Total strip */}
            {data.total && (
              <div
                className="rounded-xl border border-border px-6 py-4 flex flex-wrap items-center gap-3"
                style={{ background: "var(--surface-card)" }}
              >
                <span
                  className="text-xs uppercase tracking-widest shrink-0"
                  style={{ color: "var(--ink-muted)" }}
                >
                  Total
                </span>
                <span
                  className="text-sm font-medium"
                  style={{ fontFamily: "'DM Mono', monospace", color: INK }}
                >
                  {data.total.field} {signed(data.total.change)}  ({fmt(data.total.oldVal)} → {fmt(data.total.newVal)})
                </span>
              </div>
            )}
          </>
        )}
        </>
        )}

        <div className="pb-10" />
      </div>
    </div>
  );
}
