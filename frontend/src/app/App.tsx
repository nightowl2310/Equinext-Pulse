import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import StrategyTeaser from "./components/StrategyTeaser";
import StrategiesView from "./components/StrategiesView";
import AsOfPicker from "./components/AsOfPicker";
import WeeklyComparison from "./components/WeeklyComparison";

type Section = "weekly" | "participant" | "strategies";

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
/** Green up, red down, muted for flat/unknown — never colour a zero. */
function toneOf(v: number | null): string {
  if (v === null || v === undefined || v === 0) return MUTED;
  return v > 0 ? GREEN : RED;
}

// ─── sub-components ──────────────────────────────────────────────────────────

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

// Home / first menu: weekday-over-weekday positioning.
//
// Replaces the old TuesdaySection, which read tuesday_summary.json. That file
// only ever holds the last 12 Tuesdays, so it could not answer "compare a date
// I choose", and it hard-coded Tuesday. WeeklyComparison derives the same
// comparison client-side from the full archive instead, which makes both the
// date and the weekday a choice.
function WeeklyComparisonView() {
  return (
    <div className="space-y-8">
      <WeeklyComparison />
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
  // The report is the only place STOCK derivatives appear — every other view in
  // the app is index-only. Collapsed by default so it matches them.
  const [showStock, setShowStock] = useState(false);

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

  // The file runs index block → stock block → Total. Cut at the first Stock row.
  //
  // Total is folded in WITH stock rather than left on screen, deliberately: it
  // spans index + stock, so showing it above a hidden stock block would give a
  // column that visibly refuses to add up. Better to hide it than to print a
  // number the visible rows contradict.
  const firstStock = report.rows.findIndex(
    (r) => /stock/i.test(r.label) || /stock/i.test(r.group ?? ""),
  );
  const splitAt = firstStock < 0 ? report.rows.length : firstStock;
  const visibleRows = showStock ? report.rows : report.rows.slice(0, splitAt);
  const hiddenCount = report.rows.length - splitAt;

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
            {visibleRows.map((row, i) => {
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

      {hiddenCount > 0 && (
        <div className="mt-4 pt-3 border-t border-border flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowStock((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors"
            style={{ color: INK, background: "var(--surface-inset)" }}
          >
            {showStock ? "▴ Hide stock derivatives" : `▾ Show stock derivatives (${hiddenCount} rows)`}
          </button>
          <span className="text-xs" style={{ color: MUTED }}>
            {showStock
              ? "Stock derivatives and the index+stock Total are shown. Every other view on this site is index-only."
              : "Index only — matching the rest of the site. The Total row spans index and stock, so it is folded in here too."}
          </span>
        </div>
      )}
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

function ParticipantView({
  asOf,
  onBounds,
  onOpenStrategies,
}: {
  asOf: string | null;
  onBounds: (first: string, last: string) => void;
  onOpenStrategies: () => void;
}) {
  const [lsInst, setLsInst] = useState("futures"); // Long/Short instrument selector

  // "NIFTY vs All Participants" — shared state lifted here so the inline card and
  // the full-screen overlay render the SAME ParticipantChart, always in sync.
  const [pvRaw, setPvRaw] = useState<ParticipantsData | null>(null);

  // THE AS-OF WALL. Everything downstream — chart, strategy — sees only
  // history up to the selected date, so the page can be read as it would have
  // looked on that day. Truncating the shared payload once here is what makes
  // that true everywhere at once; a per-component date filter would leave any
  // component that forgot to apply it quietly showing the future.
  const pvData = useMemo(() => {
    if (!pvRaw) return null;
    if (!asOf) return pvRaw;
    let hi = pvRaw.dates.length - 1;
    while (hi > 0 && pvRaw.dates[hi] > asOf) hi--;
    return sliceParticipantsData(pvRaw, 0, hi);
  }, [pvRaw, asOf]);
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
        setPvRaw(d);
        onBounds(d.dates[0], d.dates[d.dates.length - 1]);
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
      {/* ── 1 · Overview ── (titled generically so it does not restate the page
          headline, which now says "who's long, who's short" itself; the eyebrow
          below still carries the specifics) */}
      <section id="sec-long-short">
        <SectionHeader
          n={1}
          eyebrow={`Long vs Short balance · ${pvData ? pvData.dateDisplay[pvData.dates.length - 1] : "latest session"}`}
          title="Overview"
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

      {/* ── 3 · Who derived the move ── (driver / absorber on the futures flow) */}
      <section id="sec-driver" className="pt-12 border-t border-border">
        <SectionHeader
          n={3}
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
            margin: 0, // see the note on the §5 overlay — space-y-14 shortens it otherwise
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

      {/* ── 4 · Strategies ──
          Its own section, deliberately ABOVE the participant chart. A signal is
          a different kind of object from a chart: nested under the chart's
          controls it read as a caption to the chart rather than a conclusion
          drawn from it. This section grows as strategies are added. */}
      <section id="sec-strategies" className="pt-12 border-t border-border">
        <SectionHeader
          n={4}
          eyebrow="Signals · derived from participant positioning"
          title="Signal summary"
        >
          <p className="mt-2 text-sm" style={{ color: "var(--ink-muted)", maxWidth: 640 }}>
            A short read on what the strategy engine sees today. The full method, signal history and
            validation live on the Strategies page.
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
            <StrategyTeaser data={pvData} onOpen={onOpenStrategies} />
          )}
        </div>
      </section>

      {/* ── 5 · NIFTY vs All Participants ── */}
      <section id="sec-participants-nifty" className="pt-12 border-t border-border">
        <SectionHeader
          n={5}
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
            // MUST stay 0. This overlay is a child of the `space-y-14` wrapper,
            // which sets margin-top: 3.5rem on every child after the first —
            // fixed elements included. With top:0 AND bottom:0 the used height
            // is (viewport − margins), so that margin silently shortened the
            // overlay by 56px and let the page show through underneath it.
            margin: 0,
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

      {/* ── 6 · The dossier — who holds what, and who moved ── */}
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
// Every entry is a real, clickable view. The "Soon" placeholders that used to
// sit here are gone, so `section` is required and there is no inert state to
// style around — a nav item you cannot click is a promise, not a feature.
const NAV_ITEMS: { label: string; section: Section }[] = [
  { label: "Participant vs Market", section: "participant" },
  { label: "Strategies", section: "strategies" },
  { label: "Weekly Comparison", section: "weekly" },
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

  // AS-OF DATE. null = latest. Held at App level so the navbar control and every
  // view share one wall; each view truncates its own payload to this date.
  const [asOf, setAsOf] = useState<string | null>(null);
  const [bounds, setBounds] = useState<{ first: string; last: string } | null>(null);
  const onBounds = useCallback(
    (first: string, last: string) => setBounds((b) => (b && b.first === first && b.last === last ? b : { first, last })),
    [],
  );
  // One class on <html> flips every --token in theme.css at once.
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
            return (
              <div
                key={item.label}
                onClick={() => setSection(item.section)}
                className="flex items-center gap-1.5 px-3 h-14 text-sm border-b-2 transition-colors"
                style={{
                  color: isActive ? "#FFFFFF" : "rgba(255,255,255,0.35)",
                  borderBottomColor: isActive ? TEAL : "transparent",
                  cursor: "pointer",
                }}
              >
                {item.label}
              </div>
            );
          })}
        </div>

        {/* As-of control, navbar variant — shares state with the hero chip.
            Idle it reads the data file's own "Updated" stamp (when the JSON was
            written, a different day from the trading date). Pinned, it reads the
            date the page is walled to. */}
        <div className="ml-auto shrink-0 hidden sm:block">
          {/* idleLabel was the brief's file-write stamp; it is now the last
              trading day the archive actually covers — the more useful
              freshness claim, and it survives the Open Interest page going. */}
          <AsOfPicker
            asOf={asOf}
            setAsOf={setAsOf}
            bounds={bounds}
            variant="nav"
            idleLabel={bounds ? `NSE F&O · Data to ${fmtISO(bounds.last)}` : "Pick a date"}
          />
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
              Who&apos;s long, who&apos;s short in NIFTY —
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
              NSE participant open interest in NIFTY futures, calls and puts — every trading morning.
            </p>
          </div>
          {/* The chip answers "which day is this page about?" — a trading DATE,
              not a clock time. It is now the handle for changing that day: pick
              one and every view walls off everything after it. */}
          <div className="shrink-0 self-start md:self-auto">
            <AsOfPicker
              asOf={asOf}
              setAsOf={setAsOf}
              bounds={bounds}
              variant="hero"
              idleLabel={bounds ? fmtISO(bounds.last) : "—"}
            />
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="w-[80%] mx-auto py-8 space-y-5">

        {/* Weekly Comparison (home) — last-12-Tuesdays weekday comparison */}
        {section === "weekly" && <WeeklyComparisonView />}

        {/* Participant vs Market — NIFTY overlay + participant long/short */}
        {section === "participant" && (
          <ParticipantView
            asOf={asOf}
            onBounds={onBounds}
            onOpenStrategies={() => setSection("strategies")}
          />
        )}

        {/* Strategies — its own page, reached from the nav or the teaser card */}
        {section === "strategies" && <StrategiesView asOf={asOf} onBounds={onBounds} />}

        <div className="pb-10" />        <div className="pb-10" />
      </div>
    </div>
  );
}
