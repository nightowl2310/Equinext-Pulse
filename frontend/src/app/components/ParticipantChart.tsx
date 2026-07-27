import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BookMode,
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

/**
 * NIFTY price strip above one selector-driven participant panel.
 *
 * Pure render: `hover` is lifted to the parent so the inline card and the
 * full-screen overlay stay in lockstep. `hover` is a position within the
 * DISPLAYED points, not a raw data index — resolve through `view.idx`.
 */
export function ParticipantChart({
  data,
  mode,
  metric,
  range,
  render,
  hover,
  setHover,
  tall,
}: {
  data: ParticipantsData;
  mode: BookMode;
  metric: MetricKey;
  range: RangeKey;
  render: RenderMode;
  hover: number | null;
  setHover: (i: number | null) => void;
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
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (idx.length <= 1) return setHover(0);
    const k = Math.round(((x - PAD_L) / plotW) * (idx.length - 1));
    setHover(Math.max(0, Math.min(idx.length - 1, k)));
  };

  const active = hover !== null && hover >= 0 && hover < idx.length ? hover : null;
  const activeOrig = active !== null ? idx[active] : null;

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
        style={{ display: "block", cursor: "crosshair" }}
      >
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
              return (
                <g key={p}>
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
                  return <rect key={p} x={x} y={y} width={barW} height={Math.max(0.6, h)} fill={PV_COLORS[p]} />;
                })}
              </g>
            ))}

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
