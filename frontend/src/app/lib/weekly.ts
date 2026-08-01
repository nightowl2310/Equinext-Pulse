// ─────────────────────────────────────────────────────────────────────────────
// Weekday-over-weekday comparison maths.
//
// Pure and framework-free, like `series.ts` — this module decides WHAT is being
// compared; the component only draws it.
//
// It reads the FULL archive (participants_vs_nifty.json, 2,600+ sessions back to
// 2016) rather than the old tuesday_summary.json, which only ever held the last
// 12 Tuesdays and so could not answer "compare a date I choose". Working from
// the archive also makes the weekday a CHOICE instead of a hard-coded Tuesday.
//
// ── The one structural fact everything here is built around ──────────────────
// The four participants' net books sum to EXACTLY zero, every single session
// (verified across the whole archive: max deviation 1 contract). Every long is
// somebody's short. Two consequences the UI must respect:
//
//   1. A "net" reading of all four is a COMPOSITION — who currently owns the
//      long side — not four independent measurements. Drawing it as four
//      crossing lines invites reading FII-vs-Client divergence as confirmation
//      when it is an accounting identity (their net levels correlate −0.92).
//      Stacked-around-zero is the honest encoding.
//   2. A "delta" reading is a TRANSFER — the four changes also sum to zero, so
//      one participant's buying IS another's selling.
// ─────────────────────────────────────────────────────────────────────────────

import { type ParticipantSeries, type ParticipantsData } from "./series";

/** Table/legend order — smart money first, retail last. Never re-sorted, so a
 *  participant keeps its row between dates. */
export const WC_ORDER = ["FII", "DII", "Pro", "Client"] as const;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Net level, or the weekday-over-weekday change in it. Drives the charts only —
 *  the table shows both at once, which is the one thing a table does better. */
export type WeeklyMode = "net" | "delta";

export const WC_MODES: { key: WeeklyMode; label: string }[] = [
  { key: "net", label: "Net position" },
  { key: "delta", label: "Δ vs previous" },
];

/**
 * `inverted` marks the leg where a RISING net position is bearish: buying puts
 * is a bet on a fall. Same convention the dossier and §4 already use.
 */
export const WC_INSTRUMENTS: {
  key: keyof ParticipantSeries;
  label: string;
  short: string;
  inverted: boolean;
}[] = [
  { key: "futures", label: "Index Futures", short: "futures", inverted: false },
  { key: "calls", label: "Index Calls", short: "calls", inverted: false },
  { key: "puts", label: "Index Puts", short: "puts", inverted: true },
];

/** How many occurrences the history chart and table show. */
export const WC_HISTORY = 12;

export interface WeeklyRow {
  /** index into the full archive — the anchor session */
  idx: number;
  date: string;
  display: string;
  /** the previous occurrence of the same weekday that actually has data */
  prevIdx: number | null;
  prevDate: string | null;
  prevDisplay: string | null;
  /**
   * ACTUAL trading sessions between the two dates. A holiday-shortened or
   * skipped week is not 5, and the UI prints this so a 10-session "week" can
   * never masquerade as a normal one.
   */
  sessionGap: number | null;
  expiry: boolean;
  nifty: number | null;
  niftyPrev: number | null;
  net: Record<string, number | null>;
  delta: Record<string, number | null>;
  /** biggest |Δ| that week — descriptive, no directional claim */
  mover: string | null;
}

const num = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

/**
 * The weekday the view should open on: the weekday of the most recent session
 * in the archive.
 *
 * Deliberately the LATEST SESSION rather than the wall clock. Participant OI is
 * published after the close, so on a Friday morning the newest row is still
 * Thursday's — keying off `new Date()` would open on Friday and show a week-old
 * comparison while fresher Thursday data sat unused. Keying off the data means
 * the view always opens on the newest comparison that actually exists, and
 * rolls forward on its own as each session lands.
 */
export function latestWeekday(data: ParticipantsData): Weekday {
  for (let i = data.dates.length - 1; i >= 0; i--) {
    const d = data.day[i];
    if ((WEEKDAYS as readonly string[]).includes(d)) return d as Weekday;
  }
  return "Tuesday";
}

/** Every archive index whose weekday matches, oldest first. */
export function occurrencesOf(data: ParticipantsData, weekday: Weekday): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.dates.length; i++) if (data.day[i] === weekday) out.push(i);
  return out;
}

/**
 * Build one comparison row per occurrence, each against the PREVIOUS occurrence
 * of the same weekday. `prev` is looked up in the full occurrence list, not the
 * visible slice, so the oldest row on screen still has a real Δ instead of a
 * null that would silently read as "no change".
 */
export function buildWeeklyRows(
  data: ParticipantsData,
  weekday: Weekday,
  field: keyof ParticipantSeries,
  anchorIdx: number,
  count: number,
): WeeklyRow[] {
  const occ = occurrencesOf(data, weekday);
  const anchorPos = occ.lastIndexOf(anchorIdx) >= 0
    ? occ.lastIndexOf(anchorIdx)
    : occ.reduce((best, v, k) => (v <= anchorIdx ? k : best), -1);
  if (anchorPos < 0) return [];

  const from = Math.max(0, anchorPos - count + 1);
  const rows: WeeklyRow[] = [];
  for (let k = from; k <= anchorPos; k++) {
    const i = occ[k];
    const prevIdx = k > 0 ? occ[k - 1] : null;
    const net: Record<string, number | null> = {};
    const delta: Record<string, number | null> = {};
    let mover: string | null = null;
    let best = -1;
    for (const p of WC_ORDER) {
      const s = data.participants[p]?.[field] as (number | null)[] | undefined;
      const v = s?.[i] ?? null;
      const pv = prevIdx === null ? null : (s?.[prevIdx] ?? null);
      net[p] = num(v) ? v : null;
      const d = num(v) && num(pv) ? v - pv : null;
      delta[p] = d;
      if (d !== null && Math.abs(d) > best) {
        best = Math.abs(d);
        mover = p;
      }
    }
    rows.push({
      idx: i,
      date: data.dates[i],
      display: data.dateDisplay[i],
      prevIdx,
      prevDate: prevIdx === null ? null : data.dates[prevIdx],
      prevDisplay: prevIdx === null ? null : data.dateDisplay[prevIdx],
      sessionGap: prevIdx === null ? null : i - prevIdx,
      expiry: !!data.expiry[i],
      nifty: data.nifty[i] ?? null,
      niftyPrev: prevIdx === null ? null : (data.nifty[prevIdx] ?? null),
      net,
      delta,
      mover,
    });
  }
  return rows;
}

/**
 * Where |value| ranks among EVERY historical weekday-over-weekday move for this
 * participant — the answer to "is this a big deal?", which a raw contract count
 * can never give. Computed over the whole archive, not the visible slice.
 */
export function movePercentile(
  data: ParticipantsData,
  weekday: Weekday,
  field: keyof ParticipantSeries,
  participant: string,
  value: number,
): number | null {
  const occ = occurrencesOf(data, weekday);
  const s = data.participants[participant]?.[field] as (number | null)[] | undefined;
  if (!s) return null;
  const mags: number[] = [];
  for (let k = 1; k < occ.length; k++) {
    const a = s[occ[k - 1]];
    const b = s[occ[k]];
    if (num(a) && num(b)) mags.push(Math.abs(b - a));
  }
  if (mags.length < 20) return null;
  const target = Math.abs(value);
  return (100 * mags.filter((m) => m <= target).length) / mags.length;
}

/**
 * How many consecutive occurrences (counting back from `anchorIdx`) this
 * participant's net has held the same sign. Persistence is genuinely
 * informative — a book held short for 14 straight weeks is a different fact
 * from one that flipped last week.
 */
export function signStreak(
  data: ParticipantsData,
  weekday: Weekday,
  field: keyof ParticipantSeries,
  participant: string,
  anchorIdx: number,
): { sign: number; weeks: number } | null {
  const occ = occurrencesOf(data, weekday).filter((i) => i <= anchorIdx);
  const s = data.participants[participant]?.[field] as (number | null)[] | undefined;
  if (!s || !occ.length) return null;
  const last = s[occ[occ.length - 1]];
  if (!num(last) || last === 0) return null;
  const sign = last > 0 ? 1 : -1;
  let weeks = 0;
  for (let k = occ.length - 1; k >= 0; k--) {
    const v = s[occ[k]];
    if (!num(v) || v === 0 || Math.sign(v) !== sign) break;
    weeks++;
  }
  return { sign, weeks };
}

export interface DiffEntry {
  participant: string;
  text: string;
}

/**
 * What is the SAME and what CHANGED between the two dates — the honest form of
 * a written summary. Every entry is a state fact (sign of the book, size of the
 * move against its own history), never a direction score: this project's own
 * validation log rejects every directional read of participant flow, and a
 * generated sentence is exactly where a dashboard starts over-claiming.
 */
export function stateDiff(
  data: ParticipantsData,
  weekday: Weekday,
  field: keyof ParticipantSeries,
  row: WeeklyRow,
): { same: DiffEntry[]; changed: DiffEntry[] } {
  const same: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  for (const p of WC_ORDER) {
    const now = row.net[p];
    const d = row.delta[p];
    if (!num(now)) continue;
    const then = num(d) ? now - d : null;
    const side = now >= 0 ? "long" : "short";

    if (num(then) && Math.sign(then) !== Math.sign(now) && then !== 0) {
      changed.push({
        participant: p,
        text: `flipped net ${side} (was net ${then >= 0 ? "long" : "short"})`,
      });
      continue;
    }

    const pct = num(d) ? movePercentile(data, weekday, field, p, d) : null;
    if (pct !== null && pct >= 90) {
      changed.push({
        participant: p,
        text: `moved harder than ${pct.toFixed(0)}% of its own weeks, still net ${side}`,
      });
      continue;
    }

    const streak = signStreak(data, weekday, field, p, row.idx);
    same.push({
      participant: p,
      text: streak && streak.weeks > 1 ? `net ${side} ${streak.weeks} weeks running` : `still net ${side}`,
    });
  }
  return { same, changed };
}

// ── formatting ───────────────────────────────────────────────────────────────

/** 171181 → "171k", -1_250_000 → "−1.3M". Table-width friendly. */
export function wcCompact(v: number | null | undefined): string {
  if (!num(v)) return "—";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}k`;
  return `${sign}${Math.round(a)}`;
}

/** Same, but a change — so positives carry an explicit +. */
export function wcSigned(v: number | null | undefined): string {
  if (!num(v)) return "—";
  if (v === 0) return "0";
  return (v > 0 ? "+" : "") + wcCompact(v);
}

/** "2026-07-21" → "21 Jul". */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function wcShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d} ${MON[+m - 1]}`;
}
