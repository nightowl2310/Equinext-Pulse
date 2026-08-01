// ─────────────────────────────────────────────────────────────────────────────
// PeakReversalCard — short-book peak reversal, as a self-explaining panel.
//
// Runs against any one participant's gross short index-futures book, selected in
// the header. FII is the default and the strongest fit; the recommended windows,
// the accent colour and every caution follow the selection (see
// MACHINE_RECOMMENDED in lib/series.ts — the strategy does NOT hold for Client).
//
// ORDERED TO ANSWER SEVEN QUESTIONS, top to bottom. The vertical order IS the UX:
//   1 what is this?            header + lead sentence
//   2 what is it watching?     named in that same sentence
//   3 why does it exist?       the plain-language claim
//   4 how does it signal?      three steps
//   5 what is happening now?   the STATUS HERO — the answer people came for
//   6 what should I do?        an explicit action panel, per stage
//   7 should I trust it?       collapsed by default; expandable
//
// WRITING RULE OBSERVED THROUGHOUT: every number says what it is a number OF.
// "Median 30-day return" leaves the reader asking "return of what?" — so it is
// "Typical return after a signal", and the tooltip names the measurement. Any
// label a first-time reader could misread is a bug, not a style preference.
//
// NUMBERS ARE COMPUTED HERE, NOT SERVED, because the activation threshold is
// user-adjustable and changing it must re-run the machine rather than move a
// line. `runPeakReversal` in lib/series.ts is a port of
// signals.peak_reversal_machine; the two agree on event count and dates at the
// 90% default (research/experiments/phase5_machine.py).
//
// COLOUR: FII purple is the card's accent throughout, matching the series colour
// the same participant wears on every chart. Status hues stay reserved, appear
// only as dots/rails/tints, and always carry an icon and a label. Outcomes are
// polarity → the existing --ink-bull/--ink-bear pair.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVATION_CHOICES,
  ACTIVATION_DEFAULT,
  MACHINE_HOLD,
  MACHINE_WINDOWS,
  PV_COLORS,
  PV_ROLE,
  recommendedFor,
  runPeakReversal,
  STRATEGY_PARTICIPANTS,
  STRATEGY_PARTICIPANT_DEFAULT,
  type MachineResult,
  type MachineState,
  type ParticipantsData,
} from "../lib/series";

const MONO = "'DM Mono', monospace";
const SANS = "'DM Sans', sans-serif";

const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
const px = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number | null | undefined, d = 2) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;

/** Info affordance. A visible ⓘ, because a dotted underline alone does not tell
 *  anyone there is something to hover. */
function Info({ tip }: { tip: string }) {
  return (
    <span
      title={tip}
      role="img"
      aria-label={tip}
      className="inline-flex items-center justify-center rounded-full cursor-help align-middle ml-1 shrink-0"
      style={{
        width: 12, height: 12, fontSize: 8.5, lineHeight: 1,
        border: "1px solid var(--ink-muted)", color: "var(--ink-muted)",
        fontFamily: SANS, fontStyle: "italic", fontWeight: 700,
      }}
    >
      i
    </span>
  );
}

// ─── the four stages ─────────────────────────────────────────────────────────
const STAGES: {
  key: MachineState; label: string; icon: string; dot: string; tint: string; sub: string; what: string;
}[] = [
  { key: "idle", label: "Idle", icon: "•", dot: "var(--ink-muted)", tint: "var(--tint-flat)",
    sub: "No setup forming",
    what: "Shorts are nowhere near their peak. Nothing to track yet." },
  { key: "active", label: "Building", icon: "▼", dot: "var(--status-info)", tint: "var(--status-info-tint)",
    sub: "Shorts still growing",
    what: "Shorts are piling up near the peak. Pressure is still rising — this is not a buy." },
  { key: "armed", label: "Stalling", icon: "◆", dot: "var(--status-warning)", tint: "var(--status-warning-tint)",
    sub: "Build has topped out",
    what: "The build has stopped making new highs. A reversal may be starting." },
  { key: "fired", label: "Signal", icon: "▲", dot: "var(--status-good)", tint: "var(--status-good-tint)",
    sub: "Shorts being covered",
    what: "Shorts are being bought back. The strategy reads this as bearish exhaustion." },
];
const stageIndex = (s: MachineState) => STAGES.findIndex((x) => x.key === s);

/** State-dependent narration, plus a progress figure that means something
 *  different in each stage — and says so rather than showing a bare percent. */
function narrate(r: MachineResult, threshold: number, winLabel: string, who: string) {
  const book = r.shortBook ?? 0;
  switch (r.state) {
    case "fired":
      return {
        progress: 100, progressLabel: "signal confirmed",
        verdict: "Go long NIFTY index futures",
        verdictSub: `Hold ${MACHINE_HOLD} sessions · enter at the next session's open`,
        why: `${who} shorts peaked at ${fmt(r.runPeak)} contracts and have fallen to ${fmt(book)} — past the ${threshold}% mark. The institutions pressing the market lower are buying back.`,
        waiting: null,
        action: "Open interest publishes after the close, so today's price cannot be acted on — the historical basis enters at the next open.",
        actionTone: "good" as const,
      };
    case "armed": {
      const span = Math.max(1, r.runPeak - r.fireLevel);
      return {
        progress: Math.max(0, Math.min(100, ((r.runPeak - book) / span) * 100)),
        progressLabel: "of the way to a signal",
        verdict: "No action",
        verdictSub: "The build has stalled but has not reversed — wait for confirmation",
        why: `Shorts climbed to ${fmt(r.runPeak)} and have stopped setting new highs. That pause is what the strategy watches for — but a pause is not yet a reversal, and shorts can start growing again.`,
        waiting: `Shorts to fall to ${fmt(r.fireLevel)} contracts. If they set a new high first, the peak moves up and this level rises with it.`,
        action: "Nothing yet. This stage exists to stop you buying into a fall that has not turned.",
        actionTone: "warn" as const,
      };
    }
    case "active":
      return {
        progress: Math.max(0, Math.min(100, (book / Math.max(1, r.activateLevel)) * 100)),
        progressLabel: "of required build",
        verdict: "No action",
        verdictSub: "Shorts are still growing — do not buy into rising pressure",
        why: `Shorts have reached ${fmt(book)}, close to the ${winLabel} high, and are still climbing. Growing shorts mean selling pressure is still increasing.`,
        waiting: "Shorts to stop setting new highs.",
        action: "Nothing yet — deliberately. Buying while shorts are still growing is buying into pressure that is still building.",
        actionTone: "warn" as const,
      };
    default:
      return {
        progress: Math.max(0, Math.min(100, (book / Math.max(1, r.activateLevel)) * 100)),
        progressLabel: "of required build",
        verdict: "No action",
        verdictSub: "No setup is forming",
        why: `${who} shorts sit at ${fmt(book)} contracts — ${r.pctOfPeak?.toFixed(1)}% of the ${winLabel} high of ${fmt(r.trailingPeak)}. Nothing unusual, so there is nothing to track.`,
        waiting: `${who} shorts to grow to ${fmt(r.activateLevel)} contracts (${fmt(r.activateLevel - book)} more).`,
        action: "Nothing to do. Most days sit here — a strategy that stays quiet most of the time is working as intended.",
        actionTone: "flat" as const,
      };
  }
}

/** Non-clickable stat. `so` answers "why should I care"; `tip` explains the term. */
function Kpi({
  icon, label, tip, value, sub, so, accent, tint,
}: {
  icon: string; label: string; tip: string; value: string; sub?: string; so?: string; accent: string; tint: string;
}) {
  return (
    <div className="relative rounded-xl border border-border overflow-hidden px-4 py-3" style={{ background: tint }}>
      <span aria-hidden className="absolute inset-y-0 left-0" style={{ width: 3, background: accent }} />
      <div className="flex items-center gap-2 mb-1.5">
        <span aria-hidden className="inline-flex items-center justify-center rounded-md text-[11px] shrink-0"
          style={{ width: 20, height: 20, background: accent, color: "#fff" }}>{icon}</span>
        <span className="text-[10px] uppercase tracking-widest leading-tight" style={{ color: "var(--ink-muted)" }}>
          {label}<Info tip={tip} />
        </span>
      </div>
      <div className="text-xl leading-none font-semibold" style={{ fontFamily: SANS, color: "var(--ink)" }}>{value}</div>
      {sub && <div className="text-[10.5px] mt-1 leading-snug" style={{ color: "var(--ink-muted)" }}>{sub}</div>}
      {so && (
        <div className="text-[10.5px] mt-1.5 pt-1.5 leading-snug"
          style={{ color: "var(--ink-soft)", borderTop: "1px solid var(--border)" }}>{so}</div>
      )}
    </div>
  );
}

export default function PeakReversalCard({ data }: { data: ParticipantsData }) {
  const [actor, setActor] = useState<string>(STRATEGY_PARTICIPANT_DEFAULT);
  const rec = recommendedFor(actor);
  const [win, setWin] = useState(rec.default);
  // Identity colour follows the participant, exactly as it does on every chart —
  // a series must not change hue between views.
  const ACCENT = PV_COLORS[actor] ?? PV_COLORS.FII;
  const [threshold, setThreshold] = useState(ACTIVATION_DEFAULT);
  const [open, setOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const book = data.participants?.[actor]?.futuresShort;
  const wcfg = MACHINE_WINDOWS.find((w) => w.key === win) ?? MACHINE_WINDOWS[4];
  const isRec = rec.window != null && win === rec.window;
  const sessions = wcfg.sessions;

  const r = useMemo(
    () => (book ? runPeakReversal(data.dates, data.nifty, book, sessions, threshold / 100) : null),
    [book, data.dates, data.nifty, sessions, threshold],
  );
  if (!book || !r) return null;

  const nowIdx = stageIndex(r.state);
  const stage = STAGES[nowIdx];
  const n = narrate(r, threshold, wcfg.label, actor);
  const rows = [...r.events].reverse().slice(0, 8);
  const custom = threshold !== ACTIVATION_DEFAULT;
  const posPct = Math.max(0, Math.min(100, r.pctOfPeak ?? 0));
  const edge = r.medianForward != null && r.baselineMedian != null ? r.medianForward - r.baselineMedian : null;
  const toneBg = { good: "var(--status-good-tint)", warn: "var(--status-warning-tint)", flat: "var(--tint-flat)" }[n.actionTone];
  const toneDot = { good: "var(--status-good)", warn: "var(--status-warning)", flat: "var(--ink-muted)" }[n.actionTone];
  const cadence = r.events.length ? Math.round(data.dates.length / r.events.length) : null;

  // How often the participant was STILL net short at the moment of the signal.
  // Measured here rather than hard-coded, because it differs per participant and
  // window — and it is the fact that stops "signal" being read as "copy them".
  const stillShort = useMemo(() => {
    const longs = data.participants?.[actor]?.futuresLong;
    const shorts = data.participants?.[actor]?.futuresShort;
    if (!longs || !shorts) return null;
    const pos = new Map(data.dates.map((d, i) => [d, i]));
    let n = 0, of = 0;
    for (const e of r.events) {
      const i = pos.get(e.date);
      if (i == null) continue;
      const l = longs[i], sh = shorts[i];
      if (l == null || sh == null) continue;
      of += 1;
      if (l - sh < 0) n += 1;
    }
    return { n, of };
  }, [data, actor, r.events]);

  return (
    <article className="rounded-2xl border overflow-hidden"
      style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}
      aria-label={`${actor} short-book peak reversal strategy`}>

      {/* ═══ 1–3 · what it is, what it watches, why it exists ═══ */}
      <div className="px-6 md:px-7 pt-6 pb-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span aria-hidden className="rounded-full" style={{ width: 9, height: 9, background: ACCENT }} />
              <span className="text-[11px] uppercase tracking-[0.2em] font-medium" style={{ color: ACCENT }}>
                {actor} · Index Futures
              </span>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-3xl md:text-[2.35rem] leading-tight font-bold"
                style={{ fontFamily: SANS, color: ACCENT, letterSpacing: "-0.02em" }}>Peak Reversal</h3>
              <div className="relative" ref={popRef}>
                <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
                  aria-label="Activation threshold settings"
                  title="Change how far shorts must fall from their peak before a signal fires"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    borderColor: custom ? ACCENT : "var(--border)",
                    background: custom ? "var(--surface-inset)" : "transparent", color: "var(--ink-soft)",
                  }}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M2 4.5h6M11 4.5h3M2 11.5h3M8 11.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="9.5" cy="4.5" r="1.9" stroke="currentColor" strokeWidth="1.5" />
                    <circle cx="6.5" cy="11.5" r="1.9" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span style={{ fontFamily: MONO }}>{threshold}%</span>
                </button>
                {open && (
                  <div className="absolute z-30 mt-2 left-0 rounded-xl border shadow-lg p-3"
                    style={{ background: "var(--surface-card)", borderColor: "var(--border)", width: 268 }}>
                    <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ink-muted)" }}>
                      Activation threshold
                    </p>
                    <p className="text-[10.5px] mb-2.5 leading-snug" style={{ color: "var(--ink-muted)" }}>
                      How far shorts must fall from their peak before a signal fires.
                    </p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {ACTIVATION_CHOICES.map((v) => {
                        const on = v === threshold, rec = v === ACTIVATION_DEFAULT;
                        return (
                          <button key={v} onClick={() => { setThreshold(v); setOpen(false); }}
                            className="rounded-md py-1.5 text-xs font-medium transition-colors"
                            style={{
                              fontFamily: MONO,
                              background: on ? ACCENT : rec ? "var(--surface-inset)" : "transparent",
                              color: on ? "#fff" : "var(--ink)",
                              border: rec ? `1px solid ${ACCENT}` : "1px solid var(--border)",
                            }}>{v}%</button>
                        );
                      })}
                    </div>
                    <p className="text-[10.5px] leading-relaxed mt-3 pt-3"
                      style={{ color: "var(--ink-soft)", borderTop: "1px solid var(--border)" }}>
                      <strong style={{ color: ACCENT }}>Default recommendation: 90%.</strong>{" "}
                      Selected from our internal research. Any custom threshold is user-defined and its
                      performance is the user&rsquo;s responsibility.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <p className="mt-2.5 text-[15px] leading-relaxed" style={{ color: "var(--ink)", maxWidth: 720 }}>
              Watches how heavily <strong>{actor}</strong> is positioned <strong>short</strong> in index futures,
              and looks for the moment that bet starts being <strong>unwound</strong>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
              title="Measured on history. Promising, but not yet through every robustness test."
              style={{ background: "var(--surface-inset)", border: "1px solid var(--border)", color: "var(--ink-soft)", fontFamily: MONO }}>
              <span aria-hidden style={{ color: "var(--status-info)" }}>◇</span>Research strategy
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
              style={{ background: stage.tint, border: `1px solid ${stage.dot}`, color: "var(--ink)", fontFamily: MONO }}>
              <span aria-hidden style={{ color: stage.dot }}>{stage.icon}</span>{stage.label}
            </span>
          </div>
        </div>

        {/* plain-language claim — no "discretionary", no "forced behaviour" */}
        <div className="mt-5 rounded-xl px-4 py-3.5"
          style={{ background: "var(--surface-subtle)", border: "1px solid var(--border)" }}>
          <p className="text-[10px] uppercase tracking-[0.18em] mb-1.5 font-semibold" style={{ color: ACCENT }}>
            Why this strategy exists
          </p>
          <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            Large {actor} short positions cannot stay extreme forever. As the position gets crowded, institutions
            eventually begin buying back their shorts — and that buying tends to lift the market.{" "}
            <strong style={{ color: "var(--ink)" }}>This strategy tries to catch the early stages of that unwind.</strong>{" "}
            It ignores how big the short position gets, and waits for it to start shrinking.
          </p>
        </div>

        {/* ═══ 4 · how a signal is generated ═══ */}
        <div className="mt-4">
          <p className="text-[10px] uppercase tracking-[0.18em] mb-2 font-semibold" style={{ color: "var(--ink-muted)" }}>
            How a signal is generated
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { n: "1", t: "Track the peak", d: `Record the largest ${actor} short position in the selected period.` },
              { n: "2", t: "Wait for the stall", d: "Do nothing while shorts keep growing. Only a stop in new highs counts." },
              { n: "3", t: "Signal on the unwind", d: `When shorts fall back to ${threshold}% of that peak, signal a long and hold ${MACHINE_HOLD} sessions.` },
            ].map((s) => (
              <div key={s.n} className="rounded-xl px-3.5 py-3 flex gap-3"
                style={{ background: "var(--surface-subtle)", border: "1px solid var(--border)" }}>
                <span aria-hidden className="shrink-0 inline-flex items-center justify-center rounded-lg text-[11px] font-bold"
                  style={{ width: 22, height: 22, background: ACCENT, color: "#fff", fontFamily: MONO }}>{s.n}</span>
                <div>
                  <p className="text-[12.5px] font-semibold leading-tight" style={{ color: "var(--ink)" }}>{s.t}</p>
                  <p className="text-[11.5px] leading-snug mt-0.5" style={{ color: "var(--ink-muted)" }}>{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ reference period ═══ */}
      <div className="px-6 md:px-7 pt-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
            Reference period
            <Info tip="How far back the strategy looks to decide what counts as 'the peak'. A 3Y window compares today against a three-year high; a 1M window against a one-month high." />
          </span>
          <div className="inline-flex rounded-lg p-0.5" style={{ background: "var(--surface-inset)" }}>
            {MACHINE_WINDOWS.map((w) => {
              const on = w.key === win;
              const good = w.key === rec.window;
              return (
                <button key={w.key} onClick={() => setWin(w.key)}
                  title={(w.key === rec.window ? rec.why : "") || `Not the recommended window for ${actor} — it produces signals, but the results do not hold up across both halves of the sample.`}
                  className="relative px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  style={{
                    background: on ? "var(--surface-raised)" : "transparent",
                    color: on ? "var(--ink)" : good ? "var(--ink-soft)" : "var(--ink-muted)",
                    boxShadow: on ? "var(--pill-shadow)" : undefined,
                    border: good ? `1px solid ${on ? ACCENT : "transparent"}` : "1px solid transparent",
                  }}>
                  {w.label}
                  {good && (
                    <span aria-hidden className="absolute rounded-full"
                      style={{ width: 5, height: 5, background: ACCENT, top: 3, right: 3 }} />
                  )}
                </button>
              );
            })}
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--ink-muted)" }}>
            <span aria-hidden className="rounded-full" style={{ width: 5, height: 5, background: ACCENT, display: "inline-block" }} />
            Recommended
          </span>
        </div>
        <p className="text-[11.5px] mt-2 leading-snug" style={{ color: "var(--ink-muted)", maxWidth: 760 }}>
          {isRec ? (
            <><strong style={{ color: ACCENT }}>{wcfg.label} is the recommended window for {actor}.</strong> {rec.why}</>
          ) : rec.window ? (
            <>
              <strong style={{ color: "var(--ink-soft)" }}>{wcfg.label} is not the recommended window for {actor}.</strong>{" "}
              Its results do not hold up across both halves of the sample — <strong style={{ color: ACCENT }}>{rec.window}</strong>{" "}
              is the one that does, and it carries the dot.
            </>
          ) : (
            <><strong style={{ color: "var(--ink-soft)" }}>No window is recommended for {actor}.</strong>{" "}
              Every lookback is shown for comparison only.</>
          )}
        </p>

        {/* A participant the strategy does not fit gets said so, above the
            numbers rather than under them. Client inverts outright. */}
        {rec.caution && (
          <div className="mt-2.5 rounded-xl px-4 py-3 flex items-start gap-2.5"
            style={{ background: "var(--status-warning-tint)", border: "1px solid var(--border)" }}>
            <span aria-hidden className="shrink-0 inline-flex items-center justify-center rounded-full font-bold mt-0.5"
              style={{ width: 15, height: 15, background: "var(--status-warning)", color: "#fff", fontSize: 10, lineHeight: 1 }}>!</span>
            <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
              <strong style={{ color: "var(--ink)" }}>{actor}: </strong>{rec.caution}
            </p>
          </div>
        )}
      </div>

      {/* ═══ 5 · CURRENT STATUS — the hero ═══ */}
      <div className="px-6 md:px-7 pt-5">
        <div className="rounded-2xl border overflow-hidden"
          style={{ background: stage.tint, borderColor: stage.dot }}>
          <div className="px-5 pt-4 pb-4">
            <p className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-3" style={{ color: "var(--ink-muted)" }}>
              Current status
            </p>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <span aria-hidden className="rounded-full shrink-0"
                  style={{ width: 16, height: 16, background: stage.dot, boxShadow: `0 0 0 5px color-mix(in srgb, ${stage.dot} 22%, transparent)` }} />
                <div className="min-w-0">
                  <div className="text-[2.6rem] leading-none font-bold"
                    style={{ fontFamily: SANS, color: "var(--ink)", letterSpacing: "-0.02em" }}>
                    {stage.label}
                  </div>
                  <div className="text-[14px] mt-1" style={{ color: "var(--ink-soft)" }}>{stage.sub}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[2rem] leading-none font-bold" style={{ fontFamily: SANS, color: stage.dot }}>
                  {n.progress.toFixed(1)}%
                </div>
                <div className="text-[11.5px] mt-1" style={{ color: "var(--ink-soft)" }}>{n.progressLabel}</div>
              </div>
            </div>

            {/* progress toward whatever this stage is waiting for */}
            <div className="mt-3 rounded-full overflow-hidden" style={{ height: 8, background: "var(--surface-inset)" }}>
              <div className="h-full rounded-full" style={{ width: `${n.progress}%`, background: stage.dot }} />
            </div>

            {n.waiting && (
              <p className="text-[13.5px] leading-relaxed mt-3" style={{ color: "var(--ink)" }}>
                <strong>Waiting for: </strong><span style={{ color: "var(--ink-soft)" }}>{n.waiting}</span>
              </p>
            )}
            <p className="text-[12.5px] leading-relaxed mt-1.5" style={{ color: "var(--ink-soft)" }}>{n.why}</p>
          </div>

          {/* what to do */}
          <div className="px-5 py-3 flex flex-wrap items-start gap-3" style={{ background: toneBg, borderTop: `1px solid var(--border)` }}>
            <span aria-hidden className="shrink-0 inline-flex items-center justify-center rounded-lg text-[12px] mt-0.5"
              style={{ width: 24, height: 24, background: toneDot, color: "#fff" }}>
              {r.state === "fired" ? "↑" : "—"}
            </span>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.18em] mb-1.5 font-semibold" style={{ color: "var(--ink-muted)" }}>
                What to do now
              </p>
              {/* The instruction is the point of the card, so it is rendered AS
                  an instruction — large, coloured by tone, above the reasoning.
                  It used to be a clause inside a paragraph, which meant the one
                  thing a reader came for was the one thing they had to hunt. */}
              <p className="text-[1.6rem] leading-none font-bold" style={{ fontFamily: SANS, color: toneDot, letterSpacing: "-0.01em" }}>
                {n.verdict}
              </p>
              <p className="text-[12.5px] mt-1.5" style={{ color: "var(--ink)" }}>{n.verdictSub}</p>
              <p className="text-[12.5px] leading-relaxed mt-2" style={{ color: "var(--ink-soft)" }}>{n.action}</p>

              {/* THE MOST MISREADABLE PART OF THE CARD, so it is stated rather
                  than inferred — but only at full length on a signal day, where
                  it changes what someone does. On quiet days it would be depth
                  nobody asked for. */}
              {r.state === "fired" && (
                <p className="text-[12.5px] leading-relaxed mt-2 pt-2" style={{ color: "var(--ink-soft)", borderTop: "1px solid var(--border)" }}>
                  <strong style={{ color: "var(--ink)" }}>The signal is to go long — not to copy {actor}.</strong>{" "}
                  {stillShort != null && stillShort.of > 0 && (
                    <>In <strong style={{ color: "var(--ink)" }}>{stillShort.n} of {stillShort.of}</strong> past signals {actor} was
                    still <em>net short</em> when it fired. </>
                  )}
                  Closing a short means buying, so you trade with their <em>buying</em>, not with their view.
                </p>
              )}
            </div>

            {/* Standing preview of the payoff. Without it, a reader on a quiet
                day — which is most days — never learns what the strategy is
                actually for until the one day it fires. */}
            {r.state !== "fired" && (
              <div className="shrink-0 ml-auto rounded-xl px-3.5 py-2.5 min-w-[236px]"
                style={{ background: "var(--status-good-tint)", border: "1px solid var(--status-good)" }}>
                <p className="text-[9px] uppercase tracking-[0.18em] mb-1 font-semibold" style={{ color: "var(--ink-muted)" }}>
                  When this fires
                </p>
                <p className="text-[14px] font-bold leading-tight" style={{ fontFamily: SANS, color: "var(--status-good)" }}>
                  ↑ Go long NIFTY index futures
                </p>
                <p className="text-[10.5px] mt-0.5" style={{ color: "var(--ink-soft)" }}>
                  held {MACHINE_HOLD} sessions from the next open
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ where the position sits ═══ */}
      <div className="px-6 md:px-7 pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold" style={{ color: "var(--ink-muted)" }}>
            Where {actor} shorts sit today
            <Info tip={`The bar runs from zero to the largest ${actor} short position in the selected reference period. The dashed line is the level a signal fires at.`} />
          </span>
          <span className="text-[11px]" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
            {fmt(r.shortBook)} short · peak {fmt(r.trailingPeak)}
          </span>
        </div>
        <div className="relative pt-7 pb-6 mt-1">
          <div className="absolute top-0 flex flex-col items-center"
            style={{ left: `min(max(${posPct}%, 34px), calc(100% - 34px))`, transform: "translateX(-50%)" }}>
            <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
              title={`Where ${actor} shorts sit today, as a share of their peak`}
              style={{ background: ACCENT, color: "#fff", fontFamily: MONO }}>{posPct.toFixed(1)}%</span>
          </div>
          <div className="relative rounded-lg overflow-hidden" style={{ height: 40, background: "var(--surface-inset)" }}>
            <div className="absolute inset-y-0 left-0"
              style={{ width: `${posPct}%`, background: `linear-gradient(90deg, ${ACCENT}22, ${ACCENT}55)` }} />
            <div className="absolute inset-y-0" style={{ left: `${posPct}%`, width: 3, background: ACCENT }} />
            <div aria-hidden className="absolute inset-y-0"
              style={{ left: `${threshold}%`, width: 0, borderLeft: "2px dashed var(--status-good)" }} />
          </div>
          <div className="absolute bottom-0 flex items-center gap-1.5"
            style={{
              left: `${threshold}%`, transform: threshold > 55 ? "translateX(-100%)" : "translateX(0)",
              paddingRight: threshold > 55 ? 6 : 0, paddingLeft: threshold > 55 ? 0 : 6,
            }}>
            <span aria-hidden style={{ color: "var(--status-good)", fontSize: 11, lineHeight: 1 }}>┆</span>
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap"
              style={{ color: "var(--ink-soft)", fontFamily: MONO }}>signal at {threshold}%</span>
          </div>
        </div>
        <div className="flex justify-between text-[10px] -mt-2" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
          <span>0%</span><span>100% of peak</span>
        </div>
      </div>

      {/* ═══ the numbers ═══ */}
      <div className="px-6 md:px-7 pt-5 pb-5">
        <p className="text-[10px] uppercase tracking-[0.18em] mb-2.5 font-semibold" style={{ color: "var(--ink-muted)" }}>
          How this window has performed
        </p>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <Kpi icon="◈" label="Typical return"
            tip={`Median NIFTY return measured over the ${MACHINE_HOLD} trading sessions following every historical signal.`}
            value={signed(r.medianForward)} sub="after a strategy signal"
            so={edge == null ? undefined : `${signed(edge)} better than a random day.`}
            accent={(r.medianForward ?? 0) > 0 ? "var(--ink-bull)" : "var(--ink-bear)"}
            tint={(r.medianForward ?? 0) > 0 ? "var(--tint-bull)" : "var(--tint-bear)"} />

          <Kpi icon="≈" label="Typical market return"
            tip={`Median NIFTY return over any ${MACHINE_HOLD} trading sessions, signal or not. This is the bar the strategy has to beat.`}
            value={signed(r.baselineMedian)}
            sub={`if you invested on any random day and held ${MACHINE_HOLD} sessions`}
            so="NIFTY drifts up over time, so a positive signal return alone proves nothing."
            accent="var(--ink-muted)" tint="var(--tint-flat)" />

          <Kpi icon="◉" label="Win rate"
            tip={`The share of historical signals where NIFTY was higher ${MACHINE_HOLD} trading sessions later.`}
            value={r.winRate == null ? "—" : `${Math.round(r.winRate * 100)}%`}
            sub={`${r.eventsUp} of ${r.eventsComplete} signals made money after ${MACHINE_HOLD} trading sessions`}
            so="A tilt, not a certainty — roughly one in three signals loses."
            accent="var(--status-good)" tint="var(--status-good-tint)" />

          <Kpi icon="⧉" label="Total signals"
            tip="How many times this strategy has fired across the whole dataset, at the current threshold and reference period."
            value={String(r.events.length)}
            sub={`across ${data.dates.length.toLocaleString("en-IN")} trading days`}
            so={cadence ? `≈ one signal every ${cadence} sessions. Rare by design.` : undefined}
            accent={ACCENT} tint="var(--tint-flat)" />

          <Kpi icon={stage.icon} label="Current stage"
            tip="Which of the four steps the strategy is on right now: Idle → Building → Stalling → Signal."
            value={stage.label} sub={stage.what} accent={stage.dot} tint={stage.tint} />

          <Kpi icon="◷" label="Reference window"
            tip="The lookback used to decide what counts as 'the peak'. Longer windows demand a bigger short position before anything is tracked."
            value={wcfg.label}
            sub={sessions > 10000 ? "entire history to date" : `${sessions} trading sessions`}
            so={isRec ? `The recommended window for ${actor}.` : `Not the recommended window for ${actor}.`}
            accent="var(--status-info)" tint="var(--status-info-tint)" />

          <Kpi icon="⏱" label="Holding period"
            tip={`Every number on this card is measured over the ${MACHINE_HOLD} trading sessions after a signal. Exiting earlier or later changes all of them.`}
            value={`${MACHINE_HOLD} sessions`} sub="≈ six calendar weeks"
            so="Entry is the next session's open, since OI publishes after the close."
            accent={ACCENT} tint="var(--tint-flat)" />

          <Kpi icon="◇" label="Validation status"
            tip="How much independent testing this strategy has survived. 'Not fully validated' means promising historical results that have not yet cleared every robustness check."
            value={custom ? "User-defined" : "Not fully validated"}
            sub={custom
              ? `${threshold}% is outside the researched default of ${ACTIVATION_DEFAULT}%`
              : "promising results, robustness tests incomplete"}
            so={custom
              ? "You changed the threshold, so these numbers are yours to justify."
              : "See “How much to trust this” below for exactly what passed and what didn’t."}
            accent={custom ? "var(--status-warning)" : "var(--status-info)"}
            tint={custom ? "var(--status-warning-tint)" : "var(--status-info-tint)"} />
        </div>
      </div>

      {/* ═══ signal history ═══ */}
      <div className="px-6 md:px-7 pb-5">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold" style={{ color: "var(--ink-muted)" }}>
            Every time this has fired
          </span>
          <span className="text-[10px]" style={{ color: "var(--ink-muted)" }}>
            most recent {rows.length} of {r.events.length}
          </span>
        </div>
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-[11.5px] border-collapse">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider"
                style={{ background: "var(--surface-subtle)", color: "var(--ink-muted)" }}>
                <th className="text-left font-normal px-3 py-2">Signal date</th>
                <th className="text-right font-normal px-3 py-2">
                  Peak was<Info tip="The largest FII short position reached during that build, in contracts." />
                </th>
                <th className="text-right font-normal px-3 py-2">
                  Off peak<Info tip="How far shorts had already fallen from that peak when the signal fired." />
                </th>
                <th className="text-right font-normal px-3 py-2">NIFTY then</th>
                <th className="text-right font-normal px-3 py-2">After {MACHINE_HOLD}d</th>
                <th className="text-right font-normal px-3 py-2">Result</th>
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
                      {/* An INCOMPLETE signal has no forward return yet — its
                          window runs past the end of the data (always true for
                          the newest signal, and for several once an as-of date
                          rewinds the dataset). Showing the clamped 0.00% would
                          render it as a loss it has not had. */}
                      {!e.complete || e.forwardPct == null ? "—" : signed(e.forwardPct)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {!e.complete || e.forwardPct == null ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                          style={{ background: "var(--tint-flat)", color: "var(--ink-muted)", border: "1px solid var(--border)" }}>
                          <span aria-hidden>◷</span>In progress
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                          style={{
                            background: up ? "var(--tint-bull)" : "var(--tint-bear)",
                            color: up ? "var(--ink-bull)" : "var(--ink-bear)",
                            border: `1px solid ${up ? "var(--edge-bull)" : "var(--edge-bear)"}`,
                          }}>
                          <span aria-hidden>{up ? "✓" : "✕"}</span>{up ? "Profit" : "Loss"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-[11px]" style={{ color: "var(--ink-muted)" }}>
                  No signals at this threshold and reference period.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ═══ 7 · how much to trust this — collapsed by default ═══ */}
      <div className="px-6 md:px-7 pb-6">
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--surface-subtle)", border: "1px solid var(--border)" }}>
          <button onClick={() => setTrustOpen((o) => !o)} aria-expanded={trustOpen}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
            <span className="flex items-center gap-2 min-w-0">
              <span aria-hidden className="inline-flex items-center justify-center rounded-md text-[11px] shrink-0"
                style={{ width: 20, height: 20, background: "var(--status-info)", color: "#fff" }}>◇</span>
              <span className="text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
                How much to trust this
              </span>
              <span className="text-[11.5px] truncate" style={{ color: "var(--ink-muted)" }}>
                — promising, but not fully validated
              </span>
            </span>
            <span aria-hidden className="text-[11px] shrink-0" style={{ color: "var(--ink-muted)" }}>
              {trustOpen ? "Hide ▲" : "Learn more ▼"}
            </span>
          </button>
          {trustOpen && (
            <div className="px-4 pb-4" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="grid gap-x-6 gap-y-2 md:grid-cols-2 pt-3">
                <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  <span style={{ color: "var(--status-good)" }}>✓</span>{" "}
                  <strong style={{ color: "var(--ink)" }}>What holds up.</strong> On a recommended window the edge
                  survives splitting the decade in half and removing the 2020 and 2022 crash years. A crowded short
                  book is genuinely its own signal, not just a fallen market in disguise — the two measure only
                  −0.06 correlated. The effect is strongest where shorts get squeezed: FII and DII.
                </p>
                <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  <span style={{ color: "var(--status-warning)" }}>!</span>{" "}
                  <strong style={{ color: "var(--ink)" }}>What doesn&rsquo;t, yet.</strong> It has not been through
                  the full robustness suite. A closely related version of this rule beat buy-and-hold but{" "}
                  <em>failed</em> when tested against simply buying the same dip. Until that test is repeated here,
                  treat the edge as unproven rather than established. It is also participant-specific: it fails
                  outright on Client and is marginal on Pro, so it is a claim about institutional short books
                  rather than about positioning in general.
                </p>
              </div>
              <p className="text-[11px] mt-3 pt-2.5" style={{ color: "var(--ink-muted)", borderTop: "1px solid var(--border)", fontFamily: MONO }}>
                reproduce · python -m research.experiments.phase5_machine
              </p>
            </div>
          )}
        </div>

        {/* Participant switch, deliberately last and folded away. FII is the
            default and the strongest fit; the others are here for comparison,
            not because the card wants you to shop between them. Putting this in
            the header made the choice look like the point of the card. */}
        <div className="mt-3 rounded-xl overflow-hidden" style={{ background: "var(--surface-subtle)", border: "1px solid var(--border)" }}>
          <button onClick={() => setAdvOpen((o) => !o)} aria-expanded={advOpen}
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left">
            <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
              Run this on another participant
              {actor !== STRATEGY_PARTICIPANT_DEFAULT && (
                <span className="ml-2 px-1.5 py-0.5 rounded-md text-[10px]"
                  style={{ background: "var(--surface-inset)", color: ACCENT, fontFamily: MONO }}>
                  {actor}
                </span>
              )}
            </span>
            <span aria-hidden className="text-[11px] shrink-0" style={{ color: "var(--ink-muted)" }}>
              {advOpen ? "Hide ▲" : "Change ▼"}
            </span>
          </button>
          {advOpen && (
            <div className="px-4 pb-3.5" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="inline-flex rounded-lg p-0.5 mt-3" style={{ background: "var(--surface-inset)" }}>
                {STRATEGY_PARTICIPANTS.map((a) => {
                  const on = a === actor;
                  return (
                    <button key={a}
                      onClick={() => { setActor(a); setWin(recommendedFor(a).default); }}
                      title={`${a} — ${PV_ROLE[a] ?? ""}`}
                      className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                      style={{ background: on ? PV_COLORS[a] : "transparent", color: on ? "#fff" : "var(--ink-muted)" }}>
                      {a}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11.5px] leading-snug mt-2.5" style={{ color: "var(--ink-muted)", maxWidth: 620 }}>
                The strategy is a claim about <strong style={{ color: "var(--ink-soft)" }}>institutional</strong> short
                books being squeezed. It is strongest on FII, holds on DII, is marginal on Pro, and{" "}
                <strong style={{ color: "var(--ink-soft)" }}>does not work on Client</strong> — retail shorts are not
                forced unwinds. Each participant keeps its own recommended windows.
              </p>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
