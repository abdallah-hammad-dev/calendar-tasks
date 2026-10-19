import ICAL from "ical.js";
import { formatLocalDate, formatLocalDateTime, parseLocal, vtimezoneLines } from "./time";

type Comp = InstanceType<typeof ICAL.Component>;

/** Adds a VTIMEZONE for `tz` (first in the calendar, like every client writes it) unless one exists. */
export function ensureVTimezone(cal: Comp, tz: string): void {
  if (cal.getAllSubcomponents("vtimezone").some((z) => z.getFirstPropertyValue("tzid") === tz)) return;
  const vtz = new ICAL.Component(ICAL.parse(`${vtimezoneLines(tz).join("\r\n")}\r\n`) as unknown[]);
  // getAllSubcomponents returns a live array: copy it.
  const comps = [...cal.getAllSubcomponents()];
  for (const c of comps) cal.removeSubcomponent(c);
  for (const c of [vtz, ...comps]) cal.addSubcomponent(c);
}

/**
 * Sets a DATE / DATE-TIME property from a local value: "YYYY-MM-DD" → VALUE=DATE, "YYYY-MM-DDTHH:mm" → TZID=tz
 * (never UTC: Apple Calendar would show a second "(GMT)" time). Null removes the property.
 */
export function setDateProp(cal: Comp, comp: Comp, name: string, local: string | null, tz: string): void {
  comp.removeAllProperties(name);
  const parsed = local ? parseLocal(local) : null;
  if (!parsed) return;
  const p = new ICAL.Property(name, comp);
  if (parsed.allDay) {
    p.resetType("date");
    p.setValue(ICAL.Time.fromDateString(formatLocalDate(parsed.wall)));
  } else if (tz === "UTC") {
    p.setValue(ICAL.Time.fromDateTimeString(`${formatLocalDateTime(parsed.wall)}:00Z`));
  } else {
    ensureVTimezone(cal, tz);
    p.setValue(ICAL.Time.fromDateTimeString(`${formatLocalDateTime(parsed.wall)}:00`));
    p.setParameter("tzid", tz);
  }
  comp.addProperty(p);
}

/** DTSTAMP / LAST-MODIFIED to now (UTC). */
export function touch(comp: Comp, now: Date): void {
  const stamp = ICAL.Time.fromJSDate(now, true);
  comp.updatePropertyWithValue("dtstamp", stamp);
  comp.updatePropertyWithValue("last-modified", stamp);
}
