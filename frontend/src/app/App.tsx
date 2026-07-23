import { useEffect, useRef, useState } from "react";

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
const GREEN = "#158A4E";
const RED = "#C0362C";
const TEAL = "#0EA5A4";
const INK = "#12151C";
const BG = "#F7F6F2";
const GRID = "#E5E1D8";

// ─── number helpers ──────────────────────────────────────────────────────────
const MUTED = "#9E9A92";

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
      <path d={arcPath} fill="none" stroke="#E5E1D8" strokeWidth="10" strokeLinecap="round" />
      {/* Bearish end */}
      <circle cx={cx - r} cy={cy} r="5" fill={RED} />
      {/* Bullish end */}
      <circle cx={cx + r} cy={cy} r="5" fill={GREEN} />
      {/* Neutral tick */}
      <circle cx={cx} cy={cy - r} r="3" fill="#C8C3B8" />
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
        background: flat ? "#F2F1EE" : pos ? "#EBF6EF" : "#FBEEEC",
        color: flat ? MUTED : pos ? GREEN : RED,
        border: `1px solid ${flat ? "#E5E1D8" : pos ? "#BEE3CC" : "#F0C6C1"}`,
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
      style={{ background: "#FFFFFF" }}
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
              className="text-[10px] uppercase tracking-widest border border-border rounded px-1.5 py-0.5"
              style={{ color: "#9E9A92" }}
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
            <tr className="border-b border-border" style={{ color: "#9E9A92" }}>
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
                <td className="px-6 py-2.5 whitespace-nowrap" style={{ color: "#4A4740" }}>
                  {move.field}
                </td>
                <td
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  style={{ color: "#9E9A92" }}
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
        style={{ background: "#FFFFFF" }}
      >
        <p
          className="text-[10px] uppercase tracking-widest mb-3"
          style={{ color: "#9E9A92" }}
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
          className="text-[10px] text-center mt-1"
          style={{ color: "#B0AB9E", fontFamily: "'DM Mono', monospace" }}
        >
          −1 bearish · 0 neutral · +1 bullish
        </p>
      </div>

      {/* Signals */}
      <div
        className="rounded-xl border border-border p-5 space-y-3"
        style={{ background: "#FFFFFF" }}
      >
        <p
          className="text-[10px] uppercase tracking-widest"
          style={{ color: "#9E9A92" }}
        >
          Signals
        </p>
        {read.signals.map((s, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span
              className="shrink-0 text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded mt-0.5"
              style={{
                background: s.sentiment === "bullish" ? "#EBF6EF" : "#FBEEEC",
                color: s.sentiment === "bullish" ? GREEN : RED,
              }}
            >
              {s.sentiment}
            </span>
            <span
              className="text-xs leading-relaxed"
              style={{
                fontFamily: "'DM Mono', monospace",
                color: "#4A4740",
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
        style={{ background: "#FFFFFF" }}
      >
        <p
          className="text-[10px] uppercase tracking-widest mb-2"
          style={{ color: "#9E9A92" }}
        >
          Action
        </p>
        <p className="text-sm leading-relaxed" style={{ color: "#2E2B26" }}>
          {data.action}
        </p>
        <p
          className="text-[11px] mt-3 pt-3 border-t border-border"
          style={{ color: "#B0AB9E" }}
        >
          {data.disclaimer}
        </p>
      </div>
    </div>
  );
}

// ─── FII vs NIFTY view ───────────────────────────────────────────────────────
// The three honesty caveats, kept in sync with the ones burned into the PNG
// by plot_fii_vs_nifty.py. Shown as selectable HTML too, since the PNG's own
// caption text is tiny on small screens.
const FII_NIFTY_CAVEATS = [
  "Index OI aggregates ALL index F&O (NIFTY + BANKNIFTY + FINNIFTY + MIDCPNIFTY + NEXT50); NIFTY 50 close is a directional proxy, not an exact match.",
  "Thursday (weekly-expiry) vertical lines: OI jumps there are mechanical rollover, not sentiment.",
  "FII net is one side of a zero-sum book (Client / DII / Pro hold the other side) — this is FII's stance vs price, not the whole market.",
];

// ── the interactive chart data contract (written by plot_fii_vs_nifty.py) ──
interface PricePoint {
  date: string;
  dateDisplay: string; // "16 Jan 2026"
  day: string; // "Friday"
  expiry: boolean; // Thursday = weekly expiry
  close: number;
  // per-participant nets, keyed by "Client" | "DII" | "FII" | "Pro"
  nets: Record<string, { fut: number; call: number; put: number }>;
}
interface FiiNiftyData {
  symbol: string;
  start: string;
  end: string;
  count: number;
  actors: string[];
  points: PricePoint[];
}

// Panels, top→bottom. `net` panels get a zero baseline and read the SELECTED
// participant's net; the top panel is always the NIFTY close.
const PANELS: {
  sub: "fut" | "call" | "put" | null; // null = NIFTY close
  label: string;
  unit: string;
  color: string;
  net: boolean;
  h: number;
}[] = [
  { sub: null, label: "NIFTY 50 close", unit: "pts", color: TEAL, net: false, h: 150 },
  { sub: "fut", label: "Net index futures", unit: "contracts", color: "#D97706", net: true, h: 98 },
  { sub: "call", label: "Net index calls", unit: "contracts", color: RED, net: true, h: 98 },
  { sub: "put", label: "Net index puts", unit: "contracts", color: GREEN, net: true, h: 98 },
];

function priceStr(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── "NIFTY vs All Participants" data contract (participants_vs_nifty.json,
//    written by plot_fii_vs_nifty.py). Columnar arrays on the shared date axis. ──
interface ParticipantSeries {
  futures: (number | null)[];
  calls: (number | null)[];
  puts: (number | null)[];
}
interface ParticipantsData {
  symbol: string;
  start: string;
  end: string;
  count: number;
  dates: string[];
  dateDisplay: string[]; // "20 Jul 2026"
  day: string[]; // "Monday"
  expiry: boolean[]; // Thursday = weekly expiry
  nifty: (number | null)[];
  participants: Record<string, ParticipantSeries>; // "FII" | "DII" | "Client" | "Pro"
}

// One consistent colour per participant, used across ALL instrument panels + legend.
const PV_PARTICIPANTS = ["FII", "DII", "Client", "Pro"] as const;
const PV_COLORS: Record<string, string> = {
  FII: "#0EA5A4", // teal
  DII: "#E1A200", // amber
  Client: "#C0362C", // red
  Pro: "#158A4E", // green
};
// The three instrument panels (top NIFTY panel is handled separately).
const PV_INSTRUMENTS: { key: keyof ParticipantSeries; label: string }[] = [
  { key: "futures", label: "Net index futures" },
  { key: "calls", label: "Net index calls" },
  { key: "puts", label: "Net index puts" },
];

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

/** ONE reusable chart for the "NIFTY vs All Participants" section. Pure render:
 *  all shared state (loaded data, hovered index) is lifted to the parent so the
 *  inline card and the full-screen overlay stay perfectly in sync. `tall` grows
 *  the panels for full-screen; nothing else changes. */
function ParticipantsNiftyChart({
  data,
  hover,
  setHover,
  tall,
}: {
  data: ParticipantsData;
  hover: number | null;
  setHover: (i: number | null) => void;
  tall?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const N = data.dates.length;
  const active = hover ?? N - 1;

  // panel bands, top→bottom: NIFTY close, then the three instrument panels.
  // Full-screen simply makes each band taller (same component, same maths).
  const niftyH = tall ? 240 : 150;
  const instH = tall ? 230 : 128; // 4 lines/panel wants more room than the single-line sibling
  const bandDefs = [
    { kind: "nifty" as const, label: "NIFTY 50 close", unit: "pts", h: niftyH },
    ...PV_INSTRUMENTS.map((ins) => ({ kind: "inst" as const, ins, label: ins.label, unit: "contracts", h: instH })),
  ];

  // geometry — generous gaps so a panel's title never collides with the lines above
  const padL = 12;
  const padR = 12;
  const gap = tall ? 40 : 32;
  const axisH = 30;
  const top0 = 16;
  let cur = top0;
  const bands = bandDefs.map((b) => {
    const top = cur;
    const bottom = cur + b.h;
    cur = bottom + gap;
    return { ...b, top, bottom };
  });
  const chartBottom = bands[bands.length - 1].bottom;
  const height = chartBottom + axisH;
  const plotL = padL;
  const plotR = Math.max(padL + 1, width - padR);
  const plotW = plotR - plotL;
  const xOf = (i: number) => plotL + (N <= 1 ? 0 : (i / (N - 1)) * plotW);

  // per-panel y-scale. NIFTY: its own range. Instrument panels: min/max across
  // ALL FOUR participants for that instrument, always including the zero line.
  const scales = bands.map((b) => {
    let vals: number[];
    if (b.kind === "nifty") {
      vals = data.nifty.filter((v): v is number => v !== null);
    } else {
      vals = [];
      for (const p of PV_PARTICIPANTS) {
        for (const v of data.participants[p][b.ins.key]) if (v !== null) vals.push(v);
      }
    }
    let lo = vals.length ? Math.min(...vals) : 0;
    let hi = vals.length ? Math.max(...vals) : 1;
    if (b.kind === "inst") {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (hi === lo) hi = lo + 1;
    const range = hi - lo;
    lo -= range * 0.12;
    hi += range * 0.14; // top headroom below the title band
    const yOf = (v: number) => b.bottom - ((v - lo) / (hi - lo)) * (b.bottom - b.top);
    return { yOf };
  });

  const onMove = (e: React.MouseEvent) => {
    if (!svgRef.current || N < 2) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let i = Math.round(((px - plotL) / plotW) * (N - 1));
    i = Math.max(0, Math.min(N - 1, i));
    setHover(i);
  };

  const thursdays = data.expiry.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  const ticks: number[] = [];
  const step = Math.max(1, Math.round(N / 8));
  for (let i = 0; i < N; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== N - 1) ticks.push(N - 1);

  const niftyClose = data.nifty[active];

  return (
    <div className="w-full">
      {/* live readout — date + NIFTY, plus a per-participant net matrix that
          doubles as the legend (in the header, never over the lines) */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 mb-4">
        <div className="text-base" style={{ fontFamily: "'DM Mono', monospace" }}>
          <span style={{ color: INK, fontWeight: 600 }}>{data.dateDisplay[active]}</span>
          <span style={{ color: MUTED }}>
            {" · "}
            {data.day[active]}
            {data.expiry[active] ? " · expiry" : ""}
            {hover === null ? " · latest" : ""}
          </span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>
            NIFTY 50
          </span>
          <span
            className="text-base md:text-lg font-semibold"
            style={{ fontFamily: "'DM Mono', monospace", color: TEAL }}
          >
            {niftyClose === null ? "—" : priceStr(niftyClose)}
          </span>
        </div>
      </div>

      {/* legend + live per-participant nets (Fut / Call / Put) for the active day */}
      <div className="mb-5 overflow-x-auto">
        <table className="text-xs" style={{ fontFamily: "'DM Mono', monospace", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: MUTED }}>
              <th className="text-left font-normal pr-4 pb-1.5" />
              <th className="text-right font-normal px-3 pb-1.5">Futures</th>
              <th className="text-right font-normal px-3 pb-1.5">Calls</th>
              <th className="text-right font-normal px-3 pb-1.5">Puts</th>
            </tr>
          </thead>
          <tbody>
            {PV_PARTICIPANTS.map((p) => {
              const s = data.participants[p];
              const cell = (v: number | null) => (v === null ? "—" : signed(v));
              return (
                <tr key={p}>
                  <td className="pr-4 py-0.5">
                    <span className="inline-flex items-center gap-2" style={{ color: INK }}>
                      <span
                        style={{ width: 12, height: 12, borderRadius: 3, background: PV_COLORS[p], display: "inline-block" }}
                      />
                      {p}
                    </span>
                  </td>
                  <td className="text-right px-3 py-0.5" style={{ color: INK }}>
                    {cell(s.futures[active])}
                  </td>
                  <td className="text-right px-3 py-0.5" style={{ color: INK }}>
                    {cell(s.calls[active])}
                  </td>
                  <td className="text-right px-3 py-0.5" style={{ color: INK }}>
                    {cell(s.puts[active])}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div ref={boxRef} className="w-full" style={{ position: "relative" }}>
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            style={{ display: "block", touchAction: "none" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* faint Thursday (weekly-expiry) verticals across all panels */}
            {thursdays.map((i) => (
              <line
                key={"t" + i}
                x1={xOf(i)}
                x2={xOf(i)}
                y1={bands[0].top}
                y2={chartBottom}
                stroke={MUTED}
                strokeWidth={0.6}
                opacity={0.14}
              />
            ))}

            {bands.map((b, bi) => {
              const sc = scales[bi];
              return (
                <g key={b.label}>
                  {/* panel title — sits in its own band, above the plot area */}
                  <text x={plotL + 1} y={b.top - 5} fontSize={11} fill={MUTED} style={{ fontFamily: "'DM Sans', sans-serif" }}>
                    {b.label} <tspan fill="#C8C3B8">· {b.unit}</tspan>
                  </text>

                  {b.kind === "nifty" ? (
                    <>
                      {pvSegments(data.nifty, xOf, sc.yOf).map((pts, si) => (
                        <polyline key={si} points={pts} fill="none" stroke={TEAL} strokeWidth={1.8} strokeLinejoin="round" />
                      ))}
                      {niftyClose !== null && (
                        <circle cx={xOf(active)} cy={sc.yOf(niftyClose)} r={3.5} fill={TEAL} stroke="#FFFFFF" strokeWidth={1.2} />
                      )}
                    </>
                  ) : (
                    <>
                      {/* zero baseline */}
                      <line x1={plotL} x2={plotR} y1={sc.yOf(0)} y2={sc.yOf(0)} stroke={MUTED} strokeWidth={1} opacity={0.5} />
                      {PV_PARTICIPANTS.map((p) => {
                        const series = data.participants[p][b.ins.key];
                        const v = series[active];
                        return (
                          <g key={p}>
                            {pvSegments(series, xOf, sc.yOf).map((pts, si) => (
                              <polyline
                                key={si}
                                points={pts}
                                fill="none"
                                stroke={PV_COLORS[p]}
                                strokeWidth={1.5}
                                strokeLinejoin="round"
                              />
                            ))}
                            {v !== null && (
                              <circle cx={xOf(active)} cy={sc.yOf(v)} r={3} fill={PV_COLORS[p]} stroke="#FFFFFF" strokeWidth={1.1} />
                            )}
                          </g>
                        );
                      })}
                    </>
                  )}
                </g>
              );
            })}

            {/* the crosshair — one vertical line spanning every panel */}
            <line
              x1={xOf(active)}
              x2={xOf(active)}
              y1={bands[0].top}
              y2={chartBottom}
              stroke={INK}
              strokeWidth={1}
              opacity={hover === null ? 0.28 : 0.55}
              strokeDasharray="3 3"
            />

            {/* x-axis date ticks (categorical: exact trading days, no weekends) */}
            {ticks.map((i) => (
              <text
                key={"x" + i}
                x={xOf(i)}
                y={chartBottom + 16}
                fontSize={9}
                fill={MUTED}
                textAnchor="middle"
                style={{ fontFamily: "'DM Mono', monospace" }}
              >
                {data.dateDisplay[i].slice(0, 6)}
              </text>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

/** Stacked-panel chart with ONE crosshair spanning every panel, driven by real
 *  data. Renders nothing but a note if the data can't be loaded. */
function FiiNiftyChart({ participant }: { participant: string }) {
  const [data, setData] = useState<FiiNiftyData | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/fii_vs_nifty.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: FiiNiftyData) => {
        if (!alive) return;
        if (!d || !Array.isArray(d.points) || d.points.length < 2) throw new Error("empty");
        setData(d);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // "if can't load the data, don't show it" — a quiet note, never a fake chart.
  if (failed) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Live chart data unavailable. Generate it with{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Loading chart…
      </div>
    );
  }

  const pts = data.points;
  const N = pts.length;
  // a panel's value = NIFTY close (top panel) or the SELECTED participant's net
  const valAt = (p: PricePoint, b: { sub: "fut" | "call" | "put" | null }) =>
    b.sub === null ? p.close : p.nets[participant][b.sub];

  // geometry — roomier bands + wider gaps for breathing space
  const padL = 12;
  const padR = 12;
  const gap = 28;
  const axisH = 30;
  const top0 = 16;
  const bands = PANELS.map((p) => ({ ...p, top: 0, bottom: 0 }));
  let cur = top0;
  for (const b of bands) {
    b.top = cur;
    b.bottom = cur + b.h;
    cur = b.bottom + gap;
  }
  const chartBottom = bands[bands.length - 1].bottom;
  const height = chartBottom + axisH;
  const plotL = padL;
  const plotR = Math.max(padL + 1, width - padR);
  const plotW = plotR - plotL;
  const xOf = (i: number) => plotL + (N <= 1 ? 0 : (i / (N - 1)) * plotW);

  // per-panel y scale (net panels always include 0)
  const scales = bands.map((b) => {
    const vals = pts.map((p) => valAt(p, b));
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (b.net) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (hi === lo) hi = lo + 1;
    const range = hi - lo;
    lo -= range * 0.1;
    hi += range * 0.26; // extra top headroom so the line clears the panel label
    const yOf = (v: number) => b.bottom - ((v - lo) / (hi - lo)) * (b.bottom - b.top);
    return { yOf };
  });

  const active = hover ?? N - 1;
  const ap = pts[active];

  const onMove = (e: React.MouseEvent) => {
    if (!svgRef.current || N < 2) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let i = Math.round(((px - plotL) / plotW) * (N - 1));
    i = Math.max(0, Math.min(N - 1, i));
    setHover(i);
  };

  const thursdays = pts.map((p, i) => (p.expiry ? i : -1)).filter((i) => i >= 0);
  const ticks: number[] = [];
  const step = Math.max(1, Math.round(N / 8));
  for (let i = 0; i < N; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== N - 1) ticks.push(N - 1);

  return (
    <div className="rounded-2xl border border-border p-5 md:p-7" style={{ background: "#FFFFFF" }}>
      {/* live readout — updates to the hovered day (falls back to the latest) */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 mb-5">
        <div className="text-base" style={{ fontFamily: "'DM Mono', monospace" }}>
          <span style={{ color: INK, fontWeight: 600 }}>{ap.dateDisplay}</span>
          <span style={{ color: MUTED }}>
            {" · "}
            {ap.day}
            {ap.expiry ? " · expiry" : ""}
            {hover === null ? " · latest" : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {[
            { label: "NIFTY 50", val: priceStr(ap.close), color: TEAL },
            { label: "Net futures", val: signed(ap.nets[participant].fut), color: "#D97706" },
            { label: "Net calls", val: signed(ap.nets[participant].call), color: RED },
            { label: "Net puts", val: signed(ap.nets[participant].put), color: GREEN },
          ].map((s) => (
            <div key={s.label} className="flex flex-col leading-tight">
              <span className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>
                {s.label}
              </span>
              <span className="text-base md:text-lg font-semibold" style={{ fontFamily: "'DM Mono', monospace", color: s.color }}>
                {s.val}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div ref={boxRef} className="w-full" style={{ position: "relative" }}>
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            style={{ display: "block", touchAction: "none" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* faint Thursday (weekly-expiry) verticals across all panels */}
            {thursdays.map((i) => (
              <line
                key={"t" + i}
                x1={xOf(i)}
                x2={xOf(i)}
                y1={bands[0].top}
                y2={chartBottom}
                stroke={MUTED}
                strokeWidth={0.6}
                opacity={0.16}
              />
            ))}

            {bands.map((b, bi) => {
              const sc = scales[bi];
              const line = pts.map((p, i) => `${xOf(i)},${sc.yOf(valAt(p, b))}`).join(" ");
              const baseY = b.net ? sc.yOf(0) : b.bottom;
              const area =
                `M ${xOf(0)},${baseY} ` +
                pts.map((p, i) => `L ${xOf(i)},${sc.yOf(valAt(p, b))}`).join(" ") +
                ` L ${xOf(N - 1)},${baseY} Z`;
              return (
                <g key={b.label}>
                  {/* panel label */}
                  <text x={plotL + 1} y={b.top + 11} fontSize={10} fill={MUTED} style={{ fontFamily: "'DM Sans', sans-serif" }}>
                    {b.label} <tspan fill="#C8C3B8">· {b.unit}</tspan>
                  </text>
                  {/* zero baseline on net panels */}
                  {b.net && (
                    <line x1={plotL} x2={plotR} y1={sc.yOf(0)} y2={sc.yOf(0)} stroke={MUTED} strokeWidth={1} opacity={0.5} />
                  )}
                  <path d={area} fill={b.color} opacity={0.1} />
                  <polyline points={line} fill="none" stroke={b.color} strokeWidth={1.6} strokeLinejoin="round" />
                  {/* crosshair dot for this panel */}
                  {hover !== null && (
                    <circle cx={xOf(active)} cy={sc.yOf(valAt(ap, b))} r={3.5} fill={b.color} stroke="#FFFFFF" strokeWidth={1.2} />
                  )}
                </g>
              );
            })}

            {/* the crosshair — one vertical line spanning every panel */}
            {hover !== null && (
              <line
                x1={xOf(active)}
                x2={xOf(active)}
                y1={bands[0].top}
                y2={chartBottom}
                stroke={INK}
                strokeWidth={1}
                opacity={0.55}
                strokeDasharray="3 3"
              />
            )}

            {/* x-axis date ticks (categorical: exact trading days, no weekends) */}
            {ticks.map((i) => (
              <text
                key={"x" + i}
                x={xOf(i)}
                y={chartBottom + 16}
                fontSize={9}
                fill={MUTED}
                textAnchor="middle"
                style={{ fontFamily: "'DM Mono', monospace" }}
              >
                {pts[i].dateDisplay.slice(0, 6)}
              </text>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

// One editorial PNG (matplotlib) per PARTICIPANT per instrument, each in its own
// card. Built by plot_long_short.py → long_short_<instrument>_<participant>_<date>.png
// (4 participants × 3 instruments = 12 cards).
const LONG_SHORT_DATE = "2026-07-20";
const LS_INSTRUMENTS = [
  { key: "futures", label: "Index Futures" },
  { key: "calls", label: "Index Calls" },
  { key: "puts", label: "Index Puts" },
];
const LS_ACTORS = ["Client", "DII", "FII", "Pro"];

function ParticipantCard({ instKey, actor, label }: { instKey: string; actor: string; label: string }) {
  const [ok, setOk] = useState(true);
  return (
    <div className="rounded-2xl border border-border p-3" style={{ background: "#FFFFFF" }}>
      {ok ? (
        <img
          src={`/long_short_${instKey}_${actor.toLowerCase()}_${LONG_SHORT_DATE}.png`}
          alt={`${actor} — ${label} long-vs-short balance on ${LONG_SHORT_DATE}.`}
          className="w-full h-auto rounded-lg"
          onError={() => setOk(false)}
        />
      ) : (
        <div className="px-2 py-10 text-center text-xs" style={{ color: MUTED }}>
          {actor} unavailable — run{" "}
          <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_long_short.py</code>.
        </div>
      )}
    </div>
  );
}

function LongShortChart({ instrument }: { instrument: string }) {
  const inst = LS_INSTRUMENTS.find((i) => i.key === instrument) ?? LS_INSTRUMENTS[0];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
      {LS_ACTORS.map((a) => (
        <ParticipantCard key={a} instKey={inst.key} actor={a} label={inst.label} />
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
        style={{ width: 34, height: 34, background: INK, color: "#FFFFFF", fontFamily: "'DM Mono', monospace" }}
      >
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: MUTED }}>
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
  FII: "#C0362C",
  DII: "#0EA5A4",
  Pro: "#D97706",
  Client: "#2563EB",
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
    bg: bull ? "#EBF6EF" : bear ? "#FBEEEC" : "#F2F1EE",
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
                <text x={plotL - 8} y={yOf(tv) + 3} fontSize={9} fill={MUTED} textAnchor="end" style={{ fontFamily: "'DM Mono', monospace" }}>
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
                <text key={"x" + i} x={xOf(i)} y={plotB + 18} fontSize={9} fill={MUTED} textAnchor="middle" style={{ fontFamily: "'DM Mono', monospace" }}>
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
                  <circle key={"d" + a} cx={xOf(active)} cy={yOf(ar.net[a] as number)} r={3.5} fill={TUE_COLORS[a]} stroke="#FFFFFF" strokeWidth={1.2} />
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
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Tuesday summary unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python export_tuesday_summary.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
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
        <div className="inline-flex rounded-lg border border-border p-0.5 mt-4" style={{ background: "#EDECEA" }}>
          {TUE_INSTRUMENTS.map((t) => (
            <button
              key={t.key}
              onClick={() => setInst(t.key)}
              className="px-3.5 py-1.5 rounded-md text-sm font-medium transition-all"
              style={{
                background: inst === t.key ? "#FFFFFF" : "transparent",
                color: inst === t.key ? INK : "#9E9A92",
                boxShadow: inst === t.key ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* the table */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={{ background: "#FFFFFF" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-border" style={{ color: "#9E9A92" }}>
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
                    style={latest ? { background: "#ECEBE7" } : undefined}
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
        <p className="text-xs mt-4 pt-3 border-t border-border" style={{ color: "#B0AB9E" }}>
          Immediately answers: who changed the most (Winner) · who dominated · what the bias was.
          {inst === "puts" ? "  Puts: adding net long puts reads bearish, so the FII-Δ sign is inverted for bias." : ""}
        </p>
      </div>

      {/* the line chart — net levels of all four participants across the 12 Tuesdays */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={{ background: "#FFFFFF" }}>
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
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Participant report unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python participant_report.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Loading participant report…
      </div>
    );
  }

  const activeDate = sel && data.reports[sel] ? sel : data.dates[data.dates.length - 1];
  const report = data.reports[activeDate];

  return (
    <div className="rounded-2xl border border-border p-5 md:p-7" style={{ background: "#FFFFFF" }}>
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
          style={{ fontFamily: "'DM Mono', monospace", color: INK, background: "#FFFFFF" }}
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
                  style={net ? { background: "#FBF7E8" } : undefined}
                >
                  <td
                    className="px-3 py-2 whitespace-nowrap"
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      color: net ? INK : "#4A4740",
                      fontWeight: net ? 700 : 400,
                    }}
                  >
                    {row.label}
                  </td>
                  {PR_COLS.map((c) => {
                    const cell = row.cells[c];
                    return (
                      <td key={c} className="px-3 py-2 text-right whitespace-nowrap align-top">
                        <div style={{ color: net ? INK : "#2E2B26", fontWeight: net ? 700 : 500 }}>
                          {cell && cell.v != null ? valStr(cell.v) : "—"}
                        </div>
                        {cell && cell.chg != null && (
                          <div className="text-[10px]" style={{ color: toneOf(cell.chg) }}>
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
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
        Dossier data unavailable — run{" "}
        <code style={{ fontFamily: "'DM Mono', monospace" }}>python participant_report.py</code>.
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
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

  // horizontal diverging bar-chart geometry
  const labelW = 66;
  const rowH = 40;
  const chartH = sorted.length * rowH + 8;
  const cx = labelW + Math.max(1, w - labelW) / 2; // zero centre line
  const half = Math.max(20, (w - labelW) / 2 - 96); // room for the value labels
  const maxAbs = Math.max(1, ...sorted.map((b) => Math.abs(b.chg)));
  const barLen = (v: number) => (Math.abs(v) / maxAbs) * half;

  return (
    <div className="rounded-2xl border border-border overflow-hidden" style={{ background: "#FFFFFF" }}>
      {/* masthead + controls */}
      <div className="px-6 md:px-8 pt-6 pb-4 border-b border-border">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-lg tracking-tight" style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, color: INK }}>
            Equinext Pulse
          </span>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: MUTED, fontFamily: "'DM Mono', monospace" }}>
            {I.label} · {fmtISO(activeDate)} · net one-day change
          </span>
        </div>
        <p className="text-xs italic mt-1" style={{ color: MUTED }}>
          Participant open-interest dossier — who holds what, and who moved.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5" style={{ background: "#EDECEA" }}>
            {DOSSIER_INSTS.map((t) => (
              <button
                key={t.key}
                onClick={() => setInst(t.key)}
                className="px-3 py-1 rounded-md text-sm font-medium transition-all"
                style={{
                  background: inst === t.key ? "#FFFFFF" : "transparent",
                  color: inst === t.key ? INK : "#9E9A92",
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
            style={{ fontFamily: "'DM Mono', monospace", color: INK, background: "#FFFFFF" }}
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
        <p className="mt-3 text-base md:text-lg leading-relaxed" style={{ color: "#2E2B26", maxWidth: 760 }}>
          {lede}
        </p>
      </div>

      {/* the chart */}
      <div className="px-6 md:px-8 pt-7">
        <p className="text-[10px] uppercase tracking-widest mb-3" style={{ color: MUTED }}>
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
                    <text x={labelW - 10} y={y + (rowH - 14) / 2} fontSize={13} textAnchor="end" dominantBaseline="middle" fill={INK} style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>
                      {DNAME[b.p].short}
                    </text>
                    <rect x={bx} y={y} width={Math.max(1, len)} height={rowH - 14} fill={pos ? INK : "#C7C2B6"} rx={2} />
                    <text
                      x={pos ? bx + len + 8 : bx - 8}
                      y={y + (rowH - 14) / 2}
                      fontSize={12}
                      textAnchor={pos ? "start" : "end"}
                      dominantBaseline="middle"
                      fill={pos ? INK : "#6B6459"}
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
        <p className="text-[10px] uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          Who holds what · NSE participant OI ({fmtISO(activeDate)}, net contracts)
        </p>
        <div className="space-y-3">
          {DOSSIER_PARTS.map((p) => {
            const d = ex[p];
            return (
              <div key={p} className="flex items-start gap-3 pb-3 border-b border-border/40 last:border-0">
                <span
                  className="shrink-0 text-[10px] uppercase tracking-wider font-bold rounded px-2 py-1 mt-0.5"
                  style={{ background: "#12151C", color: "#FFFFFF", fontFamily: "'DM Mono', monospace" }}
                >
                  {DNAME[p].short}
                </span>
                <div className="min-w-0 text-sm" style={{ color: "#2E2B26" }}>
                  <span style={{ fontFamily: "'DM Mono', monospace" }}>
                    Futures net {longShort(d.futures.net)} ({chgStr(d.futures.chg)} today). Calls net {longShort(d.calls.net)} ({chgStr(d.calls.chg)}). Puts net {longShort(d.puts.net)} ({chgStr(d.puts.chg)}). Gross longs — futures {fmt(d.futures.long ?? 0)}, calls {fmt(d.calls.long ?? 0)}, puts {fmt(d.puts.long ?? 0)}.
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
      <div className="px-6 md:px-8 py-6 mt-2" style={{ background: "#F7F6F2" }}>
        <p className="text-sm leading-relaxed" style={{ color: "#2E2B26" }}>
          <span style={{ fontWeight: 700 }}>The pairing: </span>
          {pairing}
        </p>
      </div>
    </div>
  );
}

const PARTICIPANTS = ["FII", "DII", "Client", "Pro"];

function ParticipantView() {
  const [participant, setParticipant] = useState("FII");
  const [lsInst, setLsInst] = useState("futures"); // Long/Short instrument selector

  // "NIFTY vs All Participants" — shared state lifted here so the inline card and
  // the full-screen overlay render the SAME ParticipantsNiftyChart, always in sync.
  const [pvData, setPvData] = useState<ParticipantsData | null>(null);
  const [pvFailed, setPvFailed] = useState(false);
  const [pvHover, setPvHover] = useState<number | null>(null);
  const [pvFull, setPvFull] = useState(false);

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

  // Esc closes the full-screen overlay.
  useEffect(() => {
    if (!pvFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPvFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pvFull]);

  const others = ["FII", "DII", "Pro", "Client"].filter((x) => x !== participant).join(" / ");
  const caveats = [
    FII_NIFTY_CAVEATS[0],
    FII_NIFTY_CAVEATS[1],
    `${participant} net is one side of a zero-sum book (${others} hold the other side) — this is ${participant}'s stance vs price, not the whole market.`,
  ];
  return (
    <div className="space-y-14">
      {/* ── 1 · Who's long, who's short ── */}
      <section id="sec-long-short">
        <SectionHeader
          n={1}
          eyebrow="Long vs Short balance · 20 Jul 2026"
          title="Who's long, who's short — by participant"
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            Each participant&apos;s open interest normalised to 100% long-vs-short within the chosen
            instrument. A balance, not a size — bars aren&apos;t comparable in magnitude across participants.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            {/* instrument selector — Futures / Calls / Puts */}
            <div className="inline-flex rounded-lg border border-border p-0.5" style={{ background: "#EDECEA" }}>
              {LS_INSTRUMENTS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLsInst(t.key)}
                  className="px-3.5 py-1.5 rounded-md text-sm font-medium transition-all"
                  style={{
                    background: lsInst === t.key ? "#FFFFFF" : "transparent",
                    color: lsInst === t.key ? INK : "#9E9A92",
                    boxShadow: lsInst === t.key ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {/* legend */}
            <div className="flex items-center gap-5 text-xs" style={{ fontFamily: "'DM Mono', monospace", color: "#4A4740" }}>
              <span className="inline-flex items-center gap-2">
                <span style={{ width: 13, height: 13, background: "#F4B400", borderRadius: 3, display: "inline-block" }} />
                Long
              </span>
              <span className="inline-flex items-center gap-2">
                <span style={{ width: 13, height: 13, background: "#000000", borderRadius: 3, display: "inline-block" }} />
                Short
              </span>
            </div>
          </div>
        </SectionHeader>
        <div className="mt-6">
          <LongShortChart instrument={lsInst} />
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

      {/* ── 3 · Positioning vs Price ── */}
      <section id="sec-positioning" className="pt-12 border-t border-border">
        <SectionHeader
          n={3}
          eyebrow="Positioning vs Price"
          title={`${participant} index F&O positioning against NIFTY 50`}
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            Six months on one shared timeline — the index price above {participant}&apos;s net futures,
            calls and puts. Each panel keeps its own natural units; nothing is normalised. Hover to read any day.
          </p>
          {/* participant selector — drives the chart, heading and reading notes */}
          <div className="inline-flex rounded-lg border border-border p-0.5 mt-4" style={{ background: "#EDECEA" }}>
            {PARTICIPANTS.map((a) => (
              <button
                key={a}
                onClick={() => setParticipant(a)}
                className="px-3.5 py-1.5 rounded-md text-sm font-medium transition-all"
                style={{
                  background: participant === a ? "#FFFFFF" : "transparent",
                  color: participant === a ? INK : "#9E9A92",
                  boxShadow: participant === a ? "0 1px 3px rgba(18,21,28,0.08)" : "none",
                }}
              >
                {a}
              </button>
            ))}
          </div>
        </SectionHeader>
        <div className="mt-6 space-y-8">
          <FiiNiftyChart participant={participant} />
          {/* Reading notes (the caveats, as selectable text) */}
          <div className="rounded-2xl border border-border px-7 py-6 space-y-2.5" style={{ background: "#FFFFFF" }}>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
              Reading notes
            </p>
            {caveats.map((c, i) => (
              <p
                key={i}
                className="text-xs leading-relaxed"
                style={{ fontFamily: "'DM Mono', monospace", color: "#4A4740" }}
              >
                •&nbsp;&nbsp;{c}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4 · NIFTY vs All Participants ── */}
      <section id="sec-participants-nifty" className="pt-12 border-t border-border">
        <SectionHeader
          n={4}
          eyebrow="NIFTY vs All Participants"
          title="All four participants against NIFTY 50"
        >
          <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 620 }}>
            The same shared timeline, but every participant at once — FII, DII, Client and Pro net
            futures, calls and puts on one colour key. Each panel keeps its own natural units;
            nothing is normalised. Hover any day to read all four books together.
          </p>
        </SectionHeader>
        <div className="mt-6">
          {pvFailed ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
              Live chart data unavailable. Generate it with{" "}
              <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
            </div>
          ) : !pvData ? (
            <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ background: "#FFFFFF", color: MUTED }}>
              Loading chart…
            </div>
          ) : (
            <div className="rounded-2xl border border-border p-5 md:p-7" style={{ background: "#FFFFFF" }}>
              <div className="flex justify-end mb-1">
                <button
                  onClick={() => setPvFull(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{ color: INK, background: "#F7F6F2" }}
                >
                  ⤢ Full screen
                </button>
              </div>
              <ParticipantsNiftyChart data={pvData} hover={pvHover} setHover={setPvHover} />
            </div>
          )}
        </div>
      </section>

      {/* full-screen overlay — SAME component + SAME shared state, just taller */}
      {pvFull && pvData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: BG,
            overflowY: "auto",
            padding: "20px 24px 32px",
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <p className="text-lg font-semibold" style={{ fontFamily: "'Playfair Display', serif", color: INK }}>
              <em>All four participants against NIFTY 50</em>
            </p>
            <button
              onClick={() => setPvFull(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors"
              style={{ color: INK, background: "#FFFFFF" }}
            >
              ✕ Close (Esc)
            </button>
          </div>
          <ParticipantsNiftyChart data={pvData} hover={pvHover} setHover={setPvHover} tall />
        </div>
      )}

      {/* ── 5 · The dossier — who holds what, and who moved ── */}
      <section id="sec-dossier" className="pt-12 border-t border-border">
        <SectionHeader
          n={5}
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
export default function App() {
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

  return (
    <div
      className="min-h-screen bg-background"
      style={{ fontFamily: "'DM Sans', sans-serif" }}
    >
      {/* ── Navbar ── (bar spans full width; inner content shares the body's max width) */}
      <nav
        className="sticky top-0 z-50 h-14 border-b"
        style={{ background: INK, borderColor: "rgba(255,255,255,0.07)" }}
      >
        <div className="w-[80%] mx-auto h-full flex items-center gap-0">
        {/* Wordmark */}
        <span
          className="text-white text-lg mr-8 shrink-0 select-none tracking-tight"
          style={{ fontFamily: "'Playfair Display', serif", fontWeight: 600 }}
        >
          Equinext Pulse
        </span>

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
                    className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full"
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
              style={{ color: "#9E9A92", maxWidth: 400 }}
            >
              NSE participant positioning, refreshed every trading morning.
            </p>
          </div>
          <div
            className="shrink-0 self-start md:self-auto text-xs px-3.5 py-2 rounded-lg border border-border"
            style={{
              fontFamily: "'DM Mono', monospace",
              color: "#9E9A92",
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
            style={{ background: "#EDECEA" }}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className="px-4 py-1.5 rounded-md text-sm font-medium transition-all"
                style={{
                  background: activeTab === t.key ? "#FFFFFF" : "transparent",
                  color: activeTab === t.key ? INK : "#9E9A92",
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
                <span style={{ color: "#B0AB9E" }}>vs</span>
                <span style={{ color: "#9E9A92" }}>{data.dateB.display}</span>
              </>
            )}
          </div>
        </div>

        {/* Loading / error / unavailable states */}
        {error && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "#FFFFFF" }}
          >
            <p className="text-sm" style={{ color: RED }}>
              Could not load {error}
            </p>
            <p className="text-xs mt-2" style={{ color: "#9E9A92" }}>
              Generate the data first: <code>python analysis.py --export-dashboard</code>
            </p>
          </div>
        )}

        {!data && !error && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "#FFFFFF" }}
          >
            <p className="text-sm" style={{ color: "#9E9A92" }}>Loading…</p>
          </div>
        )}

        {data && !data.available && (
          <div
            className="rounded-xl border border-border px-6 py-5"
            style={{ background: "#FFFFFF" }}
          >
            <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: "#9E9A92" }}>
              Not available
            </p>
            <p className="text-sm" style={{ color: "#2E2B26" }}>{data.reason}</p>
          </div>
        )}

        {data && data.available && (
          <>
            {/* Headline card */}
            <div
              className="rounded-xl border border-border px-6 py-5"
              style={{ background: "#FFFFFF" }}
            >
              <p
                className="text-[10px] uppercase tracking-widest mb-2"
                style={{ color: "#9E9A92" }}
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
                style={{ fontFamily: "'DM Mono', monospace", color: "#B0AB9E" }}
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
                style={{ background: "#FFFFFF" }}
              >
                <span
                  className="text-[10px] uppercase tracking-widest shrink-0"
                  style={{ color: "#9E9A92" }}
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
