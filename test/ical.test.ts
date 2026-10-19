import { describe, expect, it } from "vitest";
import { itemInfo } from "../src/caldav/ical";

const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${body}END:VCALENDAR\r\n`;

describe("itemInfo", () => {
  it("reads UID and kind, skipping VTIMEZONE", () => {
    const data = cal(
      "BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nEND:VTIMEZONE\r\nBEGIN:VTODO\r\nUID:task-1\r\nSUMMARY:x\r\nEND:VTODO\r\n",
    );
    expect(itemInfo(data)).toEqual({ uid: "task-1", kind: "VTODO", recurrenceIds: [] });
  });

  it("lists overridden occurrences", () => {
    const data = cal(
      "BEGIN:VEVENT\r\nUID:ev\r\nDTSTART:20261016T080000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n" +
        "BEGIN:VEVENT\r\nUID:ev\r\nRECURRENCE-ID:20261023T080000Z\r\nDTSTART:20261023T090000Z\r\nEND:VEVENT\r\n",
    );
    expect(itemInfo(data)).toMatchObject({ uid: "ev", kind: "VEVENT", recurrenceIds: ["2026-10-23T08:00:00Z"] });
  });

  it("returns null for garbage instead of throwing", () => {
    expect(itemInfo("not a calendar")).toBeNull();
    expect(itemInfo(cal("BEGIN:VTODO\r\nSUMMARY:no uid\r\nEND:VTODO\r\n"))).toBeNull();
  });
});
