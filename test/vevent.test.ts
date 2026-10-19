import { describe, expect, it } from "vitest";
import { expandItem, findOccurrence } from "../src/calendar/expand";
import { cancelOccurrence, endSeries, isMirror, moveEvent, newEvent, renameEvent, setPartstat } from "../src/calendar/vevent";

const TZ = "Europe/Paris";
const NOW = new Date("2026-10-15T12:00:00Z");
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");
const lines = (s: string) => unfold(s).split("\r\n");
const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${body}END:VCALENDAR\r\n`;
const occ = (data: string) =>
  expandItem("u", "c", data, { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), tz: TZ, me: ["abd@bench.test"] });

const weekly = cal(
  "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Point\r\nDTSTART;TZID=Europe/Paris:20261005T100000\r\nDTEND;TZID=Europe/Paris:20261005T110000\r\n" +
    "RRULE:FREQ=WEEKLY;COUNT=4\r\nX-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:0,0\r\nEND:VEVENT\r\n",
);

describe("newEvent", () => {
  it("writes a timed event in the user's zone, and a work session linked to its task", () => {
    const data = newEvent("e1", { summary: "Bloc slides", start: "2026-10-16T16:00", end: "2026-10-16T17:30", relatedTo: "task-1" }, TZ, NOW);
    expect(lines(data)).toEqual(expect.arrayContaining(["DTSTART;TZID=Europe/Paris:20261016T160000", "DTEND;TZID=Europe/Paris:20261016T173000", "RELATED-TO:task-1", "BEGIN:VTIMEZONE"]));
    expect(occ(data)[0]).toMatchObject({ kind: "timeblock", taskUid: "task-1", start: "2026-10-16T16:00", end: "2026-10-16T17:30" });
    const allDay = newEvent("e2", { summary: "Férié", start: "2026-10-20", end: "2026-10-21" }, TZ, NOW);
    expect(lines(allDay)).toContain("DTSTART;VALUE=DATE:20261020");
  });

  it("writes a work session that comes back", () => {
    const data = newEvent("e3", { summary: "Mémoire", start: "2026-10-20T14:00", end: "2026-10-20T16:00", relatedTo: "t", rrule: "FREQ=WEEKLY;BYDAY=TU" }, TZ, NOW);
    expect(lines(data)).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
    expect(occ(data).map((o) => o.start)).toEqual(["2026-10-20T14:00", "2026-10-27T14:00"]);
    expect(occ(data)[0]).toMatchObject({ kind: "timeblock", recurring: true });
  });
});

describe("endSeries", () => {
  const session = (start: string, end: string, rrule = "FREQ=WEEKLY") =>
    newEvent("s", { summary: "Mémoire", start, end, relatedTo: "t", rrule }, TZ, NOW);

  it("ends a session series for a task when it's done, keeping the past ones", () => {
    const ended = (endSeries(session("2026-10-06T14:00", "2026-10-06T16:00"), "t", TZ, NOW) as { data: string }).data;
    expect(lines(ended)).toContain("RRULE:FREQ=WEEKLY;UNTIL=20261015T120000Z");
    expect(occ(ended).map((o) => o.start)).toEqual(["2026-10-06T14:00", "2026-10-13T14:00"]);
    expect(endSeries(ended, "t", TZ, new Date("2026-10-16T12:00:00Z"))).toBeNull(); // already ended
    const allDay = (endSeries(session("2026-10-05", "2026-10-06"), "t", TZ, NOW) as { data: string }).data;
    expect(lines(allDay)).toContain("RRULE:FREQ=WEEKLY;UNTIL=20261015");
  });

  it("deletes one that hasn't started, and leaves other events alone", () => {
    expect(endSeries(session("2026-10-20T14:00", "2026-10-20T16:00"), "t", TZ, NOW)).toBe("delete");
    expect(endSeries(session("2026-10-06T14:00", "2026-10-06T16:00"), "other", TZ, NOW)).toBeNull();
    expect(endSeries(newEvent("x", { summary: "x", start: "2026-10-06T14:00", end: "2026-10-06T15:00", relatedTo: "t" }, TZ, NOW), "t", TZ, NOW)).toBeNull();
  });
});

describe("moveEvent", () => {
  it("moves a single event", () => {
    const data = newEvent("e1", { summary: "Démo", start: "2026-10-16T10:00", end: "2026-10-16T11:00" }, TZ, NOW);
    const moved = moveEvent(data, null, "2026-10-17T14:00", "2026-10-17T15:30", TZ, NOW);
    expect(occ(moved)[0]).toMatchObject({ start: "2026-10-17T14:00", end: "2026-10-17T15:30" });
    expect(lines(moved)).toContain("SEQUENCE:1");
  });

  it("moves one occurrence of a series as an exception, leaving the others", () => {
    const moved = moveEvent(weekly, "20261012T080000Z", "2026-10-13T15:00", "2026-10-13T16:00", TZ, NOW);
    expect(occ(moved).map((o) => o.start)).toEqual(["2026-10-05T10:00", "2026-10-13T15:00", "2026-10-19T10:00", "2026-10-26T10:00"]);
    expect(lines(moved)).toContain("RECURRENCE-ID;TZID=Europe/Paris:20261012T100000");
    expect(lines(moved).filter((l) => l.startsWith("X-APPLE-STRUCTURED-LOCATION"))).toHaveLength(2); // kept, copied
    // Moving it again edits the same exception.
    const again = moveEvent(moved, "20261012T080000Z", "2026-10-14T09:00", "2026-10-14T10:00", TZ, NOW);
    expect(lines(again).filter((l) => l.startsWith("RECURRENCE-ID"))).toHaveLength(1);
    expect(findOccurrence("u", "c", again, "20261012T080000Z", { tz: TZ, me: [] })!.start).toBe("2026-10-14T09:00");
  });
});

describe("renameEvent and cancelOccurrence", () => {
  it("renames one occurrence or the whole event", () => {
    expect(occ(renameEvent(weekly, "20261019T080000Z", "Point (salle B)", NOW)).map((o) => o.title)).toEqual([
      "Point",
      "Point",
      "Point (salle B)",
      "Point",
    ]);
    expect(occ(renameEvent(weekly, null, "Réunion", NOW)).every((o) => o.title === "Réunion")).toBe(true);
  });

  it("removes one occurrence with an EXDATE", () => {
    const moved = moveEvent(weekly, "20261012T080000Z", "2026-10-13T15:00", "2026-10-13T16:00", TZ, NOW);
    const cancelled = cancelOccurrence(moved, "20261012T080000Z", NOW);
    expect(occ(cancelled).map((o) => o.start)).toEqual(["2026-10-05T10:00", "2026-10-19T10:00", "2026-10-26T10:00"]);
    expect(lines(cancelled)).toContain("EXDATE;TZID=Europe/Paris:20261012T100000");
    expect(lines(cancelled).some((l) => l.startsWith("RECURRENCE-ID"))).toBe(false);
  });
});

describe("invitations", () => {
  const invite = cal(
    "BEGIN:VEVENT\r\nUID:inv\r\nSUMMARY:Jury\r\nDTSTART:20261017T090000Z\r\nDTEND:20261017T100000Z\r\nX-SOURCE-ACCOUNT:school\r\n" +
      "ORGANIZER:mailto:prof@uni.edu\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:prof@uni.edu\r\n" +
      "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:abd@bench.test\r\nEND:VEVENT\r\n",
  );

  it("answers only on my attendee line", () => {
    const answered = setPartstat(invite, ["abd@bench.test"], "TENTATIVE", NOW)!;
    expect(lines(answered)).toContain("ATTENDEE;PARTSTAT=TENTATIVE:mailto:abd@bench.test");
    expect(lines(answered)).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:prof@uni.edu");
    expect(occ(answered)[0]!.invitation).toEqual({ partstat: "TENTATIVE" });
    expect(occ(setPartstat(invite, ["abd@bench.test"], "DECLINED", NOW)!)).toEqual([]); // declined: hidden
    expect(setPartstat(invite, ["nobody@else.com"], "ACCEPTED", NOW)).toBeNull();
  });

  it("drops the backend's relay state when the answer changes, not when it's the same", () => {
    const relayed = invite.replace("X-SOURCE-ACCOUNT:school\r\n", "X-SOURCE-ACCOUNT:school\r\nX-RSVP-STATE:confirmed\r\n");
    expect(occ(relayed)[0]!.invitation).toEqual({ partstat: "NEEDS-ACTION", relay: "confirmed" });
    const answered = setPartstat(relayed, ["abd@bench.test"], "ACCEPTED", NOW)!;
    expect(lines(answered).some((l) => l.startsWith("X-RSVP-STATE"))).toBe(false);
    expect(lines(answered)).toContain("X-SOURCE-ACCOUNT:school");
    const again = answered.replace("X-SOURCE-ACCOUNT:school\r\n", "X-SOURCE-ACCOUNT:school\r\nX-RSVP-STATE:pending\r\n");
    expect(lines(setPartstat(again, ["abd@bench.test"], "ACCEPTED", NOW)!)).toContain("X-RSVP-STATE:pending");
  });

  it("knows mirrored events", () => {
    expect(isMirror(invite)).toBe(true);
    expect(isMirror(weekly)).toBe(false);
  });
});
