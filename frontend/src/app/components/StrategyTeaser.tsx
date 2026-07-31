// ─────────────────────────────────────────────────────────────────────────────
// StrategyTeaser — the compact form of a strategy, for the Participant page.
//
// The full panel lives on its own Strategies page. This is the doorway: enough
// to answer "is anything happening?" without any of the explanation, because a
// reader on the participant page came for the chart, not for a strategy essay.
//
// WHAT IT DELIBERATELY OMITS: the mechanism, the three steps, the KPI grid, the
// signal history and the validation discussion. All of those are the reason the
// full page exists. Duplicating a subset of them here would make the two views
// compete rather than nest.
//
// It recomputes the state itself rather than receiving it, so the teaser can
// never drift from the page it links to — same function, same defaults.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from "react";
import {
  ACTIVATION_DEFAULT,
  MACHINE_HOLD,
  MACHINE_WINDOWS,
  MACHINE_WINDOW_DEFAULT,
  PV_COLORS,
  runPeakReversal,
  type MachineState,
  type ParticipantsData,
} from "../lib/series";

const MONO = "'DM Mono', monospace";
const SANS = "'DM Sans', sans-serif";
const ACCENT = PV_COLORS.FII;

const STATE: Record<MachineState, { label: string; icon: string; dot: string; tint: string; line: string }> = {
  fired: { label: "Signal", icon: "▲", dot: "var(--status-good)", tint: "var(--status-good-tint)",
    line: "FII shorts are being covered — the strategy is signalling a long." },
  armed: { label: "Stalling", icon: "◆", dot: "var(--status-warning)", tint: "var(--status-warning-tint)",
    line: "FII shorts have stopped growing. Watching for the reversal to confirm." },
  active: { label: "Building", icon: "▼", dot: "var(--status-info)", tint: "var(--status-info-tint)",
    line: "FII shorts are still growing near their peak. Not a buy yet." },
  idle: { label: "Idle", icon: "•", dot: "var(--ink-muted)", tint: "var(--tint-flat)",
    line: "FII shorts are well below their peak. No setup forming." },
};

export default function StrategyTeaser({
  data, onOpen,
}: {
  data: ParticipantsData;
  onOpen: () => void;
}) {
  const book = data.participants?.FII?.futuresShort;
  const wcfg = MACHINE_WINDOWS.find((w) => w.key === MACHINE_WINDOW_DEFAULT)!;

  const r = useMemo(
    () => (book ? runPeakReversal(data.dates, data.nifty, book, wcfg.sessions, ACTIVATION_DEFAULT / 100) : null),
    [book, data.dates, data.nifty, wcfg.sessions],
  );
  if (!book || !r) return null;

  const st = STATE[r.state];
  // progress toward the thing this stage waits for — the one number worth showing
  const progress =
    r.state === "fired" ? 100
      : r.state === "armed"
        ? Math.max(0, Math.min(100, ((r.runPeak - (r.shortBook ?? 0)) / Math.max(1, r.runPeak - r.fireLevel)) * 100))
        : Math.max(0, Math.min(100, ((r.shortBook ?? 0) / Math.max(1, r.activateLevel)) * 100));

  return (
    <div
      className="rounded-2xl border overflow-hidden mb-6"
      style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}
      aria-label="Peak Reversal strategy summary"
    >
      <div className="px-5 md:px-6 py-4 flex flex-wrap items-center gap-x-6 gap-y-4">
        {/* identity */}
        <div className="min-w-[210px] flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span aria-hidden className="rounded-full" style={{ width: 7, height: 7, background: ACCENT }} />
            <span className="text-[10px] uppercase tracking-[0.2em] font-medium" style={{ color: ACCENT }}>
              Strategy · FII Index Futures
            </span>
          </div>
          <p className="text-xl font-bold leading-tight" style={{ fontFamily: SANS, color: ACCENT, letterSpacing: "-0.01em" }}>
            Peak Reversal
          </p>
          <p className="text-[12px] leading-snug mt-1" style={{ color: "var(--ink-soft)", maxWidth: 340 }}>
            {st.line}
          </p>
        </div>

        {/* live state */}
        <div className="min-w-[168px]">
          <p className="text-[9px] uppercase tracking-widest mb-1.5" style={{ color: "var(--ink-muted)" }}>
            Current status
          </p>
          <div className="flex items-center gap-2 mb-2">
            <span aria-hidden className="rounded-full shrink-0" style={{ width: 10, height: 10, background: st.dot }} />
            <span className="text-lg font-semibold leading-none" style={{ fontFamily: SANS, color: "var(--ink)" }}>
              {st.label}
            </span>
            <span className="text-[11px]" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
              {progress.toFixed(0)}%
            </span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 5, background: "var(--surface-inset)" }}>
            <div className="h-full rounded-full" style={{ width: `${progress}%`, background: st.dot }} />
          </div>
        </div>

        {/* one headline number, labelled so it cannot be misread */}
        <div className="min-w-[150px]">
          <p className="text-[9px] uppercase tracking-widest mb-1" style={{ color: "var(--ink-muted)" }}>
            Typical return after a signal
          </p>
          <p className="text-lg font-semibold leading-none" style={{ fontFamily: SANS, color: "var(--ink)" }}>
            {r.medianForward == null ? "—" : `${r.medianForward > 0 ? "+" : ""}${r.medianForward.toFixed(2)}%`}
          </p>
          <p className="text-[10px] mt-1" style={{ color: "var(--ink-muted)" }}>
            over {MACHINE_HOLD} sessions · {r.events.length} signals · {wcfg.label} window
          </p>
        </div>

        {/* the doorway */}
        <button
          onClick={onOpen}
          className="shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
          style={{ background: ACCENT, color: "#fff" }}
        >
          View strategy
          <span aria-hidden>→</span>
        </button>
      </div>

      <div className="px-5 md:px-6 py-2" style={{ background: "var(--surface-subtle)", borderTop: "1px solid var(--border)" }}>
        <p className="text-[10.5px]" style={{ color: "var(--ink-muted)" }}>
          Research strategy · not fully validated. Full method, history and caveats on the Strategies page.
        </p>
      </div>
    </div>
  );
}
