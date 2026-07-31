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
import { sliceParticipantsData, type ParticipantsData } from "../lib/series";
import PeakReversalCard from "./PeakReversalCard";

export default function StrategiesView({
  asOf,
  onBounds,
}: {
  asOf: string | null;
  onBounds: (first: string, last: string) => void;
}) {
  const [raw, setRaw] = useState<ParticipantsData | null>(null);
  const [failed, setFailed] = useState(false);

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
          <PeakReversalCard data={data} />
        )}
      </div>
    </section>
  );
}
