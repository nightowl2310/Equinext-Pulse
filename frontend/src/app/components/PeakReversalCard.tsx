// ─────────────────────────────────────────────────────────────────────────────
// PeakReversalCard — FII short-book peak reversal, as a strategy card.
//
// Lives in its own Strategies section, not inside the participant chart block:
// a signal is a different kind of object from a chart, and burying it under a
// chart's controls made it read as a caption.
//
// WHY THE NUMBERS ARE COMPUTED HERE AND NOT SERVED
// ------------------------------------------------
// The activation threshold is user-adjustable, so changing it has to re-run the
// state machine, not merely move a line. `runPeakReversal` in lib/series.ts is a
// port of signals.peak_reversal_machine; the Python side stays the reference the
// backtests use (research/experiments/phase5_machine.py) and the two agree on
// event count and dates at the 90% default.
//
// FORM
//  * The meter is scaled 0–100% OF THE PEAK, so a book at 63.9% of its peak sits
//    at 63.9% of the bar. The earlier version scaled from the activation level
//    upward, which put a distant reading hard against the left edge and read as
//    broken exactly when the signal was furthest away.
//  * Two markers, deliberately different objects: the CURRENT reading is a solid
//    filled bar ending in the FII accent, the THRESHOLD is a dashed rule. One is
//    a value, the other is a rule — they should not look like siblings.
//  * KPI tiles for the summary numbers. A single current value is the canonical
//    case where a stat tile beats a chart, and eight of them replace a paragraph
//    nobody finished reading.
//
// COLOUR
//  * FII purple is the card's accent throughout, matching the series colour the
//    same participant wears on every chart — identity must not shift between
//    views.
//  * Status hues stay reserved, appear only as dots/tints/rules, and always
//    carry an icon and a label.
//  * Forward returns are polarity → the existing --ink-bull/--ink-bear pair.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVATION_CHOICES,
  ACTIVATION_DEFAULT,
  MACHINE_HOLD,
  MACHINE_WINDOWS,
  PV_COLORS,
  runPeakReversal,
  type MachineState,
  type ParticipantsData,
} from "../lib/series";

const MONO = "'DM Mono', monospace";
const SANS = "'DM Sans', sans-serif";
const ACCENT = PV_COLORS.FII;

const STATE: Record<MachineState, { label: string; icon: string; dot: string; tint: string; head: string; blurb: string }> = {
  fired: {
    label: "Fire", icon: "▲", dot: "var(--status-good)", tint: "var(--status-good-tint)",
    head: "Short book is being covered",
    blurb: "The crowded position is unwinding. This is the long signal.",
  },
  armed: {
    label: "Armed", icon: "◆", dot: "var(--status-warning)", tint: "var(--status-warning-tint)",
    head: "Build has stopped growing",
    blurb: "No new highs in the short book. Watching for the roll-over.",
  },
  active: {
    label: "Active", icon: "▼", dot: "var(--status-info)", tint: "var(--status-info-tint)",
    head: "Shorts still being added",
    blurb: "Near the peak but still climbing. Pressure is still building.",
  },
  idle: {
    label: "Idle", icon: "•", dot: "var(--ink-muted)", tint: "var(--tint-flat)",
    head: "Nothing to watch",
    blurb: "The short book is well below its peak.",
  },
};

const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
const px = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null | undefined, d = 1) => (n == null ? "—" : `${n.toFixed(d)}%`);

/** Non-clickable stat container. Accent is a rail + icon chip; the value itself
 *  always wears --ink so it stays legible in both themes. */
function Kpi({
  icon, label, value, sub, accent, tint,
}: {
  icon: string; label: string; value: string; sub?: string; accent: string; tint: string;
}) {
  return (
    <div
      className="relative rounded-xl border border-border overflow-hidden px-4 py-3"
      style={{ background: tint }}
    >
      <span aria-hidden className="absolute inset-y-0 left-0" style={{ width: 3, background: accent }} />
      <div className="flex items-center gap-2 mb-1.5">
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-md text-[11px]"
          style={{ width: 20, height: 20, background: accent, color: "#fff" }}
        >
          {icon}
        </span>
        <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
          {label}
        </span>
      </div>
      <div className="text-xl leading-none font-semibold" style={{ fontFamily: SANS, color: "var(--ink)" }}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] mt-1 leading-snug" style={{ color: "var(--ink-muted)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default function PeakReversalCard({ data }: { data: ParticipantsData }) {
  const [win, setWin] = useState("1Y");
  const [threshold, setThreshold] = useState(ACTIVATION_DEFAULT);
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const book = data.participants?.FII?.futuresShort;
  const sessions = MACHINE_WINDOWS.find((w) => w.key === win)?.sessions ?? 250;

  const r = useMemo(
    () => (book ? runPeakReversal(data.dates, data.nifty, book, sessions, threshold / 100) : null),
    [book, data.dates, data.nifty, sessions, threshold],
  );

  if (!book || !r) return null;

  const st = STATE[r.state];
  const rows = [...r.events].reverse().slice(0, 8);
  const custom = threshold !== ACTIVATION_DEFAULT;

  // meter geometry: 0–100% of the trailing peak
  const posPct = Math.max(0, Math.min(100, r.pctOfPeak ?? 0));
  const thrPct = threshold;
  const edge = r.medianForward != null && r.baselineMedian != null ? r.medianForward - r.baselineMedian : null;

  return (
    <article
      className="rounded-2xl border overflow-hidden"
      style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}
      aria-label="FII short-book peak reversal strategy"
    >
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="px-6 md:px-7 pt-6 pb-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span aria-hidden className="rounded-full" style={{ width: 9, height: 9, background: ACCENT }} />
              <span className="text-[11px] uppercase tracking-[0.2em] font-medium" style={{ color: ACCENT }}>
                FII · Index Futures
              </span>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <h3
                className="text-3xl md:text-[2.35rem] leading-tight font-bold"
                style={{ fontFamily: SANS, color: ACCENT, letterSpacing: "-0.02em" }}
              >
                Peak Reversal
              </h3>

              {/* threshold settings */}
              <div className="relative" ref={popRef}>
                <button
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  aria-label="Activation threshold settings"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    borderColor: custom ? ACCENT : "var(--border)",
                    background: custom ? "var(--surface-inset)" : "transparent",
                    color: "var(--ink-soft)",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M2 4.5h6M11 4.5h3M2 11.5h3M8 11.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="9.5" cy="4.5" r="1.9" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="6.5" cy="11.5" r="1.9" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span style={{ fontFamily: MONO }}>{threshold}%</span>
                </button>

                {open && (
                  <div
                    className="absolute z-30 mt-2 left-0 rounded-xl border shadow-lg p-3"
                    style={{ background: "var(--surface-card)", borderColor: "var(--border)", width: 268 }}
                  >
                    <p className="text-[10px] uppercase tracking-widest mb-2" style={{ color: "var(--ink-muted)" }}>
                      Activation threshold
                    </p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {ACTIVATION_CHOICES.map((v) => {
                        const on = v === threshold;
                        const rec = v === ACTIVATION_DEFAULT;
                        return (
                          <button
                            key={v}
                            onClick={() => { setThreshold(v); setOpen(false); }}
                            className="rounded-md py-1.5 text-xs font-medium transition-colors"
                            style={{
                              fontFamily: MONO,
                              background: on ? ACCENT : rec ? "var(--surface-inset)" : "transparent",
                              color: on ? "#fff" : "var(--ink)",
                              // the recommendation keeps a visible ring even when
                              // another value is selected
                              border: rec ? `1px solid ${on ? ACCENT : ACCENT}` : "1px solid var(--border)",
                            }}
                          >
                            {v}%
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10.5px] leading-relaxed mt-3 pt-3" style={{ color: "var(--ink-soft)", borderTop: "1px solid var(--border)" }}>
                      <strong style={{ color: ACCENT }}>Default recommendation: 90%.</strong>{" "}
                      Selected from our internal research. Any custom threshold is user-defined and its
                      performance is the user&rsquo;s responsibility.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
              style={{ background: "var(--surface-inset)", border: "1px solid var(--border)", color: "var(--ink-soft)", fontFamily: MONO }}
            >
              <span aria-hidden style={{ color: "var(--status-info)" }}>◇</span>
              Research strategy
            </span>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
              style={{ background: st.tint, border: `1px solid ${st.dot}`, color: "var(--ink)", fontFamily: MONO }}
            >
              <span aria-hidden style={{ color: st.dot }}>{st.icon}</span>
              {st.label}
            </span>
          </div>
        </div>

        {/* meaning + description */}
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {[
            {
              k: "Meaning",
              v: "Detects when the FII Short Book reverses significantly from its highest recorded level, indicating a potential market turning point.",
            },
            {
              k: "Description",
              v: `Tracks the highest FII Short Open Interest within the selected reference period. When it retraces to the configured activation level (default ${ACTIVATION_DEFAULT}%), a signal is generated and evaluated over the following ${MACHINE_HOLD} trading sessions.`,
            },
          ].map(({ k, v }) => (
            <div key={k} className="rounded-xl px-4 py-3" style={{ background: "var(--surface-subtle)", border: "1px solid var(--border)" }}>
              <p className="text-[10px] uppercase tracking-[0.18em] mb-1.5 font-semibold" style={{ color: ACCENT }}>
                {k}
              </p>
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {v}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── timeframe ──────────────────────────────────────────────────── */}
      <div className="px-6 md:px-7 pt-5 flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
          Reference period
        </span>
        <div className="inline-flex rounded-lg p-0.5" style={{ background: "var(--surface-inset)" }}>
          {MACHINE_WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{
                background: w.key === win ? "var(--surface-raised)" : "transparent",
                color: w.key === win ? "var(--ink)" : "var(--ink-muted)",
                boxShadow: w.key === win ? "var(--pill-shadow)" : undefined,
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── state + meter ──────────────────────────────────────────────── */}
      <div className="px-6 md:px-7 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xl font-semibold leading-tight" style={{ fontFamily: SANS, color: "var(--ink)" }}>
            {st.head}
          </h4>
          <span className="text-[11px]" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
            {fmt(r.shortBook)} short · peak {fmt(r.trailingPeak)}
          </span>
        </div>
        <p className="text-[12.5px] mb-4" style={{ color: "var(--ink-soft)" }}>{st.blurb}</p>

        {/* 0–100% of peak. Position is literal: 63.9% sits at 63.9% of the bar. */}
        <div className="relative pt-7 pb-6">
          {/* current reading — a VALUE: filled bar + solid caret */}
          <div
            className="absolute top-0 flex flex-col items-center"
            style={{ left: `min(max(${posPct}%, 34px), calc(100% - 34px))`, transform: "translateX(-50%)" }}
          >
            <span
              className="rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
              style={{ background: ACCENT, color: "#fff", fontFamily: MONO }}
            >
              {pct(r.pctOfPeak)}
            </span>
          </div>

          <div className="relative rounded-lg overflow-hidden" style={{ height: 40, background: "var(--surface-inset)" }}>
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: `${posPct}%`, background: `linear-gradient(90deg, ${ACCENT}22, ${ACCENT}55)` }}
            />
            <div className="absolute inset-y-0" style={{ left: `${posPct}%`, width: 3, background: ACCENT }} />
            {/* threshold — a RULE, not a value: dashed, neutral, no fill */}
            <div
              aria-hidden
              className="absolute inset-y-0"
              style={{
                left: `${thrPct}%`,
                width: 0,
                borderLeft: "2px dashed var(--status-good)",
              }}
            />
          </div>

          {/* Anchored to the SIDE of its own line rather than centred on it, so a
              threshold near either end cannot run off the track or collide with
              the scale labels below. */}
          <div
            className="absolute bottom-0 flex items-center gap-1.5"
            style={{
              left: `${thrPct}%`,
              transform: thrPct > 55 ? "translateX(-100%)" : "translateX(0)",
              paddingRight: thrPct > 55 ? 6 : 0,
              paddingLeft: thrPct > 55 ? 0 : 6,
            }}
          >
            <span aria-hidden style={{ color: "var(--status-good)", fontSize: 11, lineHeight: 1 }}>┆</span>
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
              activation {thrPct}%
            </span>
          </div>
        </div>

        <div className="flex justify-between text-[10px] -mt-2" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
          <span>0%</span>
          <span>100% of peak</span>
        </div>
      </div>

      {/* ── KPI tiles ──────────────────────────────────────────────────── */}
      <div className="px-6 md:px-7 pb-5 grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon="◈" label="Median 30-day return"
          value={r.medianForward == null ? "—" : `${r.medianForward > 0 ? "+" : ""}${r.medianForward.toFixed(2)}%`}
          sub={edge == null ? undefined : `${edge > 0 ? "+" : ""}${edge.toFixed(2)}% vs baseline`}
          accent={r.medianForward != null && r.medianForward > 0 ? "var(--ink-bull)" : "var(--ink-bear)"}
          tint={r.medianForward != null && r.medianForward > 0 ? "var(--tint-bull)" : "var(--tint-bear)"}
        />
        <Kpi
          icon="◉" label="Win rate"
          value={r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}
          sub={`${r.eventsUp} of ${r.eventsComplete} signals positive`}
          accent="var(--status-good)" tint="var(--status-good-tint)"
        />
        <Kpi
          icon="⧉" label="Total signals"
          value={String(r.events.length)}
          sub={`${r.eventsComplete} with a full ${MACHINE_HOLD}-session outcome`}
          accent={ACCENT} tint="var(--tint-flat)"
        />
        <Kpi
          icon={st.icon} label="Current state"
          value={st.label}
          sub={r.state === "armed" ? `fires at ${fmt(r.fireLevel)}` : r.state === "idle" ? `activates at ${fmt(r.activateLevel)}` : undefined}
          accent={st.dot} tint={st.tint}
        />
        <Kpi
          icon="◷" label="Reference window"
          value={MACHINE_WINDOWS.find((w) => w.key === win)?.label ?? win}
          sub={sessions > 10000 ? "entire history to date" : `${sessions} trading sessions`}
          accent="var(--status-info)" tint="var(--status-info-tint)"
        />
        <Kpi
          icon="≈" label="Baseline median return"
          value={r.baselineMedian == null ? "—" : `${r.baselineMedian > 0 ? "+" : ""}${r.baselineMedian.toFixed(2)}%`}
          sub="unconditional, same horizon"
          accent="var(--ink-muted)" tint="var(--tint-flat)"
        />
        <Kpi
          icon="◇" label="Validation status"
          value={custom ? "User-defined" : "Under evaluation"}
          sub={custom ? "outside the researched default" : "not yet through the attack suite"}
          accent={custom ? "var(--status-warning)" : "var(--status-info)"}
          tint={custom ? "var(--status-warning-tint)" : "var(--status-info-tint)"}
        />
        <Kpi
          icon="⏱" label="Holding period"
          value={`${MACHINE_HOLD} sessions`}
          sub="entry on the fire, exit at horizon"
          accent={ACCENT} tint="var(--tint-flat)"
        />
      </div>

      {/* ── signal history ─────────────────────────────────────────────── */}
      <div className="px-6 md:px-7 pb-6">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
            Signal history
          </span>
          <span className="text-[10px]" style={{ color: "var(--ink-muted)" }}>
            most recent {rows.length} of {r.events.length}
          </span>
        </div>
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-[11.5px] border-collapse">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider" style={{ background: "var(--surface-subtle)", color: "var(--ink-muted)" }}>
                <th className="text-left font-normal px-3 py-2">Fired</th>
                <th className="text-right font-normal px-3 py-2">Peak</th>
                <th className="text-right font-normal px-3 py-2">Off peak</th>
                <th className="text-right font-normal px-3 py-2">NIFTY</th>
                <th className="text-right font-normal px-3 py-2">+{MACHINE_HOLD}d</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const up = (e.forwardPct ?? 0) > 0;
                const ink = e.forwardPct == null ? "var(--ink-muted)" : up ? "var(--ink-bull)" : "var(--ink-bear)";
                return (
                  <tr key={e.date} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: "var(--ink)", fontFamily: MONO }}>{e.date}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>{fmt(e.peak)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>{e.offPeakPct}%</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>{px(e.niftyAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium" style={{ color: ink, fontFamily: MONO }}>
                      {e.forwardPct == null ? "—" : `${up ? "▲" : "▼"} ${e.forwardPct > 0 ? "+" : ""}${e.forwardPct.toFixed(2)}%`}
                      {!e.complete && <span className="ml-1 text-[9px]" style={{ color: "var(--ink-muted)" }}>partial</span>}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-[11px]" style={{ color: "var(--ink-muted)" }}>
                    No signals at this threshold and reference period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </article>
  );
}
