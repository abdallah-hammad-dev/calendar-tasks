import { formatLocalDateTime, fromWall, parseLocal, wallClock } from "../ical/time";

export interface Busy {
  start: string;
  end: string;
}

/**
 * Free slots of at least `minutes` between `from` and `to` (local values), within working hours each day.
 * `busy` are timed occurrences (local values). All in the user's zone.
 */
export function freeSlots(
  busy: Busy[],
  opts: { from: string; to: string; minutes: number; dayStart: string; dayEnd: string; tz: string },
): Busy[] {
  const t = (local: string) => {
    const p = parseLocal(local)!;
    return fromWall(p.wall, opts.tz).getTime();
  };
  const [sh, sm] = opts.dayStart.split(":").map(Number) as [number, number];
  const [eh, em] = opts.dayEnd.split(":").map(Number) as [number, number];
  const intervals = busy.map((b) => [t(b.start), t(b.end)] as const).sort((a, b) => a[0] - b[0]);
  const out: Busy[] = [];
  const end = t(opts.to);
  let day = parseLocal(opts.from)!.wall;
  for (let guard = 0; guard < 400; guard++) {
    const dayStart = Math.max(fromWall({ ...day, hour: sh, minute: sm, second: 0 }, opts.tz).getTime(), t(opts.from));
    const dayEnd = Math.min(fromWall({ ...day, hour: eh, minute: em, second: 0 }, opts.tz).getTime(), end);
    let cursor = dayStart;
    for (const [s, e] of intervals) {
      if (e <= cursor || s >= dayEnd) continue;
      if (s - cursor >= opts.minutes * 60_000) out.push({ start: local(cursor, opts.tz), end: local(s, opts.tz) });
      cursor = Math.max(cursor, e);
    }
    if (dayEnd - cursor >= opts.minutes * 60_000) out.push({ start: local(cursor, opts.tz), end: local(dayEnd, opts.tz) });
    const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
    day = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0 };
    if (fromWall(day, opts.tz).getTime() >= end) break;
  }
  return out;
}

function local(ms: number, tz: string): string {
  return formatLocalDateTime(wallClock(new Date(ms), tz));
}
