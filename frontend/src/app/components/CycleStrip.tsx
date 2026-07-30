import type { CycleLeg, ParticipantsData } from "../lib/series";
import { PV_COLORS, PV_PARTICIPANTS } from "../lib/series";

const TYPE_LABEL: Record<CycleLeg["type"], string> = {
  accumulation: "Accumulation",
  distribution: "Distribution",
};

const TYPE_TINT: Record<CycleLeg["type"], string> = {
  accumulation: "var(--ink-bull)",
  distribution: "var(--ink-bear)",
};

function fmtPrice(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtOi(v: number): string {
  return v.toLocaleString("en-IN");
}

function LegRow({ leg }: { leg: CycleLeg }) {
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td className="px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5" style={{ color: TYPE_TINT[leg.type] }}>
          <span
            style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_TINT[leg.type], display: "inline-block" }}
          />
          {TYPE_LABEL[leg.type]}
        </span>
      </td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{leg.startDate}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{leg.endDate}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink-muted)" }}>{leg.durationSessions}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtOi(leg.oiStart)}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtOi(leg.oiEnd)}</td>
      <td className="text-right px-3 py-1.5" style={{ color: "var(--ink)" }}>{fmtPrice(leg.avgPrice)}</td>
      <td
        className="text-right px-3 py-1.5"
        style={{ color: leg.spread === undefined ? "var(--ink-muted)" : leg.spread >= 0 ? "var(--ink-bull)" : "var(--ink-bear)" }}
      >
        {fmtPrice(leg.spread)}
      </td>
    </tr>
  );
}

export default function CycleStrip({ data }: { data: ParticipantsData }) {
  const cycles = data.cycles;
  if (!cycles?.legs) return null;

  const actors = PV_PARTICIPANTS.filter((p) => cycles.legs[p]?.length);
  if (!actors.length) return null;

  return (
    <div className="mb-5 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--surface-card)" }}>
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-[11px]" style={{ color: "var(--ink)" }}>
          <b>Position cycles</b>{" "}
          <span style={{ color: "var(--ink-muted)" }}>
            · avg NIFTY close across each accumulation/distribution leg, OI-change weighted ·
            turn confirmed at ≥{cycles.minRetracementPct}% retracement held ≥{cycles.minHoldSessions} sessions
          </span>
        </span>
      </div>
      {actors.map((actor) => (
        <div key={actor} className="px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="mb-1 inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--ink)" }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: PV_COLORS[actor], display: "inline-block" }} />
            <b>{actor}</b>
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ color: "var(--ink-muted)" }}>
                <th className="text-left font-normal px-3 py-1.5">Leg</th>
                <th className="text-right font-normal px-3 py-1.5">Start</th>
                <th className="text-right font-normal px-3 py-1.5">End</th>
                <th className="text-right font-normal px-3 py-1.5">Sessions</th>
                <th className="text-right font-normal px-3 py-1.5">OI start</th>
                <th className="text-right font-normal px-3 py-1.5">OI end</th>
                <th className="text-right font-normal px-3 py-1.5">Avg price</th>
                <th className="text-right font-normal px-3 py-1.5">Spread</th>
              </tr>
            </thead>
            <tbody>
              {cycles.legs[actor].map((leg) => (
                <LegRow key={`${actor}-${leg.startDate}-${leg.endDate}`} leg={leg} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="px-3 py-2 text-[10px]" style={{ borderTop: "1px solid var(--border)", background: "var(--surface-inset)", color: "var(--ink-muted)" }}>
        {cycles.validation.note}
      </div>
    </div>
  );
}
