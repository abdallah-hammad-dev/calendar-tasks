import { describe, expect, it } from "vitest";
import { isValid, localDate, localValue, moveStart, shiftDays, toAllDay, toTimed } from "../src/calendar/when-fields";

describe("start and end fields", () => {
  it("reads and writes local values in this device's zone", () => {
    const d = localDate("2026-10-14T03:35");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 14, 3, 35]);
    expect(localDate("2026-10-14").getHours()).toBe(0); // the day's midnight here, not in UTC
    expect(localValue(d, false)).toBe("2026-10-14T03:35");
    expect(localValue(d, true)).toBe("2026-10-14");
  });

  it("counts whole days across months, years and daylight saving", () => {
    expect(shiftDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDays("2026-03-29", -1)).toBe("2026-03-28");
    expect(shiftDays("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("keeps the length when the start moves, to the minute", () => {
    expect(moveStart({ start: "2026-10-14T03:35", end: "2026-10-14T04:25", allDay: false }, "2026-10-14T03:37")).toEqual({
      start: "2026-10-14T03:37",
      end: "2026-10-14T04:27",
      allDay: false,
    });
    // Late in the evening: the end goes past midnight.
    expect(moveStart({ start: "2026-10-14T10:00", end: "2026-10-14T11:30", allDay: false }, "2026-10-14T23:15").end).toBe("2026-10-15T00:45");
    // Whole days: a day count, even over the night the clocks change.
    expect(moveStart({ start: "2026-10-20", end: "2026-10-22", allDay: true }, "2026-10-24")).toEqual({ start: "2026-10-24", end: "2026-10-26", allDay: true });
    // A deadline has no end.
    expect(moveStart({ start: "2026-10-14T18:00", end: null, allDay: false }, "2026-10-15T09:05")).toEqual({ start: "2026-10-15T09:05", end: null, allDay: false });
  });

  it("an end not after the start is not valid", () => {
    expect(isValid({ start: "2026-10-14T10:00", end: "2026-10-14T10:05", allDay: false })).toBe(true);
    expect(isValid({ start: "2026-10-14T10:00", end: "2026-10-14T10:00", allDay: false })).toBe(false);
    expect(isValid({ start: "2026-10-14T10:00", end: "2026-10-14T09:55", allDay: false })).toBe(false);
    expect(isValid({ start: "2026-10-14T10:00", end: "", allDay: false })).toBe(false);
    expect(isValid({ start: "", end: "2026-10-14T10:00", allDay: false })).toBe(false);
    expect(isValid({ start: "2026-10-14", end: null, allDay: true })).toBe(true);
  });

  it("ticking All day keeps the days the times touch", () => {
    expect(toAllDay({ start: "2026-10-14T03:35", end: "2026-10-14T04:25", allDay: false })).toEqual({ start: "2026-10-14", end: "2026-10-15", allDay: true });
    expect(toAllDay({ start: "2026-10-14T22:00", end: "2026-10-16T01:00", allDay: false })).toEqual({ start: "2026-10-14", end: "2026-10-17", allDay: true });
    // Ending at midnight doesn't take the next day.
    expect(toAllDay({ start: "2026-10-14T20:00", end: "2026-10-15T00:00", allDay: false })).toEqual({ start: "2026-10-14", end: "2026-10-15", allDay: true });
  });

  it("unticking it puts the times back, or an hour when they don't make a range", () => {
    expect(toTimed({ start: "2026-10-14", end: "2026-10-15", allDay: true }, { start: "03:35", end: "04:25" })).toEqual({
      start: "2026-10-14T03:35",
      end: "2026-10-14T04:25",
      allDay: false,
    });
    expect(toTimed({ start: "2026-10-14", end: "2026-10-15", allDay: true }, { start: "16:00", end: "09:00" }).end).toBe("2026-10-14T17:00");
    expect(toTimed({ start: "2026-10-14", end: "2026-10-17", allDay: true }, { start: "09:00", end: "10:00" }).end).toBe("2026-10-16T10:00");
  });
});
