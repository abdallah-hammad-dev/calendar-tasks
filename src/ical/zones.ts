import ICAL from "ical.js";
import { isKnownZone, vtimezoneLines } from "./time";

type Comp = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

/** Makes every TZID an item uses known to ical.js: its own VTIMEZONEs, or one generated for IANA names. */
export function registerZones(cal: Comp): void {
  for (const vtz of cal.getAllSubcomponents("vtimezone")) {
    const id = vtz.getFirstPropertyValue("tzid");
    if (typeof id === "string" && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(vtz);
  }
  const used = new Set<string>();
  for (const c of cal.getAllSubcomponents()) {
    for (const p of c.getAllProperties()) {
      const tzid = p.getParameter("tzid");
      if (typeof tzid === "string") used.add(tzid);
    }
  }
  for (const id of used) {
    if (ICAL.TimezoneService.has(id) || !isKnownZone(id)) continue;
    ICAL.TimezoneService.register(new ICAL.Component(ICAL.parse(`${vtimezoneLines(id).join("\r\n")}\r\n`) as unknown[]));
  }
}

/** RECURRENCE-ID value of an occurrence: an instant in UTC ("20261019T080000Z"), or a date ("20261019"). */
export function ridOf(t: Time): string {
  if (t.isDate) return `${t.year}${String(t.month).padStart(2, "0")}${String(t.day).padStart(2, "0")}`;
  return t.toJSDate().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
