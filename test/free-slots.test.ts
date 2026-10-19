import { describe, expect, it } from "vitest";
import { freeSlots } from "../src/claude/free-slots";

describe("freeSlots", () => {
  it("finds gaps within working hours over several days", () => {
    const busy = [
      { start: "2026-10-16T09:00", end: "2026-10-16T10:30" },
      { start: "2026-10-16T12:00", end: "2026-10-16T14:00" },
      { start: "2026-10-16T13:00", end: "2026-10-16T15:00" }, // overlapping
    ];
    expect(
      freeSlots(busy, { from: "2026-10-16T00:00", to: "2026-10-18T00:00", minutes: 60, dayStart: "09:00", dayEnd: "18:00", tz: "Europe/Paris" }),
    ).toEqual([
      { start: "2026-10-16T10:30", end: "2026-10-16T12:00" },
      { start: "2026-10-16T15:00", end: "2026-10-16T18:00" },
      { start: "2026-10-17T09:00", end: "2026-10-17T18:00" },
    ]);
  });

  it("skips gaps shorter than asked and starts no earlier than `from`", () => {
    const busy = [{ start: "2026-10-16T10:00", end: "2026-10-16T17:30" }];
    expect(
      freeSlots(busy, { from: "2026-10-16T09:30", to: "2026-10-16T23:00", minutes: 45, dayStart: "09:00", dayEnd: "18:00", tz: "Europe/Paris" }),
    ).toEqual([]);
  });
});
