import ICAL from "ical.js";
import { BACKEND_PROP } from "../constants";
import { setDateProp, touch } from "../ical/write";
import { formatLocalDate, formatLocalDateTime, wallClock } from "../ical/time";
import { ruleForItem, ruleFromItem, untilOf, withUntil } from "../editor/when";
import { registerZones, ridOf } from "../ical/zones";

type Comp = InstanceType<typeof ICAL.Component>;

export interface NewEvent {
  summary: string;
  /** Local values; `end` is exclusive. */
  start: string;
  end: string;
  location?: string | null;
  /** UID of the task this is a work session for (spec §4.4). */
  relatedTo?: string | null;
  /** RRULE value, ours (UNTIL a date: the last day), for an event that comes back. */
  rrule?: string | null;
}

type Time = InstanceType<typeof ICAL.Time>;

export type PartStat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

const address = (v: unknown) => (typeof v === "string" ? v : "").replace(/^mailto:/i, "").trim().toLowerCase();

function parse(data: string): { cal: Comp; master: Comp; events: Comp[] } {
  const cal = new ICAL.Component(ICAL.parse(data) as unknown[]);
  const events = cal.getAllSubcomponents("vevent");
  const master = events.find((e) => !e.hasProperty("recurrence-id")) ?? events[0];
  if (!master) throw new Error("Not a VEVENT");
  registerZones(cal);
  return { cal, master, events };
}

function bump(comp: Comp, now: Date): void {
  const seq = Number(comp.getFirstPropertyValue("sequence") ?? 0);
  comp.updatePropertyWithValue("sequence", (Number.isFinite(seq) ? seq : 0) + 1);
  touch(comp, now);
}

const MIRROR_LINE = new RegExp(`\\r?\\n${BACKEND_PROP.sourceAccount}[;:]`, "i");

/** Events copied from an external account by the backend: only my answer may change (spec §4.6). */
export function isMirror(data: string): boolean {
  return MIRROR_LINE.test(data);
}

export function newEvent(uid: string, e: NewEvent, tz: string, now = new Date()): string {
  const cal = new ICAL.Component("vcalendar");
  cal.updatePropertyWithValue("version", "2.0");
  cal.updatePropertyWithValue("prodid", "-//calendar-tasks//Obsidian//EN");
  const ev = new ICAL.Component("vevent", cal);
  ev.updatePropertyWithValue("uid", uid);
  ev.updatePropertyWithValue("created", ICAL.Time.fromJSDate(now, true));
  ev.updatePropertyWithValue("summary", e.summary);
  cal.addSubcomponent(ev);
  setDateProp(cal, ev, "dtstart", e.start, tz);
  setDateProp(cal, ev, "dtend", e.end, tz);
  if (e.location) ev.updatePropertyWithValue("location", e.location);
  if (e.relatedTo) ev.updatePropertyWithValue("related-to", e.relatedTo);
  if (e.rrule) ev.updatePropertyWithValue("rrule", ICAL.Recur.fromString(ruleForItem(e.rrule, e.start.length === 10, tz)));
  touch(ev, now);
  return cal.toString();
}

/** A series' rule, ours (its last day a date in `tz`); null for an event that doesn't come back. */
export function seriesRule(data: string, tz: string): string | null {
  const { master } = parse(data);
  const rule = master.getFirstPropertyValue("rrule");
  return rule instanceof ICAL.Recur ? ruleFromItem(rule.toString(), tz) : null;
}

/** A time as a local value in `tz` ("2026-10-19T08:00", or a day). */
function localOf(t: Time, tz: string): string {
  if (t.isDate) return formatLocalDate(t);
  return formatLocalDateTime(wallClock(t.toJSDate(), tz));
}

/** The component for one occurrence: an existing exception, or a new one cloned from the series. */
function occurrence(cal: Comp, master: Comp, events: Comp[], rid: string): Comp {
  const existing = events.find((e) => e !== master && e.hasProperty("recurrence-id") && ridOf(e.getFirstPropertyValue("recurrence-id") as InstanceType<typeof ICAL.Time>) === rid);
  if (existing) return existing;
  const ex = new ICAL.Component(structuredClone(master.toJSON()) as unknown[]);
  for (const name of ["rrule", "rdate", "exdate", "recurrence-id"]) ex.removeAllProperties(name);
  // RECURRENCE-ID in the same form as the series' DTSTART (same zone, or date).
  const dtstart = master.getFirstProperty("dtstart")!;
  const start = dtstart.getFirstValue() as InstanceType<typeof ICAL.Time>;
  const p = new ICAL.Property("recurrence-id", ex);
  if (start.isDate) {
    p.resetType("date");
    p.setValue(ICAL.Time.fromDateString(`${rid.slice(0, 4)}-${rid.slice(4, 6)}-${rid.slice(6, 8)}`));
  } else {
    const instant = ICAL.Time.fromDateTimeString(rid.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    const tzid = dtstart.getParameter("tzid");
    if (typeof tzid === "string" && ICAL.TimezoneService.has(tzid)) {
      // In its zone, not floating: read back as a floating time, it would be the machine's time (CI is in UTC).
      const zone = ICAL.TimezoneService.get(tzid);
      const local = instant.convertToZone(zone);
      p.setValue(ICAL.Time.fromData({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, second: local.second }, zone));
      p.setParameter("tzid", tzid);
    } else p.setValue(instant);
  }
  ex.addProperty(p);
  // It takes place where it falls, for as long as the series' events (the clone had the series' first times:
  // 2026-11-04, a title changed on one occurrence moved it to the series' first day).
  const at = p.getFirstValue() as Time;
  const startProp = ex.getFirstProperty("dtstart")!;
  const endProp = ex.getFirstProperty("dtend");
  const end = endProp ? (endProp.getFirstValue() as Time) : null;
  const length = end ? end.subtractDate(start) : null;
  startProp.setValue(at.clone());
  if (endProp && length) {
    const e = at.clone();
    e.addDuration(length);
    endProp.setValue(e);
  }
  cal.addSubcomponent(ex);
  return ex;
}

/** What the event form changes; what's left out stays as it is. */
export interface EventEdit {
  summary?: string;
  /** Local values; `end` is exclusive. */
  start?: string;
  end?: string;
  /** The place; null or "": none. */
  location?: string | null;
  /** The task it's a work session for; null: none (a plain event). */
  relatedTo?: string | null;
  /**
   * How it comes back, ours (UNTIL: the last day); null: it doesn't. The series' rule, even from one occurrence.
   * Another pattern drops the series' exceptions; another last day those after it. Taken off a series from one
   * occurrence: that occurrence, as edited, is the event left.
   */
  repeat?: string | null;
}

/**
 * Changes an event in place, or one occurrence of a series (`rid`: an exception, as dragging does). Only the
 * fields given are written; alarms, attendees and unknown properties stay.
 */
export function editEvent(data: string, rid: string | null, edit: EventEdit, tz: string, now = new Date()): string {
  const { cal, master, events } = parse(data);
  const old = master.getFirstPropertyValue("rrule");
  const before = old instanceof ICAL.Recur ? ruleFromItem(old.toString(), tz) : null;
  const pattern = (r: string | null) => (r ? withUntil(r, null) : null);
  const newPattern = edit.repeat !== undefined && pattern(edit.repeat) !== pattern(before);
  let target = rid && before ? occurrence(cal, master, events, rid) : master;
  // Another pattern is the series' change: this occurrence's move moves the whole series by as much.
  if (newPattern && edit.repeat && target !== master) {
    edit = shiftSeries(master, target, edit, tz);
    cal.removeSubcomponent(target);
    target = master;
  }
  applyEdit(cal, target, edit, tz);
  if (edit.repeat === null && before) {
    // One event left: the one edited, without its series.
    for (const name of ["rrule", "rdate", "exdate", "recurrence-id"]) target.removeAllProperties(name);
    for (const ev of cal.getAllSubcomponents("vevent")) if (ev !== target) cal.removeSubcomponent(ev);
  } else if (edit.repeat && edit.repeat !== before) {
    const start = master.getFirstPropertyValue("dtstart") as Time;
    master.removeAllProperties("rrule");
    master.addPropertyWithValue("rrule", ICAL.Recur.fromString(ruleForItem(edit.repeat, start.isDate, tz)));
    if (newPattern) {
      // Its exceptions and removed days were days of the old pattern.
      for (const name of ["rdate", "exdate"]) master.removeAllProperties(name);
      for (const ev of cal.getAllSubcomponents("vevent")) if (ev !== master) cal.removeSubcomponent(ev);
    } else {
      const last = untilOf(edit.repeat);
      const end = last ? formatLocalDate(last) : null;
      for (const ev of cal.getAllSubcomponents("vevent")) {
        const rec = ev.getFirstPropertyValue("recurrence-id");
        if (ev !== master && end && rec instanceof ICAL.Time && localOf(rec, tz).slice(0, 10) > end) cal.removeSubcomponent(ev);
      }
    }
    if (target !== master) bump(master, now);
  } else if (edit.start !== undefined && target === master && before && untilOf(before)) {
    // A whole day now, or timed: UNTIL takes DTSTART's form.
    const start = master.getFirstPropertyValue("dtstart") as Time;
    master.updatePropertyWithValue("rrule", ICAL.Recur.fromString(ruleForItem(before, start.isDate, tz)));
  }
  bump(target, now);
  return cal.toString();
}

/** A local value as a number to add to (wall-clock arithmetic: no zone, no daylight saving), and back. */
const wallMs = (v: string) =>
  Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), v.length > 10 ? +v.slice(11, 13) : 0, v.length > 10 ? +v.slice(14, 16) : 0);
function wallValue(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  const w = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 };
  return allDay ? formatLocalDate(w) : formatLocalDateTime(w);
}

/**
 * An occurrence's new times as the series': its first start moved by as much as the occurrence was, with the
 * occurrence's new length. From timed to whole days or back: the occurrence's time on the series' first day.
 */
function shiftSeries(master: Comp, occ: Comp, edit: EventEdit, tz: string): EventEdit {
  if (edit.start === undefined) return edit;
  const was = localOf(occ.getFirstPropertyValue("recurrence-id") as Time, tz);
  const first = localOf(master.getFirstPropertyValue("dtstart") as Time, tz);
  const allDay = edit.start.length === 10;
  const start = was.length === edit.start.length ? wallMs(first) + wallMs(edit.start) - wallMs(was) : wallMs(first.slice(0, 10) + edit.start.slice(10));
  const out: EventEdit = { ...edit, start: wallValue(start, allDay) };
  if (edit.end !== undefined) out.end = wallValue(start + wallMs(edit.end) - wallMs(edit.start), allDay);
  return out;
}

/** Writes the form's fields on one component (the series, or one occurrence). */
function applyEdit(cal: Comp, target: Comp, edit: EventEdit, tz: string): void {
  if (edit.summary !== undefined) target.updatePropertyWithValue("summary", edit.summary);
  if (edit.start !== undefined) setDateProp(cal, target, "dtstart", edit.start, tz);
  if (edit.end !== undefined) {
    setDateProp(cal, target, "dtend", edit.end, tz);
    target.removeAllProperties("duration");
  }
  if (edit.location !== undefined) {
    if (edit.location) target.updatePropertyWithValue("location", edit.location);
    else target.removeAllProperties("location");
  }
  if (edit.relatedTo !== undefined) {
    // The calendar reads the first RELATED-TO as the session's task: it takes the new one (its parameters kept).
    // None: every one goes, or the event would still read as a session.
    const first = target.getFirstProperty("related-to");
    if (!edit.relatedTo) target.removeAllProperties("related-to");
    else if (first) first.setValue(edit.relatedTo);
    else target.addPropertyWithValue("related-to", edit.relatedTo);
  }
}

/** Moves (or resizes) an event, or one occurrence of a series (`rid`), to new local start / end values. */
export function moveEvent(data: string, rid: string | null, start: string, end: string, tz: string, now = new Date()): string {
  return editEvent(data, rid, { start, end }, tz, now);
}

export function renameEvent(data: string, rid: string | null, summary: string, now = new Date()): string {
  return editEvent(data, rid, { summary }, "UTC", now);
}

/** Removes one occurrence of a series (EXDATE in the series' DTSTART form, and no exception left). */
export function cancelOccurrence(data: string, rid: string, now = new Date()): string {
  const { cal, master, events } = parse(data);
  const ex = occurrence(cal, master, events, rid);
  const rec = ex.getFirstProperty("recurrence-id")!;
  const exdate = new ICAL.Property("exdate", master);
  const value = rec.getFirstValue() as InstanceType<typeof ICAL.Time>;
  if (value.isDate) exdate.resetType("date");
  exdate.setValue(value);
  const tzid = rec.getParameter("tzid");
  if (typeof tzid === "string") exdate.setParameter("tzid", tzid);
  master.addProperty(exdate);
  cal.removeSubcomponent(ex);
  bump(master, now);
  return cal.toString();
}

/**
 * Stops a work session that comes back for a task now done: the series ends now (its past sessions stay), or
 * `"delete"` when it hasn't started. Null when it isn't a series for that task, or has already ended.
 */
export function endSeries(data: string, taskUid: string, tz: string, now = new Date()): { data: string } | "delete" | null {
  const { cal, master } = parse(data);
  if (master.getFirstPropertyValue("related-to") !== taskUid) return null;
  const prop = master.getFirstProperty("rrule");
  const rule = prop?.getFirstValue() as InstanceType<typeof ICAL.Recur> | undefined;
  if (!prop || !rule) return null;
  const start = master.getFirstPropertyValue("dtstart") as InstanceType<typeof ICAL.Time> | null;
  if (!start) return null;
  if (start.toJSDate().getTime() > now.getTime()) return "delete";
  if (rule.until && rule.until.toJSDate().getTime() <= now.getTime()) return null;
  // UNTIL takes the form of DTSTART: a date for all-day sessions, else UTC (RFC 5545 §3.3.10).
  const w = wallClock(now, tz);
  rule.until = start.isDate ? ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, isDate: true }) : ICAL.Time.fromJSDate(now, true);
  delete (rule as { count?: number }).count;
  prop.setValue(rule);
  bump(master, now);
  return { data: cal.toString() };
}

/**
 * My answer to an invitation, for the whole event (series and exceptions). Null if I'm not an attendee.
 * The backend relays it to the provider; nothing else in the event changes (spec §4.6), except the backend's
 * X-CALTASKS-RSVP-STATE when the answer changes: it told how the previous answer went, and the backend writes it again.
 */
export function setPartstat(data: string, me: string[], partstat: PartStat, now = new Date()): string | null {
  const { cal, events } = parse(data);
  const mine = new Set(me);
  let found = false;
  for (const ev of events) {
    const declared = ev.getFirstPropertyValue(BACKEND_PROP.sourceAttendee);
    const set = declared ? new Set([...mine, address(declared)]) : mine;
    let mineHere = false;
    let changed = false;
    for (const att of ev.getAllProperties("attendee")) {
      if (!set.has(address(att.getFirstValue()))) continue;
      if (String(att.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase() !== partstat) changed = true;
      att.setParameter("partstat", partstat);
      att.removeParameter("rsvp");
      mineHere = true;
    }
    if (!mineHere) continue;
    found = true;
    if (changed) ev.removeAllProperties(BACKEND_PROP.rsvpState);
    touch(ev, now);
  }
  return found ? cal.toString() : null;
}
