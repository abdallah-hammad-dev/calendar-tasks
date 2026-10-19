import { describe, expect, it } from "vitest";
import { fromWall, offsetMinutes, parseLocal, vtimezoneLines, wallClock } from "../src/ical/time";

describe("zone math", () => {
  it("knows Paris offsets in winter and summer", () => {
    expect(offsetMinutes(new Date("2026-01-15T12:00:00Z"), "Europe/Paris")).toBe(60);
    expect(offsetMinutes(new Date("2026-07-15T12:00:00Z"), "Europe/Paris")).toBe(120);
    expect(offsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("converts wall clock ↔ instant, including around DST changes", () => {
    const w = { year: 2026, month: 10, day: 16, hour: 10, minute: 0, second: 0 };
    expect(fromWall(w, "Europe/Paris").toISOString()).toBe("2026-10-16T08:00:00.000Z");
    expect(fromWall({ ...w, month: 12 }, "Europe/Paris").toISOString()).toBe("2026-12-16T09:00:00.000Z");
    // The night of the autumn change (25 Oct 2026): 12:00 Paris is UTC+1 again.
    expect(fromWall({ ...w, day: 25, hour: 12 }, "Europe/Paris").toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(wallClock(new Date("2026-10-16T08:00:00Z"), "Europe/Paris")).toMatchObject({ hour: 10, minute: 0 });
  });

  it("parses local values", () => {
    expect(parseLocal("2026-10-15")).toMatchObject({ allDay: true, wall: { year: 2026, month: 10, day: 15 } });
    expect(parseLocal("2026-10-15T14:30")).toMatchObject({ allDay: false, wall: { hour: 14, minute: 30 } });
    expect(parseLocal("15/10")).toBeNull();
    expect(parseLocal("2026-13-01")).toBeNull();
  });
});

describe("vtimezoneLines", () => {
  it("writes the EU rules for Paris", () => {
    expect(vtimezoneLines("Europe/Paris", 2026)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Paris",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "DTSTART:19700329T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "DTSTART:19701025T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("writes the US rules (second Sunday of March, first Sunday of November)", () => {
    const lines = vtimezoneLines("America/New_York", 2026);
    expect(lines).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    expect(lines).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    expect(lines).toContain("DTSTART:19700308T020000");
    expect(lines).toContain("DTSTART:19701101T020000");
  });

  it("writes a fixed offset for zones without DST", () => {
    expect(vtimezoneLines("Asia/Tokyo", 2026)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "DTSTART:19700101T000000",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });
});
