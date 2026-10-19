/**
 * Time zones without a bundled tz database: the platform's Intl knows the user's zone (desktop and mobile).
 * Local values are "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm" (wall-clock time in the user's zone), the same
 * strings Obsidian's date / datetime properties use.
 */

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of an instant in a zone. */
export function wallClock(date: Date, tz: string): Wall {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of a zone from UTC at an instant, in minutes (Paris in summer: +120). */
export function offsetMinutes(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at which a zone's clocks show `w`. */
export function fromWall(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - offsetMinutes(new Date(t), tz) * 60_000; // second pass settles DST edges
  return new Date(t);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatLocalDate(w: Pick<Wall, "year" | "month" | "day">): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

export function formatLocalDateTime(w: Wall): string {
  return `${formatLocalDate(w)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** Parses a local value ("2026-10-15" or "2026-10-15T14:00[:ss]"); null if it is neither. */
export function parseLocal(value: string): { allDay: true; wall: Wall } | { allDay: false; wall: Wall } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  const wall: Wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31 || wall.hour > 23 || wall.minute > 59) return null;
  return m[4] === undefined ? { allDay: true, wall } : { allDay: false, wall };
}

/** iCalendar basic format: 20261015 / 20261015T140000. */
export function icalDate(w: Pick<Wall, "year" | "month" | "day">): string {
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}`;
}

export function icalDateTime(w: Wall): string {
  return `${icalDate(w)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

interface Transition {
  at: number; // first instant of the new offset (ms)
  from: number;
  to: number;
}

function transitions(tz: string, year: number): Transition[] {
  const out: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1);
  let prev = offsetMinutes(new Date(t), tz);
  const DAY = 86_400_000;
  while (t < end) {
    const next = t + DAY;
    const off = offsetMinutes(new Date(next), tz);
    if (off !== prev) {
      // Narrow down to the minute.
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetMinutes(new Date(mid), tz) === prev) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: prev, to: off });
      prev = off;
    }
    t = next;
  }
  return out;
}

function observance(kind: "STANDARD" | "DAYLIGHT", tr: Transition): string[] {
  // Rule from the wall-clock time just before the change, in the old offset (e.g. last Sunday of March, 02:00).
  const local = new Date(tr.at + tr.from * 60_000);
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  const weekday = local.getUTCDay();
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
  const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
  // DTSTART: the same rule in 1970, so the zone also covers past dates.
  let d1970: number;
  if (nth === -1) {
    const last = new Date(Date.UTC(1970, month, 0));
    d1970 = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  } else {
    const first = new Date(Date.UTC(1970, month - 1, 1)).getUTCDay();
    d1970 = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  return [
    `BEGIN:${kind}`,
    `TZOFFSETFROM:${fmtOffset(tr.from)}`,
    `TZOFFSETTO:${fmtOffset(tr.to)}`,
    `DTSTART:1970${pad(month)}${pad(d1970)}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`,
    `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${DAYS[weekday]}`,
    `END:${kind}`,
  ];
}

/**
 * A VTIMEZONE for an IANA zone, from this year's rules (yearly DST rules as "nth / last weekday of a month",
 * which covers Europe and North America; zones without DST get a fixed offset). Lines without CRLF.
 */
export function vtimezoneLines(tz: string, year = new Date().getUTCFullYear()): string[] {
  const trs = transitions(tz, year);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  if (trs.length < 2) {
    const off = offsetMinutes(new Date(Date.UTC(year, 0, 1)), tz);
    lines.push("BEGIN:STANDARD", `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`);
    lines.push("DTSTART:19700101T000000", "END:STANDARD");
  } else {
    for (const tr of trs.slice(0, 2)) lines.push(...observance(tr.to > tr.from ? "DAYLIGHT" : "STANDARD", tr));
  }
  lines.push("END:VTIMEZONE");
  return lines;
}
