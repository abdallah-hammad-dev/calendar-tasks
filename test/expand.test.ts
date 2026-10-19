import { describe, expect, it } from "vitest";
import { closeDeadlines, expandItem, findOccurrence, pickOccurrence, type Occurrence } from "../src/calendar/expand";
import { fixture } from "./support/fixtures";

const TZ = "Europe/Paris";
const opts = (from: string, to: string, me: string[] = ["abd@bench.test"]) => ({
  from: new Date(from),
  to: new Date(to),
  tz: TZ,
  me,
});
const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${body}END:VCALENDAR\r\n`;
const expand = (data: string, from = "2026-10-01T00:00:00Z", to = "2026-11-01T00:00:00Z", me?: string[]) =>
  expandItem("https://cal.test/c/x.ics", "https://cal.test/c/", data, opts(from, to, me));

describe("events", () => {
  it("places a timed event in the user's zone", () => {
    const [o] = expand(fixture("ios-new-reminder.ics").replace(/VTODO/g, "VEVENT").replace(/DUE;/, "DTEND;"));
    expect(o).toMatchObject({ kind: "event", start: "2026-10-19T15:00", allDay: false, recurring: false, recurrenceId: null });
  });

  it("expands a weekly series with an exception and a moved occurrence", () => {
    const data = cal(
      "BEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Point Olera\r\nDTSTART;TZID=Europe/Paris:20261005T100000\r\n" +
        "DTEND;TZID=Europe/Paris:20261005T110000\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nEXDATE;TZID=Europe/Paris:20261012T100000\r\nEND:VEVENT\r\n" +
        "BEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=Europe/Paris:20261019T100000\r\nSUMMARY:Point Olera (décalé)\r\n" +
        "DTSTART;TZID=Europe/Paris:20261019T140000\r\nDTEND;TZID=Europe/Paris:20261019T150000\r\nEND:VEVENT\r\n",
    );
    const occ = expand(data);
    expect(occ.map((o) => [o.start, o.title])).toEqual([
      ["2026-10-05T10:00", "Point Olera"],
      ["2026-10-19T14:00", "Point Olera (décalé)"],
      ["2026-10-26T10:00", "Point Olera"], // the clocks changed on the 25th: still 10:00 local
    ]);
    expect(new Set(occ.map((o) => o.id)).size).toBe(3);
    expect(occ.map((o) => o.recurrenceId)).toEqual(["20261005T080000Z", "20261019T080000Z", "20261026T090000Z"]);

    // Finding one occurrence by its RECURRENCE-ID, even when it was moved.
    const find = (rid: string | null) => findOccurrence("u", "c", data, rid, { tz: TZ, me: [] });
    expect(find("20261019T080000Z")).toMatchObject({ start: "2026-10-19T14:00", title: "Point Olera (décalé)" });
    expect(find("20261026T090000Z")).toMatchObject({ start: "2026-10-26T10:00" });
    expect(find("20261012T080000Z")).toBeNull(); // excluded
    expect(find("20261013T080000Z")).toBeNull(); // never existed
  });

  it("handles all-day and multi-day events (exclusive end)", () => {
    const [one] = expand(cal("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Férié\r\nDTSTART;VALUE=DATE:20261101\r\nEND:VEVENT\r\n"), "2026-10-31T00:00:00Z");
    expect(one).toMatchObject({ allDay: true, start: "2026-11-01", end: "2026-11-02" });
    const [trip] = expand(
      cal("BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Séminaire\r\nDTSTART;VALUE=DATE:20261014\r\nDTEND;VALUE=DATE:20261017\r\nEND:VEVENT\r\n"),
    );
    expect(trip).toMatchObject({ start: "2026-10-14", end: "2026-10-17" });
  });

  it("works with Outlook zone names and with UTC", () => {
    const romance =
      "BEGIN:VTIMEZONE\r\nTZID:Romance Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:+0200\r\n" +
      "TZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\n" +
      "DTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3\r\n" +
      "END:DAYLIGHT\r\nEND:VTIMEZONE\r\n";
    const [o] = expand(
      cal(`${romance}BEGIN:VEVENT\r\nUID:o\r\nSUMMARY:Cours\r\nDTSTART;TZID=Romance Standard Time:20261016T083000\r\nDTEND;TZID=Romance Standard Time:20261016T100000\r\nEND:VEVENT\r\n`),
    );
    expect(o).toMatchObject({ start: "2026-10-16T08:30", end: "2026-10-16T10:00" });
    const [u] = expand(cal("BEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261016T080000Z\r\nDTEND:20261016T090000Z\r\nEND:VEVENT\r\n"));
    expect(u!.start).toBe("2026-10-16T10:00");
  });

  it("keeps only what overlaps the range", () => {
    const data = cal("BEGIN:VEVENT\r\nUID:d\r\nDTSTART;TZID=Europe/Paris:20261005T100000\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n");
    expect(expand(data, "2026-10-10T00:00:00Z", "2026-10-13T00:00:00Z").map((o) => o.start)).toEqual([
      "2026-10-10T10:00",
      "2026-10-11T10:00",
      "2026-10-12T10:00",
    ]);
  });

  it("skips cancelled events", () => {
    expect(expand(cal("BEGIN:VEVENT\r\nUID:c\r\nSTATUS:CANCELLED\r\nDTSTART:20261016T080000Z\r\nEND:VEVENT\r\n"))).toEqual([]);
  });
});

describe("deadlines and time blocks", () => {
  it("shows a task's due date as a deadline", () => {
    expect(expand(fixture("ios-completed-reminder.ics"))).toEqual([
      expect.objectContaining({ kind: "deadline", start: "2026-10-16T10:00", done: true, taskUid: "test-rappel", end: null }),
    ]);
    expect(expand(cal("BEGIN:VTODO\r\nUID:t\r\nSUMMARY:No date\r\nEND:VTODO\r\n"))).toEqual([]);
  });

  it("recognizes a work session on a task", () => {
    const [o] = expand(
      cal("BEGIN:VEVENT\r\nUID:blk\r\nSUMMARY:Bloc\r\nRELATED-TO:task-1\r\nDTSTART:20261016T080000Z\r\nDTEND:20261016T100000Z\r\nEND:VEVENT\r\n"),
    );
    expect(o).toMatchObject({ kind: "timeblock", taskUid: "task-1" });
  });
});

describe("invitations", () => {
  const invite = (partstat: string, me = "abd@bench.test") =>
    cal(
      "BEGIN:VEVENT\r\nUID:inv\r\nSUMMARY:Invitation\r\nDTSTART:20261017T090000Z\r\nDTEND:20261017T100000Z\r\n" +
        "ORGANIZER:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com\r\n" +
        `ATTENDEE;PARTSTAT=${partstat}:mailto:${me}\r\nEND:VEVENT\r\n`,
    );

  it("marks invitations with my answer, and hides declined ones", () => {
    expect(expand(invite("NEEDS-ACTION"))[0]!.invitation).toEqual({ partstat: "NEEDS-ACTION" });
    expect(expand(invite("TENTATIVE"))[0]!.invitation).toEqual({ partstat: "TENTATIVE" });
    expect(expand(invite("DECLINED"))).toEqual([]);
  });

  it("finds a declined one for its note only when asked (its answer can still change)", () => {
    const find = (declined?: boolean) => findOccurrence("u", "c", invite("DECLINED"), null, { tz: TZ, me: ["abd@bench.test"], declined });
    expect(find()).toBeNull();
    expect(find(true)?.invitation).toEqual({ partstat: "DECLINED" });
  });

  it("isn't an invitation when I'm not invited, or when I organize", () => {
    expect(expand(invite("NEEDS-ACTION", "someone@else.com"))[0]!.invitation).toBeNull();
    expect(expand(invite("NEEDS-ACTION"), undefined, undefined, ["boss@example.com"])[0]!.invitation).toBeNull();
  });

  it("reads the backend's relay state", () => {
    const data = invite("ACCEPTED").replace("END:VEVENT", "X-RSVP-STATE:failed:token expired\r\nEND:VEVENT");
    expect(expand(data)[0]!.invitation).toEqual({ partstat: "ACCEPTED", relay: "failed:token expired" });
  });

  it("trusts X-SOURCE-ATTENDEE written by the backend", () => {
    const data = invite("NEEDS-ACTION", "school@uni.edu").replace("END:VEVENT", "X-SOURCE-ATTENDEE:mailto:school@uni.edu\r\nEND:VEVENT");
    expect(expand(data, undefined, undefined, [])[0]!.invitation).toEqual({ partstat: "NEEDS-ACTION" });
  });
});

describe("pickOccurrence", () => {
  const occ = (start: string) => ({ start }) as Parameters<typeof pickOccurrence>[0][number];
  it("prefers today, then the next one", () => {
    const list = [occ("2026-10-08T10:00"), occ("2026-10-15T10:00"), occ("2026-10-22T10:00")];
    expect(pickOccurrence(list, new Date("2026-10-15T20:00:00Z"), TZ)!.start).toBe("2026-10-15T10:00");
    expect(pickOccurrence(list, new Date("2026-10-16T08:00:00Z"), TZ)!.start).toBe("2026-10-22T10:00");
    expect(pickOccurrence(list, new Date("2026-12-01T08:00:00Z"), TZ)!.start).toBe("2026-10-22T10:00");
  });
});

describe("closeDeadlines", () => {
  const d = (id: string, start: string, title = id): Occurrence =>
    ({ id, kind: "deadline", start, title, allDay: false, end: null }) as Occurrence;

  it("groups deadlines less than 20 minutes after a group's first, per day", () => {
    const groups = closeDeadlines([
      d("c", "2026-10-14T16:10"),
      d("a", "2026-10-14T16:00"),
      d("b", "2026-10-14T16:00"),
      d("e", "2026-10-14T16:20"), // 20 min after the first: its own marker
      d("f", "2026-10-14T16:35"), // 15 min after e: with e (not chained to the first group)
      d("g", "2026-10-15T16:00"), // same time, another day
    ]);
    expect(groups.map((g) => g.map((o) => o.id))).toEqual([["a", "b", "c"], ["e", "f"], ["g"]]);
  });

  it("takes the gap as a parameter", () => {
    const groups = closeDeadlines([d("a", "2026-10-14T16:00"), d("b", "2026-10-14T16:05")], 5);
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
  });
});
