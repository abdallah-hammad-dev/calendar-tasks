import ICAL from "ical.js";
import { PROTOCOL_ACTION, type Priority } from "../constants";
import { formatLocalDate, formatLocalDateTime, fromWall, isKnownZone, parseLocal, wallClock, type Wall } from "../ical/time";
import { setDateProp, touch } from "../ical/write";
import { normalizeRule } from "../editor/when";

/** The VTODO fields the extension owns (spec §4.1). Everything else in the item is left untouched. */
export interface TaskFields {
  summary: string;
  done: boolean;
  /** Local value: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in the user's zone; null = no due date. */
  due: string | null;
  categories: string[];
  parentUid: string | null;
  /** RRULE value ("FREQ=WEEKLY;BYDAY=MO"); null = doesn't repeat. */
  repeat: string | null;
  /** `PRIORITY` in three levels, as Reminders shows it; null = none. */
  priority: Priority | null;
  /** `COMPLETED` (when it was ticked) as a local "YYYY-MM-DDTHH:mm"; null = none. Only while done. */
  completed: string | null;
}

export interface ReadTask extends TaskFields {
  uid: string;
  /** `CREATED` as a local "YYYY-MM-DDTHH:mm"; null when the item has none. Read only. */
  created: string | null;
  /** DESCRIPTION without our link line. */
  notes: string;
  url: string | null;
  /** Our link line is the last line of DESCRIPTION. */
  hasLinkLine: boolean;
}

export interface WriteOptions {
  /** The user's IANA zone, for timed due dates. */
  tz: string;
  /** Our `obsidian://` link: set as URL and (if `linkInNotes`) as the last line of DESCRIPTION. */
  link?: string;
  linkInNotes?: boolean;
  now?: Date;
}

/** `obsidian://calendar-tasks?vault=…&uid=…` */
export function taskLink(vault: string, uid: string): string {
  return `obsidian://${PROTOCOL_ACTION}?vault=${encodeURIComponent(vault)}&uid=${encodeURIComponent(uid)}`;
}

const isOurLink = (line: string) => line.trim().startsWith(`obsidian://${PROTOCOL_ACTION}?`);

type Comp = InstanceType<typeof ICAL.Component>;
type Prop = InstanceType<typeof ICAL.Property>;

function parse(data: string): { cal: Comp; todo: Comp } | null {
  try {
    const cal = new ICAL.Component(ICAL.parse(data) as unknown[]);
    const todo = cal.getFirstSubcomponent("vtodo");
    return todo ? { cal, todo } : null;
  } catch {
    return null;
  }
}

/** Reads a DATE / DATE-TIME property as a local value in `tz`. */
function readLocal(prop: Prop | null, cal: Comp, tz: string): string | null {
  if (!prop) return null;
  const v = prop.getFirstValue();
  if (!(v instanceof ICAL.Time)) return null;
  if (v.isDate) return formatLocalDate(v);
  const fields: Wall = { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second };
  const tzid = prop.getParameter("tzid");
  let instant: Date | null = null;
  if (v.zone === ICAL.Timezone.utcTimezone) instant = v.toJSDate();
  else if (typeof tzid === "string" && isKnownZone(tzid)) instant = fromWall(fields, tzid);
  else if (typeof tzid === "string") {
    // Non-IANA TZID (e.g. Outlook's "Romance Standard Time"): use the item's own VTIMEZONE.
    const vtz = cal.getAllSubcomponents("vtimezone").find((z) => z.getFirstPropertyValue("tzid") === tzid);
    if (vtz) {
      const t = v.clone();
      t.zone = new ICAL.Timezone(vtz);
      instant = new Date(t.toUnixTime() * 1000);
    }
  }
  return formatLocalDateTime(instant ? wallClock(instant, tz) : fields); // floating: wall clock as written
}

export function readTask(data: string, tz: string): ReadTask | null {
  const parsed = parse(data);
  if (!parsed) return null;
  const { cal, todo } = parsed;
  const uid = todo.getFirstPropertyValue("uid");
  if (typeof uid !== "string" || !uid) return null;
  const status = String(todo.getFirstPropertyValue("status") ?? "").toUpperCase();
  const percent = Number(todo.getFirstPropertyValue("percent-complete") ?? 0);
  const description = String(todo.getFirstPropertyValue("description") ?? "");
  const lines = description.split("\n");
  const hasLinkLine = lines.length > 0 && isOurLink(lines[lines.length - 1] ?? "");
  const parent = todo
    .getAllProperties("related-to")
    .find((p) => String(p.getParameter("reltype") ?? "PARENT").toUpperCase() === "PARENT");
  const url = todo.getFirstPropertyValue("url");
  return {
    uid,
    summary: String(todo.getFirstPropertyValue("summary") ?? "").trim(),
    done: status === "COMPLETED" || percent >= 100 || todo.hasProperty("completed"),
    due: readLocal(todo.getFirstProperty("due"), cal, tz),
    created: readLocal(todo.getFirstProperty("created"), cal, tz),
    completed: readLocal(todo.getFirstProperty("completed"), cal, tz),
    categories: todo.getAllProperties("categories").flatMap((p) => p.getValues().map((c) => String(c).trim())).filter(Boolean),
    parentUid: parent ? String(parent.getFirstValue()) : null,
    repeat: readRule(todo),
    priority: readPriority(todo),
    notes: lines.filter((l) => !isOurLink(l)).join("\n").trim(),
    url: typeof url === "string" ? url : null,
    hasLinkLine,
  };
}

function readRule(todo: Comp): string | null {
  const v = todo.getFirstPropertyValue("rrule");
  return v instanceof ICAL.Recur ? normalizeRule(v.toString()) : null;
}

/** RFC 5545 §3.8.1.9: 1–4 high, 5 medium, 6–9 low, 0 (or none) undefined. */
function readPriority(todo: Comp): Priority | null {
  const v = Number(todo.getFirstPropertyValue("priority") ?? 0);
  return v >= 1 && v <= 4 ? "high" : v === 5 ? "medium" : v >= 6 && v <= 9 ? "low" : null;
}

/** What Reminders writes for each level. */
const PRIORITY_VALUE: Record<Priority, number> = { high: 1, medium: 5, low: 9 };

function utcStamp(now: Date): InstanceType<typeof ICAL.Time> {
  return ICAL.Time.fromJSDate(now, true);
}

function setText(todo: Comp, name: string, value: string | null): void {
  if (value === null || value === "") todo.removeAllProperties(name);
  else todo.updatePropertyWithValue(name, value);
}

function setDue(cal: Comp, todo: Comp, due: string | null, tz: string): void {
  // iOS writes DTSTART = DUE (it shows DTSTART as the reminder's date); we do the same.
  setDateProp(cal, todo, "dtstart", due, tz);
  setDateProp(cal, todo, "due", due, tz);
}

function applyFields(cal: Comp, todo: Comp, changes: Partial<TaskFields>, opts: WriteOptions): void {
  const now = opts.now ?? new Date();
  if (changes.summary !== undefined) setText(todo, "summary", changes.summary);
  if (changes.done !== undefined) {
    if (changes.done) {
      todo.updatePropertyWithValue("status", "COMPLETED");
      todo.updatePropertyWithValue("percent-complete", 100);
      if (!todo.hasProperty("completed")) todo.updatePropertyWithValue("completed", utcStamp(now));
    } else {
      todo.updatePropertyWithValue("status", "NEEDS-ACTION");
      todo.removeAllProperties("percent-complete");
    }
  }
  // When it was ticked: the note's time (UTC, as RFC 5545 wants), gone while it isn't done.
  if (changes.done === false) todo.removeAllProperties("completed");
  else if (changes.completed) {
    const p = parseLocal(changes.completed);
    if (p) todo.updatePropertyWithValue("completed", utcStamp(fromWall(p.wall, opts.tz)));
  }
  if (changes.due !== undefined) setDue(cal, todo, changes.due, opts.tz);
  if (changes.repeat !== undefined && changes.repeat !== readRule(todo)) {
    todo.removeAllProperties("rrule");
    // A rule needs a start (DTSTART, = DUE as iOS writes it); without a due date the repetition stays in the note.
    const due = todo.getFirstProperty("due");
    if (changes.repeat && !todo.hasProperty("dtstart") && due) {
      todo.addProperty(ICAL.Property.fromString(due.toICALString().replace(/^DUE/i, "DTSTART")));
    }
    if (changes.repeat && todo.hasProperty("dtstart")) todo.addPropertyWithValue("rrule", ICAL.Recur.fromString(changes.repeat));
  }
  // Only when the level changes: a 2 written elsewhere stays a 2 while it reads "high".
  if (changes.priority !== undefined && changes.priority !== readPriority(todo)) {
    if (changes.priority) todo.updatePropertyWithValue("priority", PRIORITY_VALUE[changes.priority]);
    else todo.removeAllProperties("priority");
  }
  if (changes.categories !== undefined) {
    todo.removeAllProperties("categories");
    if (changes.categories.length) {
      const p = new ICAL.Property("categories", todo);
      p.setValues(changes.categories);
      todo.addProperty(p);
    }
  }
  if (changes.parentUid !== undefined) {
    for (const p of todo.getAllProperties("related-to")) {
      if (String(p.getParameter("reltype") ?? "PARENT").toUpperCase() === "PARENT") todo.removeProperty(p);
    }
    if (changes.parentUid) {
      const p = new ICAL.Property("related-to", todo);
      p.setValue(changes.parentUid);
      p.setParameter("reltype", "PARENT");
      todo.addProperty(p);
    }
  }
  if (opts.link) {
    if (todo.getFirstPropertyValue("url") !== opts.link) {
      todo.removeAllProperties("url");
      const p = new ICAL.Property("url", todo);
      p.setValue(opts.link);
      todo.addProperty(p);
    }
    const lines = String(todo.getFirstPropertyValue("description") ?? "")
      .split("\n")
      .filter((l) => !isOurLink(l));
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (opts.linkInNotes) lines.push(...(lines.length ? ["", opts.link] : [opts.link]));
    setText(todo, "description", lines.join("\n"));
  }
  touch(todo, now);
}

/** Changes the given fields of a VTODO in place: unknown properties, alarms and time zones are kept. */
export function writeTask(data: string, changes: Partial<TaskFields>, opts: WriteOptions): string {
  const parsed = parse(data);
  if (!parsed) throw new Error("Not a VTODO");
  applyFields(parsed.cal, parsed.todo, changes, opts);
  return parsed.cal.toString();
}

/** `created`: when the task was made (default: now), written as `CREATED`. */
export function newTask(uid: string, fields: TaskFields, opts: WriteOptions, created = opts.now ?? new Date()): string {
  const cal = new ICAL.Component("vcalendar");
  cal.updatePropertyWithValue("version", "2.0");
  cal.updatePropertyWithValue("prodid", "-//calendar-tasks//Obsidian//EN");
  const todo = new ICAL.Component("vtodo", cal);
  todo.updatePropertyWithValue("uid", uid);
  todo.updatePropertyWithValue("created", utcStamp(created));
  cal.addSubcomponent(todo);
  applyFields(cal, todo, fields, opts);
  return cal.toString();
}

/** True if two field sets are equal on every owned field. */
export function sameFields(a: TaskFields, b: TaskFields): boolean {
  return (
    a.summary === b.summary &&
    a.done === b.done &&
    a.due === b.due &&
    a.parentUid === b.parentUid &&
    a.repeat === b.repeat &&
    a.priority === b.priority &&
    a.completed === b.completed &&
    a.categories.length === b.categories.length &&
    a.categories.every((c, i) => c === b.categories[i])
  );
}

