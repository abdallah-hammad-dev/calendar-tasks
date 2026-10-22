import ICAL from "ical.js";
import { BACKEND_PROP } from "../constants";
import { setDateProp, touch } from "../ical/write";
import { wallClock } from "../ical/time";
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
  /** RRULE value, for a session that comes back (`@session chaque mardi 14h-16h`). */
  rrule?: string | null;
}

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
  if (e.rrule) ev.updatePropertyWithValue("rrule", ICAL.Recur.fromString(e.rrule));
  touch(ev, now);
  return cal.toString();
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
      const local = instant.convertToZone(ICAL.TimezoneService.get(tzid));
      p.setValue(ICAL.Time.fromData({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, second: local.second }));
      p.setParameter("tzid", tzid);
    } else p.setValue(instant);
  }
  ex.addProperty(p);
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
}

/**
 * Changes an event in place, or one occurrence of a series (`rid`: an exception, as dragging does). Only the
 * fields given are written; alarms, attendees and unknown properties stay.
 */
export function editEvent(data: string, rid: string | null, edit: EventEdit, tz: string, now = new Date()): string {
  const { cal, master, events } = parse(data);
  const target = rid && master.hasProperty("rrule") ? occurrence(cal, master, events, rid) : master;
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
  bump(target, now);
  return cal.toString();
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
