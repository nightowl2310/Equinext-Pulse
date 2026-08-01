// ─────────────────────────────────────────────────────────────────────────────
// StrategiesView — the Strategies page.
//
// Strategies get their own page rather than a section inside the participant
// chart, because they are a different kind of object: a chart shows you what
// happened, a strategy tells you what it thinks and asks you to act. Nesting the
// second under the first made it read as a caption.
//
// The participant page keeps a StrategyTeaser that links here. Both compute
// their state through the same `runPeakReversal`, so the doorway can never
// disagree with the room.
//
// AS-OF WALL: the payload is truncated to the selected date before anything
// renders, so the whole page reads as it would have on that day. Doing it once,
// here, is what makes it true for every child at once.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import {
  type BookMode,
  type ChartSelection,
  type MetricKey,
  type ParticipantsData,
  type RangeKey,
  PV_METRICS,
  PV_MODES,
  PV_RANGES,
  metricLabel,
  sliceParticipantsData,
} from "../lib/series";
import { ParticipantChart, type RenderMode } from "./ParticipantChart";
import PeakReversalCard from "./PeakReversalCard";

/** Same pill idiom the participant page uses, kept local so this view does not
 *  reach into App's render helpers. */
function pillRow<T extends string>(
  opts: readonly { key: T; label: string }[],
  active: T,
  onPick: (k: T) => void,
) {
  return (
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
}

export default function StrategiesView({
  asOf,
  onBounds,
}: {
  asOf: string | null;
  onBounds: (first: string, last: string) => void;
}) {
  const [raw, setRaw] = useState<ParticipantsData | null>(null);
  const [failed, setFailed] = useState(false);

  // Reference chart at the foot of the page — collapsed, because it is context
  // for the strategies above rather than a strategy itself.
  //
  // It opens on the SHORT BOOK, not the net: every rule on this page is built on
  // a participant's gross short leg. The four nets sum to zero by construction,
  // so a net view would show the identity rather than the quantity the machine
  // actually watches.
  const [chartOpen, setChartOpen] = useState(false);
  const [bookMode, setBookMode] = useState<BookMode>("shortBook");
  const [metric, setMetric] = useState<MetricKey>("futures");
  const [range, setRange] = useState<RangeKey>("1Y");
  const [renderMode, setRenderMode] = useState<RenderMode>("line");
  const [hover, setHover] = useState<number | null>(null);
  const [selection, setSelection] = useState<ChartSelection | null>(null);

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
        setRaw(d);
        onBounds(d.dates[0], d.dates[d.dates.length - 1]);
      })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
    // onBounds is a stable setter from App; re-fetching on its identity would
    // pull 1.2 MB on every parent render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = useMemo(() => {
    if (!raw) return null;
    if (!asOf) return raw;
    let hi = raw.dates.length - 1;
    while (hi > 0 && raw.dates[hi] > asOf) hi--;
    return sliceParticipantsData(raw, 0, hi);
  }, [raw, asOf]);

  return (
    <section id="sec-strategies-page" className="pt-2">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="shrink-0 flex items-center justify-center rounded-full text-sm font-bold mt-0.5"
          style={{
            width: 34, height: 34, background: "var(--ink)", color: "var(--surface-page)",
            fontFamily: "'DM Mono', monospace",
          }}
        >
          ⚑
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "var(--ink-muted)" }}>
            Strategies · signals derived from participant positioning
          </p>
          <p
            className="text-2xl md:text-3xl leading-snug font-semibold"
            style={{ fontFamily: "'Playfair Display', serif", color: "var(--ink)" }}
          >
            Strategy signals
          </p>
          <p className="mt-2 text-sm" style={{ color: "var(--ink-muted)", maxWidth: 680 }}>
            Rules built on participant open interest. Each carries its live state, the reference period it is
            measured against, and every historical firing it has produced. All are research strategies under
            evaluation — the numbers are measured, not promises.
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        {failed ? (
          <div
            className="rounded-2xl border border-border px-7 py-8 text-sm"
            style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
          >
            Strategy data unavailable. Generate it with{" "}
            <code style={{ fontFamily: "'DM Mono', monospace" }}>python plot_fii_vs_nifty.py</code>.
          </div>
        ) : !data ? (
          <div
            className="rounded-2xl border border-border px-7 py-8 text-sm"
            style={{ background: "var(--surface-card)", color: "var(--ink-muted)" }}
          >
            Loading strategies…
          </div>
        ) : (
          <>
            <PeakReversalCard data={data} />

            {/* ── reference chart, collapsed ── */}
            <div className="rounded-2xl border border-border overflow-hidden" style={{ background: "var(--surface-card)" }}>
              <button
                onClick={() => setChartOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-4 px-5 md:px-7 py-4 text-left"
                aria-expanded={chartOpen}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    All four participants against NIFTY 50
                  </span>
                  <span className="block text-xs mt-0.5" style={{ color: "var(--ink-muted)" }}>
                    Reference context for the rules above. Opens on the short book — the leg these
                    strategies are actually built on.
                  </span>
                </span>
                <span className="shrink-0 text-xs" style={{ color: "var(--ink-muted)", fontFamily: "'DM Mono', monospace" }}>
                  {chartOpen ? "▴ Hide" : "▾ Show"}
                </span>
              </button>

              {chartOpen && (
                <div className="px-5 md:px-7 pb-6 pt-5 border-t border-border">
                  <div className="flex flex-wrap items-center gap-3">
                    {pillRow(PV_MODES, bookMode, setBookMode)}
                    {pillRow(
                      [
                        { key: "line" as RenderMode, label: "Line" },
                        { key: "bar" as RenderMode, label: "Bar" },
                      ],
                      renderMode,
                      setRenderMode,
                    )}
                  </div>
                  <div className="mt-3">
                    {pillRow(
                      PV_METRICS.map((m) => ({ key: m.key, label: metricLabel(m.key, bookMode) })),
                      metric,
                      setMetric,
                    )}
                  </div>
                  <div className="mt-3">
                    {pillRow(PV_RANGES, range, (k) => {
                      // the hover/selection indices address the OLD window
                      setRange(k);
                      setHover(null);
                    })}
                  </div>
                  <div className="mt-5">
                    <ParticipantChart
                      data={data}
                      mode={bookMode}
                      metric={metric}
                      range={range}
                      render={renderMode}
                      hover={hover}
                      setHover={setHover}
                      selection={selection}
                      setSelection={setSelection}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
