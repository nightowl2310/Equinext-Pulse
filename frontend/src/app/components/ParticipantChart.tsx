import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BookMode,
  type ChartSelection,
  type MetricKey,
  type ParticipantsData,
  type RangeKey,
  DECIMATE_ABOVE,
  PV_COLORS,
  PV_PARTICIPANTS,
  PV_ROLE,
  decimateIndices,
  domainOf,
  fmtAxis,
  fmtCompact,
  fmtDateDMY,
  metricLabel,
  resolveMetric,
  rangeStartIndex,
  segmentsOf,
  smoothPath,
  toDelta,
} from "../lib/series";

export type RenderMode = "line" | "bar";

// Panel geometry. The NIFTY strip stays deliberately short — it is the anchor,
// not the subject; the participant panel gets the room.
const PAD_L = 68;
const PAD_R = 18;
const PAD_T = 14;
const AXIS_H = 30;
const NIFTY_H = 110;
const NIFTY_H_TALL = 170;
const MAIN_H = 300;
const MAIN_H_TALL = 460;

/** "+1.25M" / "−40k" — sign carried outside fmtCompact so it reads consistently. */
function signedCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return (v > 0 ? "+" : "−") + fmtCompact(Math.abs(v));
}

/** Percent move from a to b, or null when the base is 0/missing (never Infinity). */
function pctMove(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

function pctText(p: number | null): string {
  return p === null ? "" : ` (${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(2)}%)`;
}

/**
 * NIFTY price strip above one selector-driven participant panel.
 *
 * Pure render: `hover` and `selection` are lifted to the parent so the inline
 * card and the full-screen overlay stay in lockstep. `hover` is a position
 * within the DISPLAYED points, not a raw data index — resolve through
 * `view.idx`. `selection` anchors are RAW indices (see ChartSelection).
 */
export function ParticipantChart({
  data,
  mode,
  metric,
  range,
  render,
  hover,
  setHover,
  selection,
  setSelection,
  tall,
}: {
  data: ParticipantsData;
  mode: BookMode;
  metric: MetricKey;
  range: RangeKey;
  render: RenderMode;
  hover: number | null;
  setHover: (i: number | null) => void;
  selection: ChartSelection | null;
  setSelection: (s: ChartSelection | null) => void;
  tall?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    const { field, isDelta } = resolveMetric(metric, mode);

    // Δ is derived on the FULL array and only then sliced. Doing it the other
    // way round makes the first point of every range null or wrong.
    const seriesFull: Record<string, (number | null)[]> = {};
    for (const p of PV_PARTICIPANTS) {
      const raw = (data.participants[p]?.[field] ?? []) as (number | null)[];
      seriesFull[p] = isDelta ? toDelta(raw) : raw;
    }

    const i0 = rangeStartIndex(data.dates, range);
    const n = data.dates.length - i0;

    // Only LEVEL series may be thinned — stride-sampling a Δ series would drop
    // exactly the one-day spikes it exists to show.
    const local = isDelta
      ? Array.from({ length: n }, (_, k) => k)
      : decimateIndices(n, DECIMATE_ABOVE);
    const idx = local.map((k) => i0 + k);

    const series: Record<string, (number | null)[]> = {};
    for (const p of PV_PARTICIPANTS) series[p] = seriesFull[p];

    // EVERY index in the window, decimated or not. The y-domains are computed
    // from this, never from `idx`: stride-sampling can skip the window's true
    // high or low, which would put a line outside its own band and make the
    // visible peak disagree with the same days seen at a narrower range.
    const fullIdx = Array.from({ length: n }, (_, k) => i0 + k);

    const decimated = !isDelta && n > DECIMATE_ABOVE;
    return { idx, fullIdx, series, isDelta, decimated, pointCount: n };
  }, [data, mode, metric, range]);

  const { idx, fullIdx, series, isDelta, decimated } = view;
  const dateIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    data.dates.forEach((d, i) => m.set(d, i));
    return m;
  }, [data.dates]);
  const niftyH = tall ? NIFTY_H_TALL : NIFTY_H;
  const mainH = tall ? MAIN_H_TALL : MAIN_H;
  const totalH = PAD_T + niftyH + 26 + mainH + AXIS_H;
  const plotW = Math.max(10, width - PAD_L - PAD_R);

  const xOf = (k: number) => (idx.length <= 1 ? PAD_L + plotW / 2 : PAD_L + (k / (idx.length - 1)) * plotW);

  // ── domains ──────────────────────────────────────────────────────────────
  const niftyVals = fullIdx.map((i) => data.nifty[i]);
  const [nLo, nHi] = domainOf([niftyVals], false);
  const niftyTop = PAD_T;
  const niftyY = (v: number) => niftyTop + niftyH - ((v - nLo) / (nHi - nLo)) * niftyH;

  const shown = PV_PARTICIPANTS.map((p) => fullIdx.map((i) => series[p][i]));
  const [mLo, mHi] = domainOf(shown, true);
  const mainTop = PAD_T + niftyH + 26;
  const mainY = (v: number) => mainTop + mainH - ((v - mLo) / (mHi - mLo)) * mainH;
  const zeroY = mainY(0);

  // ── ticks ────────────────────────────────────────────────────────────────
  const yTicks = useMemo(() => {
    const out: number[] = [];
    const steps = 5;
    for (let i = 0; i <= steps; i++) out.push(mLo + ((mHi - mLo) * i) / steps);
    return out;
  }, [mLo, mHi]);

  const xTicks = useMemo(() => {
    const want = Math.max(2, Math.min(8, Math.floor(plotW / 130)));
    const out: number[] = [];
    for (let i = 0; i < want; i++) out.push(Math.round((i * (idx.length - 1)) / Math.max(1, want - 1)));
    return Array.from(new Set(out));
  }, [idx.length, plotW]);

  // ── interaction ──────────────────────────────────────────────────────────
  // ONE clientX → displayed-position conversion, shared by hover and click, so
  // the crosshair and the anchor you drop can never disagree by a pixel.
  const kAt = (clientX: number, rect: DOMRect) => {
    if (idx.length <= 1) return 0;
    const k = Math.round(((clientX - rect.left - PAD_L) / plotW) * (idx.length - 1));
    return Math.max(0, Math.min(idx.length - 1, k));
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    setHover(kAt(e.clientX, e.currentTarget.getBoundingClientRect()));
  };

  const active = hover !== null && hover >= 0 && hover < idx.length ? hover : null;
  const activeOrig = active !== null ? idx[active] : null;

  // ── measurement selection ────────────────────────────────────────────────
  // Anchors are RAW indices. `idx` is rebuilt whenever range or metric changes,
  // so resolve raw → nearest displayed position at render time; null means the
  // anchor sits outside the window currently on screen.
  const kOfRaw = (raw: number | null): number | null => {
    if (raw === null || !idx.length) return null;
    if (raw < idx[0] || raw > idx[idx.length - 1]) return null;
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const d = Math.abs(idx[k] - raw);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };

  const sel = selection;
  const selP = sel?.participant ?? null;
  // While the second anchor is pending the crosshair previews it, so the band
  // grows as you sweep towards the point you are about to click.
  const rawA = sel ? sel.a : null;
  const rawB = sel ? (sel.b ?? activeOrig) : null;
  const kA = kOfRaw(rawA);
  const kB = kOfRaw(rawB);
  const bandLo = kA !== null && kB !== null ? Math.min(kA, kB) : null;
  const bandHi = kA !== null && kB !== null ? Math.max(kA, kB) : null;
  // The numbers below the chart read straight off the raw indices, so they stay
  // correct even when the anchors have scrolled out of the visible range.
  const anchorsOffscreen =
    !!sel && (kOfRaw(sel.a) === null || (sel.b !== null && kOfRaw(sel.b) === null));

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = idx[kAt(e.clientX, rect)];
    // The pending branch MUST stay first: were the dismiss guard below it, the
    // second click of a new measurement would cancel instead of locking B.
    if (sel && sel.b === null) return setSelection({ ...sel, b: raw });
    // A COMPLETED measurement is dismissed by the next click, so getting back to
    // plain hovering never requires finding Esc or the Clear button. Starting a
    // fresh span is therefore click-to-dismiss, click-to-anchor.
    if (sel) return setSelection(null);

    // A fresh measurement: the line you clicked is whichever participant sits
    // nearest the pointer vertically at that day.
    const y = e.clientY - rect.top;
    let pick: string | null = null;
    let bestD = Infinity;
    for (const p of PV_PARTICIPANTS) {
      const v = series[p][raw];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const d = Math.abs(mainY(v) - y);
      if (d < bestD) {
        bestD = d;
        pick = p;
      }
    }
    if (pick) setSelection({ participant: pick, a: raw, b: null });
  };

  // Anchor rings: the locked one is solid, the previewed one hollow. Each ring
  // carries BOTH indices — `k` places it horizontally, `raw` supplies the value.
  // They can diverge: an anchor stored while a Δ view was up (undecimated) need
  // not survive as a member of `idx` once a decimated level view returns, and
  // reading the snapped `idx[k]` would then draw a neighbouring day's value
  // under a table that correctly shows the anchor's own.
  const anchors: { k: number; raw: number; locked: boolean }[] = [];
  if (kA !== null && rawA !== null) anchors.push({ k: kA, raw: rawA, locked: true });
  if (kB !== null && rawB !== null && kB !== kA)
    anchors.push({ k: kB, raw: rawB, locked: sel?.b !== null && sel?.b !== undefined });

  const dimOf = (p: string) => (sel && p !== selP ? 0.28 : 1);
  const inBand = (k: number) => bandLo !== null && bandHi !== null && k >= bandLo && k <= bandHi;

  if (width === 0) return <div ref={wrapRef} style={{ width: "100%", height: totalH }} />;

  const label = metricLabel(metric, mode);
  const bandW = plotW / Math.max(1, idx.length);
  const barW = Math.max(0.6, Math.min(9, bandW / 4 - 0.6));

  return (
    <div ref={wrapRef} style={{ width: "100%", position: "relative" }}>
      {/* legend — top-right, mirrors the reference layout */}
      <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1.5 pb-2">
        {PV_PARTICIPANTS.map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ink-muted)" }}>
            {render === "bar" ? (
              <span style={{ width: 10, height: 10, borderRadius: 2, background: PV_COLORS[p] }} />
            ) : (
              <span className="inline-flex items-center">
                <span style={{ width: 16, height: 2, background: PV_COLORS[p] }} />
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: PV_COLORS[p],
                    marginLeft: -11,
                    marginRight: 5,
                  }}
                />
              </span>
            )}
            {PV_ROLE[p]}
          </span>
        ))}
      </div>

      <svg
        width={width}
        height={totalH}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
        style={{ display: "block", cursor: "crosshair" }}
      >
        {/* ── measured band ── drawn first so every line stays legible on top */}
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
            lines for the currently-measured participant only. Legs are
            contiguous (each turn ends one leg and starts the next) and there
            are dozens per participant, so drawing all four participants'
            legs at once would tile the whole chart; instead this only draws
            once a participant is picked via the measurement selection, using
            that participant's own legs. */}
        {data.cycles && selP && (() => {
          const legs = data.cycles.legs[selP];
          if (!legs?.length) return null;
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
              <g key={`${selP}-cycle-${li}`} pointerEvents="none">
                <rect
                  x={Math.min(x0, x1)}
                  y={mainTop}
                  width={Math.max(1, Math.abs(x1 - x0))}
                  height={mainH}
                  fill={fill}
                  opacity={0.09}
                />
                <line
                  x1={x0}
                  x2={x1}
                  y1={mainY(leg.avgPrice)}
                  y2={mainY(leg.avgPrice)}
                  stroke={PV_COLORS[selP]}
                  strokeWidth="1.4"
                  strokeDasharray="4 3"
                  opacity={0.65}
                />
              </g>
            );
          });
        })()}

        {/* ── NIFTY strip ── */}
        <text x={PAD_L} y={PAD_T - 2} fontSize="10" fill="var(--ink-muted)" fontFamily="'DM Mono', monospace">
          NIFTY 50 close
        </text>
        <line x1={PAD_L} y1={niftyTop + niftyH} x2={PAD_L + plotW} y2={niftyTop + niftyH} stroke="var(--grid)" strokeWidth="1" />
        {(() => {
          const segs = segmentsOf(
            data.nifty,
            idx,
            (k) => xOf(k),
            (v) => niftyY(v),
          );
          return segs.map((s, i) => (
            <path key={i} d={smoothPath(s)} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
          ));
        })()}
        {activeOrig !== null && data.nifty[activeOrig] !== null && (
          <circle cx={xOf(active!)} cy={niftyY(data.nifty[activeOrig] as number)} r="3.5" fill="var(--ink)" />
        )}

        {/* ── main panel ── */}
        <text x={PAD_L} y={mainTop - 8} fontSize="10" fill="var(--ink-muted)" fontFamily="'DM Mono', monospace">
          {label} · contracts
        </text>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={mainY(t)} x2={PAD_L + plotW} y2={mainY(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PAD_L - 8} y={mainY(t) + 3.5} fontSize="10" textAnchor="end" fill="var(--ink-muted)" fontFamily="'DM Mono', monospace">
              {fmtAxis(t)}
            </text>
          </g>
        ))}
        {mLo < 0 && mHi > 0 && (
          <line x1={PAD_L} y1={zeroY} x2={PAD_L + plotW} y2={zeroY} stroke="var(--hairline)" strokeWidth="1" />
        )}

        {render === "line"
          ? PV_PARTICIPANTS.map((p) => {
              const segs = segmentsOf(series[p], idx, (k) => xOf(k), (v) => mainY(v));
              // The measured stretch of the picked line is redrawn heavier on
              // top of the ordinary stroke — that is the "selected part".
              const measured =
                p === selP && bandLo !== null && bandHi !== null
                  ? segmentsOf(
                      series[p],
                      idx.slice(bandLo, bandHi + 1),
                      (k) => xOf(bandLo + k),
                      (v) => mainY(v),
                    )
                  : [];
              return (
                <g key={p} opacity={dimOf(p)}>
                  {segs.map((s, i) => (
                    <path
                      key={i}
                      d={smoothPath(s)}
                      fill="none"
                      stroke={PV_COLORS[p]}
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {measured.map((s, i) => (
                    <path
                      key={"m" + i}
                      d={smoothPath(s)}
                      fill="none"
                      stroke={PV_COLORS[p]}
                      strokeWidth="4"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {/* dots only when they are actually distinguishable */}
                  {idx.length <= 90 &&
                    idx.map((i, k) => {
                      const v = series[p][i];
                      if (v === null || v === undefined || !Number.isFinite(v)) return null;
                      return <circle key={k} cx={xOf(k)} cy={mainY(v)} r="2.4" fill={PV_COLORS[p]} />;
                    })}
                </g>
              );
            })
          : idx.map((i, k) => (
              <g key={k}>
                {PV_PARTICIPANTS.map((p, pi) => {
                  const v = series[p][i];
                  if (v === null || v === undefined || !Number.isFinite(v)) return null;
                  const x = xOf(k) - barW * 2 + pi * barW;
                  const y = mainY(Math.max(0, v));
                  const h = Math.abs(mainY(v) - zeroY);
                  // Same emphasis as the line view: picked participant inside
                  // the measured span at full strength, everything else receding.
                  const op = !sel ? 1 : p !== selP ? 0.25 : inBand(k) ? 1 : 0.5;
                  return (
                    <rect key={p} x={x} y={y} width={barW} height={Math.max(0.6, h)} fill={PV_COLORS[p]} opacity={op} />
                  );
                })}
              </g>
            ))}

        {/* ── measurement anchors ── on the picked line AND the NIFTY strip */}
        {selP &&
          anchors.map((an, i) => {
            const v = series[selP][an.raw];
            const nv = data.nifty[an.raw];
            return (
              <g key={"anc" + i} pointerEvents="none">
                <line
                  x1={xOf(an.k)}
                  x2={xOf(an.k)}
                  y1={PAD_T}
                  y2={mainTop + mainH}
                  stroke={PV_COLORS[selP]}
                  strokeWidth="1.4"
                  strokeDasharray={an.locked ? undefined : "3 3"}
                  opacity="0.9"
                />
                {nv !== null && nv !== undefined && (
                  <circle
                    cx={xOf(an.k)}
                    cy={niftyY(nv)}
                    r="4"
                    fill={an.locked ? "var(--ink)" : "var(--surface-card)"}
                    stroke="var(--ink)"
                    strokeWidth="1.6"
                  />
                )}
                {v !== null && v !== undefined && Number.isFinite(v) && (
                  <circle
                    cx={xOf(an.k)}
                    cy={mainY(v)}
                    r="5"
                    fill={an.locked ? PV_COLORS[selP] : "var(--surface-card)"}
                    stroke={PV_COLORS[selP]}
                    strokeWidth="2"
                  />
                )}
              </g>
            );
          })}

        {/* ── x axis ── */}
        {xTicks.map((k) => (
          <text
            key={k}
            x={xOf(k)}
            y={mainTop + mainH + 18}
            fontSize="10"
            textAnchor="middle"
            fill="var(--ink-muted)"
            fontFamily="'DM Mono', monospace"
          >
            {fmtDateDMY(data.dates[idx[k]])}
          </text>
        ))}

        {/* ── crosshair ── */}
        {active !== null && (
          <line
            x1={xOf(active)}
            y1={PAD_T}
            x2={xOf(active)}
            y2={mainTop + mainH}
            stroke="var(--crosshair)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.75"
          />
        )}
      </svg>

      {/* ── measurement readout ──────────────────────────────────────────────
          Driven off `selection` ONLY — never off `hover`, which goes null the
          moment the pointer leaves the SVG and would blank the locked numbers.
          Values are read at the RAW indices, so they stay right even when the
          anchors have fallen outside the visible range. */}
      {sel && selP && (() => {
        const ra = sel.a;
        const rb = rawB; // locked B, or the live preview while picking
        const pending = sel.b === null;
        const sessions = rb === null ? null : Math.abs(rb - ra);
        const rows = [
          {
            key: "NIFTY 50",
            color: "var(--ink)",
            a: data.nifty[ra],
            b: rb === null ? null : data.nifty[rb],
            price: true,
            picked: false,
          },
          ...PV_PARTICIPANTS.map((p) => ({
            key: p,
            color: PV_COLORS[p],
            a: series[p][ra],
            b: rb === null ? null : series[p][rb],
            price: false,
            picked: p === selP,
          })),
        ];
        const cell = (v: number | null | undefined, price: boolean) =>
          v === null || v === undefined || !Number.isFinite(v)
            ? "—"
            : price
              ? (v as number).toLocaleString("en-IN")
              : fmtCompact(v);

        return (
          <div
            className="mt-3 rounded-lg overflow-hidden"
            style={{ border: `1px solid ${PV_COLORS[selP]}55`, background: "var(--surface-inset)", fontFamily: "'DM Mono', monospace" }}
          >
            <div
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <span className="inline-flex items-center gap-2 text-[11px]" style={{ color: "var(--ink)" }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: PV_COLORS[selP], display: "inline-block" }} />
                <b>{selP}</b>
                <span style={{ color: "var(--ink-muted)" }}>
                  {pending
                    ? "· click a second point to measure"
                    : `· ${sessions} session${sessions === 1 ? "" : "s"} apart · click the chart to dismiss`}
                </span>
              </span>
              <button
                onClick={() => setSelection(null)}
                className="rounded-md border border-border px-2 py-0.5 text-[10px]"
                style={{ color: "var(--ink-muted)", background: "var(--surface-card)" }}
              >
                Clear (Esc)
              </button>
            </div>

            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: "var(--ink-muted)" }}>
                  <th className="text-left font-normal px-3 py-1.5"> </th>
                  <th className="text-right font-normal px-3 py-1.5 whitespace-nowrap">
                    {data.dateDisplay?.[ra] ?? fmtDateDMY(data.dates[ra])}
                  </th>
                  <th className="text-right font-normal px-3 py-1.5 whitespace-nowrap">
                    {rb === null ? "—" : (data.dateDisplay?.[rb] ?? fmtDateDMY(data.dates[rb]))}
                  </th>
                  {/* In a Δ view the series IS the daily change, so B−A is the
                      change in the daily change — NOT what the position did
                      across the span (that is the sum of the days between).
                      Label it literally there rather than let one column mean
                      two different things depending on the metric pill. */}
                  <th className="text-right font-normal px-3 py-1.5">{isDelta ? "B − A" : "Δ"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = r.a !== null && r.a !== undefined && r.b !== null && r.b !== undefined ? r.b - r.a : null;
                  return (
                    <tr
                      key={r.key}
                      style={{
                        borderTop: "1px solid var(--border)",
                        background: r.picked ? `${PV_COLORS[selP]}18` : "transparent",
                      }}
                    >
                      <td className="px-3 py-1.5" style={{ color: "var(--ink-muted)" }}>
                        <span className="inline-flex items-center gap-1.5">
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block" }} />
                          {r.key}
                        </span>
                      </td>
                      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{cell(r.a, r.price)}</td>
                      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{cell(r.b, r.price)}</td>
                      <td
                        className="text-right px-3 py-1.5 whitespace-nowrap"
                        style={{ color: d === null || d === 0 ? "var(--ink-muted)" : d > 0 ? "var(--ink-bull)" : "var(--ink-bear)" }}
                      >
                        {signedCompact(d)}
                        {/* No percentage off a Δ base — (Δb−Δa)/|Δa| routinely
                            reads in the hundreds of percent and means nothing.
                            NIFTY is always a level, so it keeps its %. */}
                        {(!isDelta || r.price) && (
                          <span style={{ color: "var(--ink-muted)" }}>{pctText(pctMove(r.a, r.b))}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {anchorsOffscreen && (
              <p className="px-3 py-1.5 text-[10px]" style={{ color: "var(--ink-muted)", borderTop: "1px solid var(--border)" }}>
                One anchor sits outside the visible range — the numbers still hold; widen the range to see the band.
              </p>
            )}
          </div>
        );
      })()}

      {/* ── tooltip ── */}
      {active !== null && activeOrig !== null && (
        <div
          className="pointer-events-none absolute rounded-lg px-3 py-2.5 text-[11px]"
          style={{
            left: Math.min(Math.max(xOf(active) + 14, 8), Math.max(8, width - 210)),
            top: mainTop - 6,
            width: 196,
            background: "var(--surface-card)",
            border: "1px solid var(--border)",
            boxShadow: "0 6px 24px rgba(0,0,0,0.28)",
            fontFamily: "'DM Mono', monospace",
          }}
        >
          <div style={{ color: "var(--ink)", fontWeight: 600, marginBottom: 5 }}>
            {data.dateDisplay?.[activeOrig] ?? fmtDateDMY(data.dates[activeOrig])}
          </div>
          <div className="flex items-center justify-between" style={{ color: "var(--ink-muted)", marginBottom: 4 }}>
            <span>NIFTY 50</span>
            <span style={{ color: "var(--ink)" }}>
              {data.nifty[activeOrig] === null ? "—" : (data.nifty[activeOrig] as number).toLocaleString("en-IN")}
            </span>
          </div>
          {PV_PARTICIPANTS.map((p) => (
            <div key={p} className="flex items-center justify-between gap-2" style={{ marginTop: 2 }}>
              <span className="inline-flex items-center gap-1.5 truncate" style={{ color: "var(--ink-muted)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: PV_COLORS[p], flex: "0 0 auto" }} />
                <span className="truncate">{p}</span>
              </span>
              <span style={{ color: "var(--ink)" }}>{fmtCompact(series[p][activeOrig])}</span>
            </div>
          ))}
        </div>
      )}

      {/* Honest footnote — never silently hide that points were dropped. */}
      {decimated && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--ink-muted)", fontFamily: "'DM Mono', monospace" }}>
          {view.pointCount.toLocaleString()} sessions thinned to {idx.length.toLocaleString()} plotted points · Δ views are never thinned
        </p>
      )}
      {isDelta && view.pointCount > DECIMATE_ABOVE && (
        <p className="mt-1 text-[10px]" style={{ color: "var(--ink-muted)", fontFamily: "'DM Mono', monospace" }}>
          {view.pointCount.toLocaleString()} sessions · every point drawn
        </p>
      )}
    </div>
  );
}
