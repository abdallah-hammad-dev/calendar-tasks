import ICAL from "ical.js";

export type ItemKind = "VEVENT" | "VTODO" | "VJOURNAL" | "OTHER";

export interface ItemInfo {
  uid: string;
  kind: ItemKind;
  /** Its title ("" when it has none). */
  summary: string;
  /** `RECURRENCE-ID`s of overridden occurrences stored in the same resource. */
  recurrenceIds: string[];
}

/** UID and kind of a calendar resource; null if it can't be parsed. Never throws. */
export function itemInfo(data: string): ItemInfo | null {
  try {
    const cal = new ICAL.Component(ICAL.parse(data) as unknown[]);
    const comps = cal.getAllSubcomponents().filter((c) => c.name !== "vtimezone");
    const first = comps[0];
    if (!first) return null;
    const uid = first.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || !uid) return null;
    const name = first.name.toUpperCase();
    const kind: ItemKind = name === "VEVENT" || name === "VTODO" || name === "VJOURNAL" ? name : "OTHER";
    const recurrenceIds = comps
      .map((c) => c.getFirstPropertyValue("recurrence-id"))
      .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined)
      .map((v) => v.toString());
    const summary = first.getFirstPropertyValue("summary");
    return { uid, kind, summary: typeof summary === "string" ? summary : "", recurrenceIds };
  } catch {
    return null;
  }
}
