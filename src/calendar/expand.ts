import ICAL from "ical.js";
import { BACKEND_PROP } from "../constants";
import { formatLocalDate, formatLocalDateTime, fromWall, parseLocal, wallClock } from "../ical/time";
import { registerZones, ridOf } from "../ical/zones";
import { readTask } from "../tasks/vtodo";
import { meetingOf, placeOf, type Meeting } from "./meeting";

export type OccurrenceKind = "event" | "deadline" | "timeblock";

/** One thing to draw in the calendar. Times are local values in the user's zone. */
export interface Occurrence {
  /** Stable per occurrence: item URL + recurrence id (or "#due"). */
  id: string;
  kind: OccurrenceKind;
  uid: string;
  /** Original start of this occurrence for recurring events, as RECURRENCE-ID matches it: "20261019T080000Z"
   * (UTC) or "20261019" (all-day). Null otherwise. */
  recurrenceId: string | null;
  itemUrl: string;
  calendarUrl: string;
  title: string;
  allDay: boolean;
  /** "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm". */
  start: string;
  /** Exclusive end, same format; null for deadlines. */
  end: string | null;
  /** The place, as written; null when it's only the meeting's link. */
  location: string | null;
  /** The video meeting to join (Teams, Zoom, Meet…), wherever the event keeps its link. */
  meeting: Meeting | null;
  recurring: boolean;
  /** Deadlines: the task is done. */
  done: boolean;
  /** Deadlines: the task itself; time blocks: the task they serve. */
  taskUid: string | null;
  /** Set when I'm an attendee (not the organizer). `relay`: the backend's X-RSVP-STATE (pending / confirmed /
   * failed:<reason>), if it wrote one. */
  invitation: { partstat: string; relay?: string } | null;
}

export interface ExpandOptions {
  from: Date;
  to: Date;
  tz: string;
  /** My addresses, lowercase, without mailto:. */
  me: string[];
}

const MAX_OCCURRENCES = 10_000;
type Comp = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

function toLocal(t: Time, tz: string): string {
  return t.isDate ? formatLocalDate(t) : formatLocalDateTime(wallClock(t.toJSDate(), tz));
}

function instant(local: string, tz: string): number {
  const p = parseLocal(local)!;
  return fromWall(p.allDay ? { ...p.wall, hour: 0, minute: 0, second: 0 } : p.wall, tz).getTime();
}

const address = (v: unknown) => (typeof v === "string" ? v : "").replace(/^mailto:/i, "").trim().toLowerCase();

function invitationOf(c: Comp, me: string[]): { partstat: string; relay?: string } | null {
  if (!c.hasProperty("organizer")) return null;
  const mine = new Set(me);
  const declared = c.getFirstPropertyValue(BACKEND_PROP.sourceAttendee);
  if (declared) mine.add(address(declared));
  if (mine.has(address(c.getFirstPropertyValue("organizer")))) return null;
  const att = c.getAllProperties("attendee").find((a) => mine.has(address(a.getFirstValue())));
  if (!att) return null;
  const partstat = String(att.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase();
  const relay = c.getFirstPropertyValue(BACKEND_PROP.rsvpState);
  return typeof relay === "string" && relay ? { partstat, relay } : { partstat };
}

/** Everything an item contributes to [from, to): event occurrences (recurrences expanded) or a task deadline. */
export function expandItem(itemUrl: string, calendarUrl: string, data: string, opts: ExpandOptions): Occurrence[] {
  let cal: Comp;
  try {
    cal = new ICAL.Component(ICAL.parse(data) as unknown[]);
  } catch {
    return [];
  }
  const from = opts.from.getTime();
  const to = opts.to.getTime();
  const out: Occurrence[] = [];

  const todo = cal.getFirstSubcomponent("vtodo");
  if (todo) {
    const task = readTask(data, opts.tz);
    if (task?.due) {
      const t = instant(task.due, opts.tz);
      const allDay = task.due.length === 10;
      if (t < to && (allDay ? t + 86_400_000 : t + 1) > from) {
        out.push({
          id: `${itemUrl}#due`,
          kind: "deadline",
          uid: task.uid,
          recurrenceId: null,
          itemUrl,
          calendarUrl,
          title: task.summary,
          allDay,
          start: task.due,
          end: null,
          location: null,
          meeting: null,
          recurring: !!task.repeat,
          done: task.done,
          taskUid: task.uid,
          invitation: null,
        });
      }
    }
    return out;
  }

  const parsed = parseEvent(cal);
  if (!parsed) return out;
  const { master, event } = parsed;
  const take = (o: Occurrence | null) => {
    if (!o) return;
    const s = instant(o.start, opts.tz);
    const e = Math.max(instant(o.end ?? o.start, opts.tz), s + 1);
    if (s < to && e > from) out.push(o);
  };

  if (!event.isRecurring()) {
    if (event.startDate) take(build(itemUrl, calendarUrl, event, master, event.startDate, event.endDate ?? event.startDate, null, opts));
    return out;
  }
  const it = event.iterator();
  for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
    if (next.toJSDate().getTime() >= to + 86_400_000) break;
    const d = event.getOccurrenceDetails(next);
    take(build(itemUrl, calendarUrl, event, d.item.component, d.startDate, d.endDate, ridOf(d.recurrenceId), opts));
  }
  return out;
}

/**
 * One occurrence of an event item: the event itself (rid null) or the occurrence whose RECURRENCE-ID is `rid`,
 * wherever it was moved to. Null if it doesn't exist (any more), was cancelled or declined (unless `declined`: an
 * event note still shows the answer, to change it).
 */
export function findOccurrence(
  itemUrl: string,
  calendarUrl: string,
  data: string,
  rid: string | null,
  opts: Pick<ExpandOptions, "tz" | "me"> & { declined?: boolean },
): Occurrence | null {
  let cal: Comp;
  try {
    cal = new ICAL.Component(ICAL.parse(data) as unknown[]);
  } catch {
    return null;
  }
  const parsed = parseEvent(cal);
  if (!parsed) return null;
  const { master, event } = parsed;
  if (!rid || !event.isRecurring()) {
    return event.startDate ? build(itemUrl, calendarUrl, event, master, event.startDate, event.endDate ?? event.startDate, null, opts) : null;
  }
  const target = /^\d{8}$/.test(rid) ? rid : Date.parse(rid.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  const it = event.iterator();
  for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
    if (typeof target === "number" && next.toJSDate().getTime() > target + 86_400_000) break;
    if (typeof target === "string" && ridOf(next).slice(0, 8) > target) break;
    if (ridOf(next) !== rid) continue;
    const d = event.getOccurrenceDetails(next);
    return build(itemUrl, calendarUrl, event, d.item.component, d.startDate, d.endDate, rid, opts);
  }
  return null;
}

function parseEvent(cal: Comp): { master: Comp; event: InstanceType<typeof ICAL.Event> } | null {
  const vevents = cal.getAllSubcomponents("vevent");
  if (!vevents.length) return null;
  registerZones(cal);
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0]!;
  const exceptions = vevents.filter((v) => v !== master && v.hasProperty("recurrence-id"));
  return { master, event: new ICAL.Event(master, { exceptions, strictExceptions: false }) };
}

function build(
  itemUrl: string,
  calendarUrl: string,
  event: InstanceType<typeof ICAL.Event>,
  comp: Comp,
  start: Time,
  end: Time,
  recurrenceId: string | null,
  opts: Pick<ExpandOptions, "tz" | "me"> & { declined?: boolean },
): Occurrence | null {
  if (String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return null;
  const invitation = invitationOf(comp, opts.me);
  if (invitation?.partstat === "DECLINED" && !opts.declined) return null; // declined invitations are hidden
  const startLocal = toLocal(start, opts.tz);
  let endLocal = toLocal(end, opts.tz);
  if (start.isDate && endLocal <= startLocal) {
    const d = start.clone();
    d.day += 1;
    endLocal = formatLocalDate(d);
  }
  const related = comp.getFirstPropertyValue("related-to");
  const meeting = meetingOf(comp);
  return {
    id: `${itemUrl}#${recurrenceId ?? ""}`,
    kind: related ? "timeblock" : "event",
    uid: event.uid,
    recurrenceId,
    itemUrl,
    calendarUrl,
    title: String(comp.getFirstPropertyValue("summary") ?? "").trim(),
    allDay: start.isDate,
    start: startLocal,
    end: endLocal,
    location: placeOf((comp.getFirstPropertyValue("location") as string | null) ?? null, meeting),
    meeting,
    recurring: event.isRecurring(),
    done: false,
    taskUid: related ? String(related) : null,
    invitation,
  };
}

/** The occurrence of a recurring event happening today, else the next one, else the last (spec §4.5). */
export function pickOccurrence(occurrences: Occurrence[], now: Date, tz: string): Occurrence | null {
  const today = formatLocalDate(wallClock(now, tz));
  const sorted = [...occurrences].sort((a, b) => a.start.localeCompare(b.start));
  return (
    sorted.find((o) => o.start.slice(0, 10) === today) ??
    sorted.find((o) => o.start.slice(0, 10) > today) ??
    sorted[sorted.length - 1] ??
    null
  );
}

/** Minutes since midnight of a local "YYYY-MM-DDTHH:mm" value (no zone needed: both sides are local). */
const minuteOf = (local: string) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));

/** The day after a "YYYY-MM-DD". */
function nextDay(day: string): string {
  const d = new Date(`${day}T12:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The days an occurrence is drawn on, first to last ("YYYY-MM-DD"; the end is exclusive, a midnight end too). */
function daysOf(o: Occurrence): string[] {
  const first = o.start.slice(0, 10);
  const last = o.end === null ? first : o.allDay || o.end.endsWith("T00:00") ? o.end.slice(0, 10) : nextDay(o.end.slice(0, 10));
  const days = [first];
  for (let day = nextDay(first); day < last; day = nextDay(day)) days.push(day);
  return days;
}

/**
 * How the month stacks a day's lines: 0 the bars (events all day or over several days), 1 deadlines all day, 2
 * work sessions all day (or over several days), 3 what has a time within the day (2026-10-20, asked: a little room
 * between what's all day and what has a time; a session all day sat among the day's tasks, sorted by title).
 */
export function monthGroup(o: Occurrence): number {
  if (!o.allDay && daysOf(o).length === 1) return 3;
  return o.kind === "event" ? 0 : o.kind === "deadline" ? 1 : 2;
}

/**
 * The month's lines that start a group under another one on their first day (they get a little room above). In
 * FullCalendar's order there: `monthGroup`, then start, longest first, title (the view's `eventOrder`).
 */
export function monthGroupStarts(occurrences: Occurrence[]): Set<string> {
  const byDay = new Map<string, Occurrence[]>();
  for (const o of occurrences) for (const day of daysOf(o)) byDay.set(day, [...(byDay.get(day) ?? []), o]);
  const length = (o: Occurrence) => (o.end ? new Date(o.end).getTime() - new Date(o.start).getTime() : 0);
  const starts = new Set<string>();
  for (const [day, list] of byDay) {
    list.sort((a, b) => monthGroup(a) - monthGroup(b) || a.start.localeCompare(b.start) || length(b) - length(a) || a.title.localeCompare(b.title));
    list.forEach((o, i) => {
      if (i > 0 && monthGroup(o) !== monthGroup(list[i - 1]!) && o.start.slice(0, 10) === day) starts.add(o.id);
    });
  }
  return starts;
}

/**
 * Timed deadlines in groups that can't be drawn apart: each group starts with a deadline, and takes the ones of the
 * same day less than `gapMinutes` after it (the height of its marker). Sorted by time, then title.
 */
export function closeDeadlines(deadlines: Occurrence[], gapMinutes = 20): Occurrence[][] {
  const sorted = [...deadlines].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  const groups: Occurrence[][] = [];
  for (const o of sorted) {
    const first = groups[groups.length - 1]?.[0];
    if (first && first.start.slice(0, 10) === o.start.slice(0, 10) && minuteOf(o.start) - minuteOf(first.start) < gapMinutes) {
      groups[groups.length - 1]!.push(o);
    } else groups.push([o]);
  }
  return groups;
}
