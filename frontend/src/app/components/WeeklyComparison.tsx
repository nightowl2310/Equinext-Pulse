// ─────────────────────────────────────────────────────────────────────────────
// Weekday-over-weekday positioning comparison.
//
// Three charts, deliberately:
//   1. THEN vs NOW      — the comparison stated literally, not by implication.
//   2. HISTORY          — stacked-around-zero for Net (the four sum to zero, so
//                         they stack into one bar and you watch the long side
//                         change hands); grouped bars for Δ, because a Δ is a
//                         discrete event and bars beat lines for those.
//   3. NIFTY            — the same dates' price. Without it you cannot tell
//                         whether a build-up was into strength or weakness,
//                         which was the old section's biggest gap.
//
// The Net/Δ selector drives the CHARTS ONLY. The table shows both at once —
// that is the one thing a table does better than a chart, and it means the
// section never has to be read twice.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { PV_COLORS, ordinal, type ParticipantSeries, type ParticipantsData } from "../lib/series";
import {
  type Weekday,
  type WeeklyMode,
  type WeeklyRow,
  WC_HISTORY,
  WC_INSTRUMENTS,
  WC_MODES,
  WC_ORDER,
  WEEKDAYS,
  buildWeeklyRows,
  latestWeekday,
  movePercentile,
  occurrencesOf,
  signStreak,
  stateDiff,
  wcCompact,
  wcShortDate,
  wcSigned,
} from "../lib/weekly";

const INK = "var(--ink)";
const MUTED = "var(--ink-muted)";
const GRID = "var(--grid)";
const TEAL = "#0EA5A4";
const GREEN = "var(--ink-bull)";
const RED = "var(--ink-bear)";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = () => setW(el.clientWidth);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function pills<T extends string>(
  opts: readonly { key: T; label: string }[],
  active: T,
  onPick: (k: T) => void,
) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5" style={{ background: "var(--surface-inset)" }}>
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onPick(o.key)}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
          style={{
            background: active === o.key ? "var(--surface-raised)" : "transparent",
            color: active === o.key ? INK : MUTED,
            boxShadow: active === o.key ? "var(--pill-shadow)" : "none",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const card: React.CSSProperties = { background: "var(--surface-card)" };
const mono = { fontFamily: "'DM Mono', monospace" } as const;

// ── 1 · THEN vs NOW ──────────────────────────────────────────────────────────
// Net mode draws two bars per participant (faded = previous date, solid = the
// chosen one). Δ mode draws ONE bar, because the Δ *is* the comparison — a
// second bar there would be the change in the change, which means nothing.
function ThenNow({ row, mode }: { row: WeeklyRow; mode: WeeklyMode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const rowH = 46;
  const labelW = 74;
  const h = WC_ORDER.length * rowH + 10;
  const cx = labelW + Math.max(1, w - labelW) / 2;
  const half = Math.max(20, (w - labelW) / 2 - 96);

  const vals = WC_ORDER.flatMap((p) =>
    mode === "net"
      ? [row.net[p], row.net[p] !== null && row.delta[p] !== null ? (row.net[p] as number) - (row.delta[p] as number) : null]
      : [row.delta[p]],
  ).filter((v): v is number => v !== null);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const len = (v: number) => (Math.abs(v) / maxAbs) * half;

  return (
    <div ref={ref} className="w-full">
      {w > 0 && (
        <svg width={w} height={h} style={{ display: "block" }}>
          <line x1={cx} x2={cx} y1={0} y2={h - 10} stroke={MUTED} strokeWidth={1} opacity={0.5} />
          {WC_ORDER.map((p, i) => {
            const y = i * rowH + 6;
            const bh = mode === "net" ? 13 : 22;
            const now = mode === "net" ? row.net[p] : row.delta[p];
            const then =
              mode === "net" && row.net[p] !== null && row.delta[p] !== null
                ? (row.net[p] as number) - (row.delta[p] as number)
                : null;
            const bar = (v: number, yy: number, op: number) => (
              <rect
                x={v >= 0 ? cx : cx - len(v)}
                y={yy}
                width={Math.max(1.5, len(v))}
                height={bh}
                fill={PV_COLORS[p]}
                opacity={op}
                rx={2}
              />
            );
            return (
              <g key={p}>
                <rect x={4} y={y + rowH / 2 - 15} width={9} height={9} rx={2} fill={PV_COLORS[p]} />
                <text x={labelW - 12} y={y + rowH / 2 - 8} fontSize={13} textAnchor="end" dominantBaseline="middle" fill={INK} style={{ fontWeight: 600 }}>
                  {p}
                </text>
                {mode === "net" && then !== null && bar(then, y, 0.4)}
                {now !== null && bar(now, mode === "net" ? y + bh + 3 : y + 4, 1)}
                {now !== null && (
                  <text
                    x={now >= 0 ? cx + len(now) + 8 : cx - len(now) - 8}
                    y={y + rowH / 2 - 8}
                    fontSize={13}
                    textAnchor={now >= 0 ? "start" : "end"}
                    dominantBaseline="middle"
                    fill={INK}
                    style={{ ...mono, fontWeight: 700 }}
                  >
                    {mode === "net" ? wcCompact(now) : wcSigned(now)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <p className="mt-1 text-[11px]" style={{ color: MUTED, ...mono }}>
        {mode === "net"
          ? `Faded = ${row.prevDisplay ?? "previous"} · solid = ${row.display}. Centre line is zero; right of it is net long.`
          : `Change from ${row.prevDisplay ?? "previous"} to ${row.display}. The four bars sum to zero — one desk's buying is another's selling.`}
      </p>
    </div>
  );
}

// ── 2 · HISTORY ──────────────────────────────────────────────────────────────
function History({ rows, mode, activeIdx, onPick }: {
  rows: WeeklyRow[];
  mode: WeeklyMode;
  activeIdx: number;
  onPick: (idx: number) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 260;
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 34;
  const plotL = padL;
  const plotW = Math.max(10, w - padL - padR);
  const plotT = padT;
  const plotB = height - padB;
  const N = rows.length;
  const slot = plotW / Math.max(1, N);
  const xMid = (k: number) => plotL + slot * (k + 0.5);

  // Net stacks around zero (the four sum to zero); Δ is grouped.
  let lo = 0;
  let hi = 0;
  for (const r of rows) {
    if (mode === "net") {
      let up = 0;
      let dn = 0;
      for (const p of WC_ORDER) {
        const v = r.net[p];
        if (v === null) continue;
        if (v > 0) up += v;
        else dn += v;
      }
      hi = Math.max(hi, up);
      lo = Math.min(lo, dn);
    } else {
      for (const p of WC_ORDER) {
        const v = r.delta[p];
        if (v === null) continue;
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
  }
  const pad = (hi - lo || 1) * 0.08;
  hi += pad;
  lo -= pad;
  const yOf = (v: number) => plotB - ((v - lo) / (hi - lo)) * (plotB - plotT);
  const y0 = yOf(0);
  // Ticks are anchored ON zero, not spread evenly across the domain. With an
  // asymmetric Δ range an evenly-spread set puts a "-5k" label right beside the
  // emphasised zero line, which reads as if the baseline were -5k.
  const ticks = (() => {
    const step = (hi - lo) / 4;
    const out: number[] = [];
    for (let v = 0; v <= hi; v += step) out.push(v);
    for (let v = -step; v >= lo; v -= step) out.push(v);
    return out;
  })();
  const barW = mode === "net" ? Math.min(38, slot * 0.62) : Math.max(2, (slot * 0.66) / WC_ORDER.length);

  return (
    <div ref={ref} className="w-full" style={{ position: "relative" }}>
      {w > 0 && (
        <svg
          width={w}
          height={height}
          style={{ display: "block", cursor: "pointer" }}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={plotL} x2={plotL + plotW} y1={yOf(t)} y2={yOf(t)} stroke={GRID} strokeWidth={0.7} opacity={0.7} />
              <text x={plotL - 8} y={yOf(t) + 3} fontSize={10} textAnchor="end" fill={MUTED} style={mono}>
                {wcCompact(Math.round(t))}
              </text>
            </g>
          ))}
          <line x1={plotL} x2={plotL + plotW} y1={y0} y2={y0} stroke={MUTED} strokeWidth={1} opacity={0.55} />

          {rows.map((r, k) => {
            const sel = r.idx === activeIdx;
            return (
              <g key={r.date} onMouseEnter={() => setHover(k)} onClick={() => onPick(r.idx)}>
                <rect x={plotL + slot * k} y={plotT} width={slot} height={plotB - plotT}
                      fill={sel ? INK : hover === k ? INK : "transparent"} opacity={sel ? 0.07 : hover === k ? 0.04 : 0} />
                {mode === "net"
                  ? (() => {
                      // stack positives up from zero, negatives down
                      let up = 0;
                      let dn = 0;
                      return WC_ORDER.map((p) => {
                        const v = r.net[p];
                        if (v === null) return null;
                        const y = v >= 0 ? yOf(up + v) : yOf(dn);
                        const hgt = Math.abs(yOf(v) - y0);
                        if (v >= 0) up += v;
                        else dn += v;
                        return (
                          <rect key={p} x={xMid(k) - barW / 2} y={y} width={barW} height={Math.max(0.8, hgt)}
                                fill={PV_COLORS[p]} opacity={0.92} />
                        );
                      });
                    })()
                  : WC_ORDER.map((p, pi) => {
                      const v = r.delta[p];
                      if (v === null) return null;
                      const x = xMid(k) - (barW * WC_ORDER.length) / 2 + pi * barW;
                      return (
                        <rect key={p} x={x} y={Math.min(yOf(v), y0)} width={Math.max(1.2, barW - 1)}
                              height={Math.max(0.8, Math.abs(yOf(v) - y0))} fill={PV_COLORS[p]} />
                      );
                    })}
                {(sel || k === 0 || k === N - 1 || k % Math.ceil(N / 6) === 0) && (
                  <text x={xMid(k)} y={plotB + 16} fontSize={10} textAnchor="middle"
                        fill={sel ? INK : MUTED} style={{ ...mono, fontWeight: sel ? 700 : 400 }}>
                    {wcShortDate(r.date)}
                  </text>
                )}
                {r.expiry && <circle cx={xMid(k)} cy={plotB + 25} r={2} fill={MUTED} opacity={0.8} />}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && rows[hover] && (
        <div className="pointer-events-none absolute rounded-lg px-2.5 py-2 text-[11px]"
             style={{ left: Math.min(Math.max(xMid(hover) - 70, 4), Math.max(4, w - 150)), top: 4, width: 142,
                      background: "var(--surface-card)", border: "1px solid var(--border)", boxShadow: "0 6px 24px rgba(0,0,0,0.28)", ...mono }}>
          <div style={{ color: INK, fontWeight: 600, marginBottom: 4 }}>{rows[hover].display}</div>
          {WC_ORDER.map((p) => (
            <div key={p} className="flex items-center justify-between" style={{ marginTop: 2 }}>
              <span className="inline-flex items-center gap-1.5" style={{ color: MUTED }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: PV_COLORS[p], display: "inline-block" }} />
                {p}
              </span>
              <span style={{ color: INK }}>
                {mode === "net" ? wcCompact(rows[hover].net[p]) : wcSigned(rows[hover].delta[p])}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1 text-[11px]" style={{ color: MUTED, ...mono }}>
        {mode === "net"
          ? "Stacked around zero — the four nets sum to zero, so the bar above the line is exactly the bar below it. Click a week to compare it."
          : "One bar per participant per week. The four sum to zero: this is a transfer, not four independent decisions. Click a week to compare it."}
        {"  ·  dot = expiry week"}
      </p>
    </div>
  );
}

// ── 3 · NIFTY on the same dates ──────────────────────────────────────────────
function PriceStrip({ rows, activeIdx }: { rows: WeeklyRow[]; activeIdx: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const height = 110;
  const padL = 52;
  const padR = 12;
  const plotL = padL;
  const plotW = Math.max(10, w - padL - padR);
  const plotT = 12;
  const plotB = height - 26;
  const N = rows.length;
  const slot = plotW / Math.max(1, N);
  const xMid = (k: number) => plotL + slot * (k + 0.5);
  const vals = rows.map((r) => r.nifty).filter((v): v is number => v !== null);
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  const pad = (hi - lo || 1) * 0.15;
  lo -= pad;
  hi += pad;
  const yOf = (v: number) => plotB - ((v - lo) / (hi - lo)) * (plotB - plotT);
  const pts = rows
    .map((r, k) => (r.nifty === null ? null : `${xMid(k)},${yOf(r.nifty)}`))
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className="w-full">
      {w > 0 && (
        <svg width={w} height={height} style={{ display: "block" }}>
          {[hi - pad, lo + pad].map((t, i) => (
            <g key={i}>
              <line x1={plotL} x2={plotL + plotW} y1={yOf(t)} y2={yOf(t)} stroke={GRID} strokeWidth={0.7} />
              <text x={plotL - 8} y={yOf(t) + 3} fontSize={10} textAnchor="end" fill={MUTED} style={mono}>
                {Math.round(t).toLocaleString("en-IN")}
              </text>
            </g>
          ))}
          <polyline points={pts} fill="none" stroke={TEAL} strokeWidth={1.8} strokeLinejoin="round" />
          {rows.map((r, k) =>
            r.nifty === null ? null : (
              <circle key={r.date} cx={xMid(k)} cy={yOf(r.nifty)} r={r.idx === activeIdx ? 4.5 : 2.6}
                      fill={TEAL} stroke="var(--surface-card)" strokeWidth={r.idx === activeIdx ? 1.6 : 1} />
            ),
          )}
        </svg>
      )}
    </div>
  );
}

// ── the section ──────────────────────────────────────────────────────────────
export default function WeeklyComparison() {
  const [data, setData] = useState<ParticipantsData | null>(null);
  const [failed, setFailed] = useState(false);
  // null = follow the data. Only a click pins it, so the view rolls forward on
  // its own as each session lands instead of being frozen on one weekday.
  const [weekdayPinned, setWeekdayPinned] = useState<Weekday | null>(null);
  const [instKey, setInstKey] = useState<keyof ParticipantSeries>("futures");
  const [mode, setMode] = useState<WeeklyMode>("net");
  const [anchor, setAnchor] = useState<number | null>(null);

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
        setData(d);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // The weekday actually in force: whatever was pinned, else the weekday of the
  // newest session in the file. Derived on every render rather than seeded into
  // state once, so it tracks the data as new sessions arrive.
  const following = weekdayPinned === null;
  const weekday: Weekday = weekdayPinned ?? (data ? latestWeekday(data) : "Tuesday");

  // Every occurrence of the weekday in force — the date picker's options, and the
  // reason "Tuesday" is now a choice rather than an assumption.
  const occ = useMemo(() => (data ? occurrencesOf(data, weekday) : []), [data, weekday]);

  // Changing weekday invalidates the anchor (it indexes a different day), so it
  // is reset here rather than in an effect — no render ever runs with a mismatch.
  const pickWeekday = (d: Weekday) => {
    setWeekdayPinned(d);
    setAnchor(null);
  };

  const activeIdx = anchor !== null && occ.includes(anchor) ? anchor : (occ[occ.length - 1] ?? -1);

  const rows = useMemo(
    () => (data && activeIdx >= 0 ? buildWeeklyRows(data, weekday, instKey, activeIdx, WC_HISTORY) : []),
    [data, weekday, instKey, activeIdx],
  );
  const row = rows.length ? rows[rows.length - 1] : null;
  const inst = WC_INSTRUMENTS.find((i) => i.key === instKey) ?? WC_INSTRUMENTS[0];

  const diff = useMemo(
    () => (data && row ? stateDiff(data, weekday, instKey, row) : null),
    [data, weekday, instKey, row],
  );

  const moverPct = useMemo(() => {
    if (!data || !row || !row.mover) return null;
    const d = row.delta[row.mover];
    return d === null ? null : movePercentile(data, weekday, instKey, row.mover, d);
  }, [data, row, weekday, instKey]);

  const moverStreak = useMemo(
    () => (data && row && row.mover ? signStreak(data, weekday, instKey, row.mover, row.idx) : null),
    [data, row, weekday, instKey],
  );

  if (failed)
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ ...card, color: MUTED }}>
        Chart data unavailable — generate it with{" "}
        <code style={mono}>python plot_fii_vs_nifty.py</code>.
      </div>
    );
  if (!data || !row)
    return (
      <div className="rounded-2xl border border-border px-7 py-8 text-sm" style={{ ...card, color: MUTED }}>
        Loading comparison…
      </div>
    );

  const niftyMove =
    row.nifty !== null && row.niftyPrev !== null ? (row.nifty / row.niftyPrev - 1) * 100 : null;

  const tiles: { label: string; value: string; color?: string; sub: string }[] = [
    {
      label: "Biggest mover",
      value: row.mover ?? "—",
      color: row.mover ? PV_COLORS[row.mover] : MUTED,
      sub: row.mover ? `${wcSigned(row.delta[row.mover])} ${inst.short}` : "no change recorded",
    },
    {
      label: "NIFTY over the gap",
      value: niftyMove === null ? "—" : `${niftyMove > 0 ? "+" : "−"}${Math.abs(niftyMove).toFixed(2)}%`,
      color: niftyMove === null ? MUTED : niftyMove > 0 ? GREEN : RED,
      sub: row.sessionGap === null ? "—" : `${row.sessionGap} sessions apart`,
    },
    {
      label: "How unusual",
      value: moverPct === null ? "—" : ordinal(moverPct),
      sub: moverPct === null ? "too little history" : "percentile of its own weekly moves",
    },
    {
      label: "Persistence",
      value: moverStreak ? `${moverStreak.weeks}w` : "—",
      sub: moverStreak
        ? `${row.mover} net ${moverStreak.sign > 0 ? "long" : "short"} that long`
        : "no run",
    },
  ];

  return (
    <div className="space-y-5">
      {/* heading */}
      <div>
        <p className="text-[20px] uppercase tracking-widest font-medium" style={{ color: MUTED }}>
          {weekday}-over-{weekday} · {inst.label}
        </p>
        <p className="text-2xl md:text-3xl leading-snug font-semibold" style={{ fontFamily: "'Playfair Display', serif", color: INK }}>
          <em>What changed between two sessions — and what didn&apos;t</em>
        </p>
        <p className="mt-2 text-sm" style={{ color: MUTED, maxWidth: 680 }}>
          {row.display} against {row.prevDisplay ?? "—"}, the previous {weekday} with data.
          Net is the standing position; Δ is the move between the two.{" "}
          {following
            ? `Following the newest session in the file (${data.dateDisplay[data.dates.length - 1]}), so this rolls forward on its own.`
            : `Pinned to ${weekday}s.`}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {pills(WC_INSTRUMENTS.map((i) => ({ key: i.key as string, label: i.label })), instKey as string,
                 (k) => setInstKey(k as keyof ParticipantSeries))}
          {pills(WC_MODES, mode, setMode)}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {pills(WEEKDAYS.map((d) => ({ key: d, label: d.slice(0, 3) })), weekday, pickWeekday)}
          {!following && (
            <button
              onClick={() => {
                setWeekdayPinned(null);
                setAnchor(null);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
              style={{ color: INK, background: "var(--surface-inset)" }}
            >
              ↺ Follow latest
            </button>
          )}
          <select
            value={activeIdx}
            onChange={(e) => setAnchor(Number(e.target.value))}
            className="text-sm rounded-lg border border-border px-3 py-1.5"
            style={{ ...mono, color: INK, background: "var(--surface-card)" }}
          >
            {[...occ].reverse().map((i) => (
              <option key={i} value={i}>
                {data.dateDisplay[i]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* summary — micro-stats over a state diff. No generated prose: every line
          below is a state fact, never a direction score. */}
      <div className="rounded-2xl border border-border overflow-hidden" style={card}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {tiles.map((t, i) => (
            <div key={t.label} className="px-5 py-4"
                 style={{ borderLeft: i === 0 ? undefined : "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
              <p className="text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>{t.label}</p>
              <p className="text-2xl font-semibold mt-1" style={{ ...mono, color: t.color ?? INK }}>{t.value}</p>
              <p className="text-[11px] mt-0.5" style={{ color: MUTED }}>{t.sub}</p>
            </div>
          ))}
        </div>
        {diff && (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {([["What changed", diff.changed], ["What stayed the same", diff.same]] as const).map(([title, list], ci) => (
              <div key={title} className="px-5 py-4" style={{ borderLeft: ci === 0 ? undefined : "1px solid var(--border)" }}>
                <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: MUTED }}>{title}</p>
                {list.length === 0 ? (
                  <p className="text-xs" style={{ color: MUTED, ...mono }}>—</p>
                ) : (
                  list.map((e) => (
                    <p key={e.participant} className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)", ...mono }}>
                      <span style={{ color: PV_COLORS[e.participant], fontWeight: 700 }}>{e.participant}</span> {e.text}
                    </p>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 1 · then vs now */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={card}>
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          1 · {row.prevDisplay ?? "previous"} → {row.display} · {mode === "net" ? "net position" : "one-week change"}
        </p>
        <ThenNow row={row} mode={mode} />
      </div>

      {/* 2 · history */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={card}>
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          2 · last {rows.length} {weekday}s · {mode === "net" ? "net position, stacked" : "one-week change"}
        </p>
        <History rows={rows} mode={mode} activeIdx={activeIdx} onPick={(i) => setAnchor(i)} />
      </div>

      {/* 3 · price */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={card}>
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          3 · NIFTY 50 close on those same {weekday}s
        </p>
        <PriceStrip rows={rows} activeIdx={activeIdx} />
        <p className="mt-1 text-[11px]" style={{ color: MUTED, ...mono }}>
          Positioning without price cannot tell you whether a build-up was into strength or into weakness.
        </p>
      </div>

      {/* table — BOTH modes at once, which is the thing a table does better */}
      <div className="rounded-2xl border border-border p-5 md:p-6" style={card}>
        <p className="text-xs uppercase tracking-widest mb-3" style={{ color: MUTED }}>
          The numbers · net and Δ together
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[760px]" style={mono}>
            <thead>
              <tr style={{ color: MUTED }}>
                <th className="text-left font-normal px-3 py-2">{weekday}</th>
                {WC_ORDER.map((p) => (
                  <th key={p} className="text-right font-normal px-3 py-2" colSpan={2}>
                    <span className="inline-flex items-center gap-1.5">
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: PV_COLORS[p], display: "inline-block" }} />
                      {p}
                    </span>
                  </th>
                ))}
                <th className="text-left font-normal px-3 py-2">Biggest mover</th>
                <th className="text-right font-normal px-3 py-2">Gap</th>
              </tr>
              <tr style={{ color: MUTED }}>
                <th />
                {WC_ORDER.map((p) => [
                  <th key={p + "n"} className="text-right font-normal px-3 pb-2 text-[10px]">net</th>,
                  <th key={p + "d"} className="text-right font-normal px-3 pb-2 text-[10px]">Δ</th>,
                ])}
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.date} className="border-t border-border"
                    style={{ background: r.idx === activeIdx ? "var(--surface-inset)" : undefined, cursor: "pointer" }}
                    onClick={() => setAnchor(r.idx)}>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: INK, fontWeight: r.idx === activeIdx ? 700 : 400 }}>
                    {r.display}
                    {r.expiry && <span style={{ color: MUTED }}> · exp</span>}
                  </td>
                  {WC_ORDER.map((p) => [
                    <td key={p + "n"} className="text-right px-3 py-2" style={{ color: INK }}>{wcCompact(r.net[p])}</td>,
                    <td key={p + "d"} className="text-right px-3 py-2"
                        style={{ color: r.delta[p] === null || r.delta[p] === 0 ? MUTED : (r.delta[p] as number) > 0 ? GREEN : RED }}>
                      {wcSigned(r.delta[p])}
                    </td>,
                  ])}
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.mover ? PV_COLORS[r.mover] : MUTED, fontWeight: 600 }}>
                    {r.mover ?? "—"}
                  </td>
                  <td className="text-right px-3 py-2" style={{ color: MUTED }}>
                    {r.sessionGap === null ? "—" : `${r.sessionGap}s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] mt-3 pt-3 border-t border-border leading-relaxed" style={{ color: MUTED }}>
          &ldquo;Biggest mover&rdquo; is simply the largest one-week change — descriptive, not a call.
          &ldquo;Gap&rdquo; is the real number of trading sessions between the two dates, so a holiday-shortened
          or skipped week is visible rather than shown as an ordinary one.
          The old <em>Market Bias</em> column has been removed: it read direction off the FII Δ, and that
          hypothesis scores <b>2 of 5</b> in this project&apos;s own validation harness. Nothing here forecasts
          price — the four books sum to zero, so this is a map of who holds what, not a signal.
        </p>
      </div>
    </div>
  );
}
