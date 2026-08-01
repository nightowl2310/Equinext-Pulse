// ─────────────────────────────────────────────────────────────────────────────
// AsOfPicker — rewind the whole dashboard to a past trading date.
//
// Appears twice: as the navbar stamp and as the hero "Data as of" chip. One
// component, two variants, because two hand-written pickers reading the same
// state is how they end up disagreeing about the bounds or the reset behaviour.
//
// The two variants exist for a real reason, not decoration: the navbar is a
// permanently dark plate in BOTH themes, so its trigger must use literal white
// alphas. Resolving through --ink there would make the control invisible in
// light mode. The hero sits on the normal page surface and uses the tokens.
//
// Selecting a date sets a WALL: every view truncates its payload to that date
// before rendering, so the page reads as it would have on that day rather than
// hiding later rows from a full-history calculation.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";

export interface AsOfBounds {
  first: string;
  last: string;
}

export default function AsOfPicker({
  asOf,
  setAsOf,
  bounds,
  variant,
  idleLabel,
}: {
  asOf: string | null;
  setAsOf: (d: string | null) => void;
  bounds: AsOfBounds | null;
  variant: "nav" | "hero";
  /** what the trigger reads when no date is pinned (latest) */
  idleLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const nav = variant === "nav";

  const Calendar = (
    <svg width={nav ? 12 : 13} height={nav ? 12 : 13} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3.5" width="12" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.8h12M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Change the date this page is showing"
        title="Show the dashboard as it stood on a chosen trading date"
        className={
          nav
            ? "flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
            : "flex items-center gap-2.5 text-left text-xs px-3.5 py-2 rounded-lg border transition-colors"
        }
        style={
          nav
            ? {
                fontFamily: "'DM Mono', monospace",
                color: asOf ? "#FFFFFF" : "rgba(255,255,255,0.32)",
                background: asOf ? "rgba(255,255,255,0.10)" : "transparent",
                border: `1px solid ${asOf ? "rgba(255,255,255,0.25)" : "transparent"}`,
              }
            : {
                fontFamily: "'DM Mono', monospace",
                color: "var(--ink-muted)",
                background: asOf ? "var(--surface-inset)" : "rgba(18,21,28,0.03)",
                borderColor: asOf ? "var(--ink-muted)" : "var(--border)",
              }
        }
      >
        {nav ? (
          <>
            {Calendar}
            {asOf ? `As of ${asOf}` : idleLabel}
            <span aria-hidden style={{ opacity: 0.6 }}>▾</span>
          </>
        ) : (
          <>
            <span style={{ color: "var(--ink-muted)" }}>{Calendar}</span>
            <span>
              Data as of
              <br />
              <span className="text-foreground font-medium">{asOf ?? idleLabel}</span>
            </span>
            <span aria-hidden style={{ opacity: 0.5 }}>▾</span>
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute mt-2 rounded-xl border shadow-lg p-3 z-40 ${nav ? "right-0" : "left-0"}`}
          style={{ background: "var(--surface-card)", borderColor: "var(--border)", width: 272 }}
        >
          <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: "var(--ink-muted)" }}>
            Show data as of
          </p>
          <p className="text-[10.5px] leading-snug mb-2.5" style={{ color: "var(--ink-muted)" }}>
            The page is truncated to this date. Charts and strategy state read exactly as they would
            have on that day — nothing after it is used.
          </p>
          <input
            type="date"
            value={asOf ?? bounds?.last ?? ""}
            min={bounds?.first}
            max={bounds?.last}
            onChange={(e) => setAsOf(e.target.value || null)}
            className="w-full rounded-lg px-2.5 py-2 text-sm"
            style={{
              background: "var(--surface-inset)",
              border: "1px solid var(--border)",
              color: "var(--ink)",
              fontFamily: "'DM Mono', monospace",
            }}
          />
          {bounds && (
            <p className="text-[10px] mt-1.5" style={{ color: "var(--ink-muted)", fontFamily: "'DM Mono', monospace" }}>
              {bounds.first} → {bounds.last}
            </p>
          )}
          <button
            onClick={() => {
              setAsOf(null);
              setOpen(false);
            }}
            disabled={!asOf}
            className="w-full mt-2.5 rounded-lg py-2 text-xs font-medium transition-opacity"
            style={{
              background: asOf ? "var(--surface-inset)" : "transparent",
              border: "1px solid var(--border)",
              color: asOf ? "var(--ink)" : "var(--ink-muted)",
              opacity: asOf ? 1 : 0.5,
            }}
          >
            Back to latest
          </button>
        </div>
      )}
    </div>
  );
}
