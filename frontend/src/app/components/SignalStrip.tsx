// ─────────────────────────────────────────────────────────────────────────────
// SignalStrip — what the engine currently reads, and how much to trust it.
//
// FORM: a KPI row of four stat tiles, not a chart. Each tile is a single current
// value, which is exactly the case where a stat tile beats a one-bar chart.
//
// THE DESIGN CONSTRAINT THAT SHAPED THIS FILE
// -------------------------------------------
// The sizing engine survives 4 of 5 validation attacks and its full-sample
// drawdown advantage traces almost entirely to March 2020 (see
// docs/validation-log.md). It is NOT validated downside protection. So this
// component may not render `size` as a clean recommendation — the caveat is
// rendered at the same visual weight as the number, and the number is explicitly
// labelled "not for capital".
//
// A dashboard that shows a number without its evidence is how a 4/5 engine gets
// mistaken for a 5/5 one. `signal.validation` ships inside the payload precisely
// so this component cannot fail to have it.
//
// COLOUR RULES OBSERVED
//   * Regime is an ORDERED scale -> one reserved status role per step, never four
//     unrelated hues. (Amber vs red failed CVD separation at dE 6.6 as a
//     categorical pair; as an ordered ramp with labels the collision is moot.)
//   * Status hues appear only as dots and borders. Text always wears --ink /
//     --ink-soft / --ink-muted, never a status colour.
//   * Every status carries an icon + a text label, so colour is never the only cue.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ordinal,
  REGIME_STYLE,
  SIGNAL_SCHEMA_EXPECTED,
  type ParticipantsData,
  type SignalValidation,
} from "../lib/series";

const MONO = "'DM Mono', monospace";
const SANS = "'DM Sans', sans-serif";

/** Small status badge. Icon + label are mandatory — colour never travels alone. */
function StatusBadge({ v }: { v: SignalValidation | undefined }) {
  if (!v) return null;
  const bad = v.status.toUpperCase().includes("NOT");
  const descriptive = v.status === "descriptive";
  const dot = bad ? "var(--status-warning)" : descriptive ? "var(--ink-muted)" : "var(--status-good)";
  const tint = bad ? "var(--status-warning-tint)" : descriptive ? "var(--tint-flat)" : "var(--status-good-tint)";
  const icon = bad ? "!" : descriptive ? "i" : "✓";
  const text = bad
    ? `not validated · ${v.attacksSurvived ?? ""}`.trim()
    : descriptive
      ? "descriptive only"
      : `${v.attacksSurvived ?? "validated"} attacks`;

  return (
    <span
      title={v.note}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap cursor-help"
      style={{ background: tint, border: "1px solid var(--border)", color: "var(--ink-soft)", fontFamily: MONO }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center rounded-full font-bold"
        style={{ width: 11, height: 11, background: dot, color: "#fff", fontSize: 8, lineHeight: 1 }}
      >
        {icon}
      </span>
      {text}
    </span>
  );
}

/** One stat tile: eyebrow, hero value, supporting line, validation badge. */
function Tile({
  eyebrow,
  value,
  sub,
  detail,
  dot,
  tint,
  validation,
}: {
  eyebrow: string;
  value: string;
  sub?: string;
  detail?: string;
  dot?: string;
  tint?: string;
  validation?: SignalValidation;
}) {
  return (
    <div
      className="flex-1 min-w-[190px] rounded-lg border border-border px-4 py-3.5"
      style={{ background: tint ?? "var(--surface-subtle)" }}
    >
      <div className="flex items-center gap-1.5 mb-2">
        {dot && <span aria-hidden className="rounded-full shrink-0" style={{ width: 7, height: 7, background: dot }} />}
        <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
          {eyebrow}
        </span>
      </div>
      <div className="text-2xl leading-none font-semibold mb-1.5" style={{ fontFamily: SANS, color: "var(--ink)" }}>
        {value}
      </div>
      {sub && (
        <div className="text-[11px] leading-snug" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
          {sub}
        </div>
      )}
      {detail && (
        <div className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--ink-muted)" }}>
          {detail}
        </div>
      )}
      {validation && (
        <div className="mt-2">
          <StatusBadge v={validation} />
        </div>
      )}
    </div>
  );
}

export default function SignalStrip({ data }: { data: ParticipantsData }) {
  const signal = data.signal;
  if (!signal?.latest) return null;

  const { latest, validation } = signal;
  const regime = REGIME_STYLE[latest.regime] ?? REGIME_STYLE.unknown;
  const asOf = data.dateDisplay?.[data.dateDisplay.length - 1] ?? data.end;
  const stale = signal.schemaVersion !== SIGNAL_SCHEMA_EXPECTED;

  const fii = latest.positioning?.FII;
  const pro = latest.positioning?.Pro;

  return (
    <div className="rounded-xl border border-border overflow-hidden mb-6" style={{ background: "var(--surface-card)" }}>
      {/* header */}
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-baseline justify-between gap-2 border-b border-border">
        <div>
          <p className="text-xs uppercase tracking-widest" style={{ color: "var(--ink-muted)" }}>
            Engine reading
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--ink-soft)" }}>
            Position size reacts to realised volatility. It makes no forecast and calls no direction.
          </p>
        </div>
        <span className="text-[11px]" style={{ color: "var(--ink-muted)", fontFamily: MONO }}>
          as of {asOf}
        </span>
      </div>

      {/* KPI row */}
      <div className="p-5 flex flex-wrap gap-3">
        <Tile
          eyebrow="Regime"
          value={regime.label}
          sub={
            latest.vol != null
              ? `vol ${latest.vol.toFixed(2)}%/day · ${ordinal(latest.volPercentile)} pctile`
              : undefined
          }
          detail={regime.blurb}
          dot={regime.dot}
          tint={regime.tint}
          validation={validation?.regime}
        />
        <Tile
          eyebrow="Position size"
          value={latest.size != null ? `${latest.size.toFixed(2)}×` : "n/a"}
          sub={`target ${signal.targetVol}%/day · cap ${signal.sizeCap}×`}
          detail={
            latest.size != null && latest.size > 1
              ? "above 1× — the engine is LEVERAGED here"
              : "at or below 1× — de-risked"
          }
          validation={validation?.size}
        />
        <Tile
          eyebrow="FII positioning"
          value={fii?.percentile != null ? `${ordinal(fii.percentile)}` : "n/a"}
          sub={`percentile of last ${signal.percentileWindow} sessions`}
          detail={fii?.label}
          validation={validation?.percentile}
        />
        <Tile
          eyebrow="Pro positioning"
          value={pro?.percentile != null ? `${ordinal(pro.percentile)}` : "n/a"}
          sub={`percentile of last ${signal.percentileWindow} sessions`}
          detail={pro?.label}
          validation={validation?.percentile}
        />
      </div>

      {/* The known weakness, at the same visual weight as the numbers above.
          Deliberately not collapsible: an engine that fails an attack should not
          be able to look validated on a glance. */}
      <div
        className="px-5 py-3 border-t border-border flex items-start gap-2.5"
        style={{ background: "var(--status-warning-tint)" }}
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-full font-bold shrink-0 mt-0.5"
          style={{ width: 14, height: 14, background: "var(--status-warning)", color: "#fff", fontSize: 10, lineHeight: 1 }}
        >
          !
        </span>
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          <strong style={{ color: "var(--ink)" }}>Not validated for capital.</strong> The sizing rule survives 4 of 5
          attacks &mdash; it fails year-by-year (3W/8L) &mdash; and almost all of its full-sample drawdown advantage
          comes from March 2020 alone. Because it sizes <em>up</em> when volatility is low, a calm market that falls
          without a volatility spike leaves it larger than buy &amp; hold: over the last 2 years it returned
          &minus;7.50% vs &minus;3.67% with no drawdown benefit. Treat these as descriptions of current conditions, not
          instructions.
        </p>
      </div>

      {stale && (
        <div className="px-5 py-2 border-t border-border" style={{ background: "var(--status-critical-tint)" }}>
          <p className="text-[11px]" style={{ color: "var(--ink-soft)", fontFamily: MONO }}>
            signal schema v{signal.schemaVersion} but this UI expects v{SIGNAL_SCHEMA_EXPECTED} &mdash; fields may be
            missing or renamed. Re-check the contract in signals.py.
          </p>
        </div>
      )}
    </div>
  );
}
