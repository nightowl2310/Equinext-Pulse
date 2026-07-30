// ─────────────────────────────────────────────────────────────────────────────
// SaturationStrip — FII short-book saturation, the one rule that survives all
// five validation attacks.
//
// WHAT IT SAYS: FII's gross short index-futures book, ranked against its own
// trailing year. Near the top of that range a short book is held for reasons
// other than conviction — margin, risk limits, carry — and unwinding it is
// mechanical buying.
//
// FORM CHOICES
// ------------
// * The headline is a METER, not a chart: one value on a fixed 1-year scale
//   with a threshold marked. A single current value against a known range is
//   exactly the case where a meter beats a plot. It answers "how close are we?"
//   which is the actual question today, since the rule is ARMED and not FIRING.
// * The history is a table of EPISODES, not a sparkline. Five dated rows with
//   outcomes make the tilt legible ("3 up, 2 down") in a way no summary
//   percentage does. Confidence in this project is episode count with dates —
//   never day count, and never a model-derived probability.
// * Forward return is POLARITY, so it takes the diverging --ink-bull/--ink-bear
//   pair already in the design system. Nothing new is introduced.
//
// COLOUR RULES OBSERVED
// * Status hues are RESERVED and mode-invariant (see theme.css). They appear
//   only as dots, borders and tints — never as text colour, never as a series.
// * Every status carries an icon AND a text label. Mandatory: the status set
//   does not clear the categorical adjacent-pair CVD test, which is fine for
//   mutually exclusive states shown one at a time with a label, and would not
//   be fine otherwise.
// * The state ramp quiet -> armed -> firing is ORDERED, so it uses one reserved
//   role per step rather than three unrelated hues.
//
// THE CONSTRAINT THAT SHAPED THE FOOTER
// -------------------------------------
// This rule is 5/5 but was found by scanning a 12-cell threshold/horizon grid,
// and it raises return WITHOUT reducing drawdown. Both caveats render at the
// same visual weight as the numbers, and are not collapsible. A 5/5 result
// found by selection is still a result found by selection, and a dashboard that
// hides that is how it gets mistaken for something predicted in advance.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ordinal,
  SIGNAL_SCHEMA_EXPECTED,
  type ParticipantsData,
  type SaturationBlock,
} from "../lib/series";

const MONO = "'DM Mono', monospace";
const SANS = "'DM Sans', sans-serif";

/** Ordered state ramp. Icon + label are mandatory — colour never travels alone. */
const STATE = {
  firing: {
    label: "Firing",
    icon: "▲",
    dot: "var(--status-good)",
    tint: "var(--status-good-tint)",
    blurb: "at or past the trigger — the historical setup is live now",
  },
  armed: {
    label: "Armed",
    icon: "◆",
    dot: "var(--status-warning)",
    tint: "var(--status-warning-tint)",
    blurb: "near the trigger but not there — worth watching, not acting",
  },
  quiet: {
    label: "Quiet",
    icon: "·",
    dot: "var(--ink-muted)",
    tint: "var(--tint-flat)",
    blurb: "mid-range — the rule has no opinion today",
  },
  unknown: {
    label: "Unknown",
    icon: "?",
    dot: "var(--ink-muted)",
    tint: "var(--tint-flat)",
    blurb: "not enough history to rank",
  },
} as const;

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-IN");

/** Index levels always to 2dp — the raw JSON rounds to 2 but drops a trailing
 *  zero, so 23,995.7 and 23,866.85 land in the same column misaligned. */
const px = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The meter. Fixed scale = the trailing 1-year low..high of the short book, so
 * the bar position is comparable day to day. The trigger is drawn as a line
 * rather than a colour change: you need to see the gap, not just which side of
 * it you are on.
 */
function RangeMeter({ s }: { s: SaturationBlock }) {
  const { rangeLow, rangeHigh, shortBook, triggerLevel } = s.latest;
  const span = Math.max(1, rangeHigh - rangeLow);
  const pos = ((shortBook - rangeLow) / span) * 100;
  const trig = ((triggerLevel - rangeLow) / span) * 100;
  const firing = s.latest.state === "firing";

  return (
    // pt-4 reserves a lane for the trigger label ABOVE the track — placing it
    // inside meant it sat on the fill and had to be knocked out with an opaque
    // background, which read as a gap in the bar.
    <div className="mt-1 pt-4 relative">
      <span
        className="absolute text-[9px] uppercase tracking-wider whitespace-nowrap"
        style={{
          left: `min(max(${trig}%, 22px), calc(100% - 22px))`,
          top: 0,
          transform: "translateX(-50%)",
          color: "var(--ink-soft)",
          fontFamily: MONO,
        }}
      >
        trigger
      </span>
      <div
        className="relative rounded"
        style={{ height: 34, background: "var(--surface-inset)" }}
      >
        {/* filled portion — magnitude, so a single hue, not a scale */}
        <div
          className="absolute inset-y-0 left-0 rounded-l"
          style={{
            width: `${Math.max(0, Math.min(100, pos))}%`,
            background: firing ? "var(--status-good-tint)" : "var(--status-warning-tint)",
            borderRight: `2px solid ${firing ? "var(--status-good)" : "var(--status-warning)"}`,
          }}
        />
        {/* the trigger threshold */}
        <div
          className="absolute inset-y-0"
          style={{
            left: `${Math.max(0, Math.min(100, trig))}%`,
            width: 2,
            background: "var(--ink)",
            opacity: 0.55,
          }}
          aria-hidden
        />
      </div>
      <div
        className="flex justify-between mt-1 text-[10px]"
        style={{ color: "var(--ink-muted)", fontFamily: MONO }}
      >
        <span>{fmt(rangeLow)} · 1y low</span>
        <span>{fmt(rangeHigh)} · 1y high</span>
      </div>
    </div>
  );
}

/** One dated episode with what followed. Direction is polarity -> diverging pair. */
function EpisodeRow({ e, horizon }: { e: SaturationBlock["episodes"][number]; horizon: number }) {
  const up = (e.forwardPct ?? 0) > 0;
  const ink = e.forwardPct == null ? "var(--ink-muted)" : up ? "var(--ink-bull)" : "var(--ink-bear)";
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td className="py-1.5 pr-3 whitespace-nowrap" style={{ color: "var(--ink)", fontFamily: MONO }}>
        {e.date}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
        {px(e.niftyAt)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
        {px(e.niftyAfter)}
      </td>
      <td className="py-1.5 text-right tabular-nums font-medium" style={{ color: ink, fontFamily: MONO }}>
        {/* the arrow is the secondary encoding — sign is never colour-alone */}
        {e.forwardPct == null
          ? "—"
          : `${up ? "▲" : "▼"} ${e.forwardPct > 0 ? "+" : ""}${e.forwardPct.toFixed(2)}%`}
        {!e.complete && (
          <span className="ml-1 text-[9px]" style={{ color: "var(--ink-muted)" }}>
            (partial, &lt;{horizon}d)
          </span>
        )}
      </td>
    </tr>
  );
}

export default function SaturationStrip({ data }: { data: ParticipantsData }) {
  const s = data.saturation;
  // Absent when history is too short to rank. Render nothing rather than a
  // confident-looking zero.
  if (!s?.latest) return null;

  const st = STATE[s.latest.state] ?? STATE.unknown;
  const stale = s.schemaVersion !== SIGNAL_SCHEMA_EXPECTED;
  const recent = s.episodes.slice(-6).reverse();

  return (
    <section
      className="rounded-xl border border-border overflow-hidden mb-6"
      style={{ background: "var(--surface-card)" }}
      aria-label="Short-book saturation signal"
    >
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-start justify-between gap-3 border-b border-border">
        <div className="min-w-[260px]">
          <p className="text-xs uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
            {s.actor} short-book saturation
          </p>
          <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            {s.actor}&rsquo;s gross short index-futures book, ranked against its own last {s.window} sessions.
            Fires at the {ordinal(s.triggerPercentile)} percentile; measured over the following {s.horizon} sessions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
            style={{ background: st.tint, border: `1px solid ${st.dot}`, color: "var(--ink)", fontFamily: MONO }}
          >
            <span aria-hidden style={{ color: st.dot }}>{st.icon}</span>
            {st.label}
          </span>
          <span className="text-[11px]" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
            as of {s.latest.date}
          </span>
        </div>
      </div>

      {/* ── the meter + the three numbers that explain it ──────────────── */}
      <div className="px-5 py-4 grid gap-5 md:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-semibold leading-none" style={{ fontFamily: SANS, color: "var(--ink)" }}>
              {fmt(s.latest.shortBook)}
            </span>
            <span className="text-[11px]" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
              contracts short · {ordinal(s.latest.percentile)} percentile
            </span>
          </div>
          <RangeMeter s={s} />
          <p className="text-[11px] mt-2.5 leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            {st.blurb}.{" "}
            {s.latest.state !== "firing" && s.latest.gapContracts > 0 && (
              <>
                Needs <strong style={{ color: "var(--ink)" }}>{fmt(s.latest.gapContracts)}</strong> more contracts
                ({s.latest.gapPercent?.toFixed(1)}%) to reach {fmt(s.latest.triggerLevel)}.
              </>
            )}
          </p>
        </div>

        {/* ── episode history: the honest form of confidence ───────────── */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
              Last {recent.length} of {s.episodeCount} episodes
            </span>
            <span className="text-[10px]" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
              {s.episodesUp}/{s.episodesComplete} up
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider" style={{ color: "var(--ink-muted)" }}>
                  <th className="text-left font-normal pb-1">fired</th>
                  <th className="text-right font-normal pb-1 pr-3">NIFTY</th>
                  <th className="text-right font-normal pb-1 pr-3">+{s.horizon}d</th>
                  <th className="text-right font-normal pb-1">move</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <EpisodeRow key={e.date} e={e} horizon={s.horizon} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] mt-1.5 leading-snug" style={{ color: "var(--ink-muted)" }}>
            Episodes, not days: consecutive firings are one event. {s.episodeCount} episodes span 9 of 11 years.
          </p>
        </div>
      </div>

      {/* ── the caveats, at the same weight as the numbers ─────────────── */}
      <div
        className="px-5 py-3 border-t border-border flex items-start gap-2.5"
        style={{ background: "var(--status-critical-tint)" }}
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-full font-bold shrink-0 mt-0.5"
          style={{
            width: 14, height: 14,
            background: "var(--status-critical)", color: "#fff",
            fontSize: 10, lineHeight: 1,
          }}
        >
          !
        </span>
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          <strong style={{ color: "var(--ink)" }}>
            Not validated — it beats buy &amp; hold but not buying the same dip.
          </strong>{" "}
          This rule passes all five attacks against buy &amp; hold (15.83%/yr vs 12.08%). But a crowded short book
          tends to occur <em>after</em> NIFTY has fallen, and dips mean-revert &mdash; so the benchmark that matters
          is a plain dip-buyer. Against an episode-matched one it scores <strong style={{ color: "var(--ink)" }}>4/5
          at 1Y and 3Y, 2/5 at 6M</strong>, failing block permutation both times (p=0.139, p=0.136): its edge over
          dip-buying is not distinguishable from randomly-timed exposure. Adding this filter to a dip-buyer scores
          1/5 at 3Y. The horizon was also picked by scanning 12 combinations, and the 5/5 is start-date sensitive
          (4/5 from 2019). Treat the reading below as a description of positioning, not an instruction. Reproduce
          with{" "}
          <code style={{ fontFamily: MONO, color: "var(--ink)" }}>
            python -m research.experiments.phase4_control
          </code>
          .
        </p>
      </div>

      {stale && (
        <div className="px-5 py-2 border-t border-border" style={{ background: "var(--status-critical-tint)" }}>
          <p className="text-[11px]" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
            saturation schema v{s.schemaVersion} but this UI expects v{SIGNAL_SCHEMA_EXPECTED} — fields may be
            missing or renamed. Re-check the contract in signals.py.
          </p>
        </div>
      )}
    </section>
  );
}
