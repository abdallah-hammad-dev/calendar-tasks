import { describe, expect, it } from "vitest";
import { expandItem, findOccurrence } from "../src/calendar/expand";
import { cancelOccurrence, editEvent, endSeries, isMirror, moveEvent, newEvent, redoOnServer, renameEvent, seriesRule, setPartstat } from "../src/calendar/vevent";

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

const single = () => newEvent("one", { summary: "Point", start: "2026-10-05T10:00", end: "2026-10-05T11:00" }, TZ, NOW);

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

describe("editEvent", () => {
  const alarm = "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n";
  const single = cal(
    "BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Café\r\nDTSTART;TZID=Europe/Paris:20261016T154500\r\nDTEND;TZID=Europe/Paris:20261016T163000\r\n" +
      `LOCATION:Le Bistrot\r\nX-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n${alarm}END:VEVENT\r\n`,
  );

  it("writes only what the form changed, keeping alarms and unknown properties", () => {
    const edited = editEvent(single, null, { summary: "Café avec Sam", start: "2026-10-16T16:00", end: "2026-10-16T17:00" }, TZ, NOW);
    expect(occ(edited)[0]).toMatchObject({ title: "Café avec Sam", start: "2026-10-16T16:00", end: "2026-10-16T17:00", location: "Le Bistrot" });
    expect(lines(edited)).toEqual(expect.arrayContaining(["X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "TRIGGER:-PT15M", "SEQUENCE:1"]));
    expect(occ(editEvent(single, null, { location: null }, TZ, NOW))[0]!.location).toBeNull();
    expect(occ(editEvent(single, null, { start: "2026-10-17", end: "2026-10-18" }, TZ, NOW))[0]).toMatchObject({ allDay: true, start: "2026-10-17" });
  });

  it("turns an event into a work session and back", () => {
    const session = editEvent(single, null, { relatedTo: "t1" }, TZ, NOW);
    expect(occ(session)[0]).toMatchObject({ kind: "timeblock", taskUid: "t1" });
    const other = editEvent(session, null, { relatedTo: "t2" }, TZ, NOW);
    expect(lines(other).filter((l) => l.startsWith("RELATED-TO"))).toEqual(["RELATED-TO:t2"]);
    expect(occ(editEvent(other, null, { relatedTo: null }, TZ, NOW))[0]).toMatchObject({ kind: "event", taskUid: null });
  });

  it("changes one occurrence of a series alone", () => {
    const edited = editEvent(weekly, "20261019T080000Z", { summary: "Point (salle B)", location: "Salle B" }, TZ, NOW);
    expect(occ(edited).map((o) => o.location)).toEqual([null, null, "Salle B", null]);
    expect(occ(edited)[2]!.title).toBe("Point (salle B)");
    // Where it falls, for as long as the others: what the iPhone reads.
    expect(lines(edited).filter((l) => /^(DTSTART|DTEND|RECURRENCE-ID)/.test(l)).slice(2)).toEqual([
      "DTSTART;TZID=Europe/Paris:20261019T100000",
      "DTEND;TZID=Europe/Paris:20261019T110000",
      "RECURRENCE-ID;TZID=Europe/Paris:20261019T100000",
    ]);
  });
});

describe("how an event comes back", () => {
  const rrule = (data: string) => lines(data).filter((l) => l.startsWith("RRULE") && !/BYMONTH=/.test(l)); // not the zone's
  const starts = (data: string) => occ(data).map((o) => o.start);

  it("is written with its last day in DTSTART's form, and read back as that day", () => {
    const data = newEvent("r", { summary: "Cours", start: "2026-10-05T10:00", end: "2026-10-05T12:00", rrule: "FREQ=WEEKLY;UNTIL=20261019" }, TZ, NOW);
    expect(rrule(data)).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261019T215959Z"]);
    expect(starts(data)).toEqual(["2026-10-05T10:00", "2026-10-12T10:00", "2026-10-19T10:00"]); // its last day included
    expect(seriesRule(data, TZ)).toBe("FREQ=WEEKLY;UNTIL=20261019");
    const days = newEvent("d", { summary: "Stage", start: "2026-10-05", end: "2026-10-06", rrule: "FREQ=WEEKLY;UNTIL=20261019" }, TZ, NOW);
    expect(rrule(days)).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261019"]);
    expect(seriesRule(single(), TZ)).toBeNull();
  });

  it("is set on an event, its last day changed or taken off, from any occurrence", () => {
    const series = editEvent(single(), null, { repeat: "FREQ=WEEKLY" }, TZ, NOW);
    expect(starts(series)).toEqual(["2026-10-05T10:00", "2026-10-12T10:00", "2026-10-19T10:00", "2026-10-26T10:00"]);
    const ended = editEvent(series, "20261019T080000Z", { repeat: "FREQ=WEEKLY;UNTIL=20261012" }, TZ, NOW);
    expect(starts(ended)).toEqual(["2026-10-05T10:00", "2026-10-12T10:00"]);
    expect(seriesRule(editEvent(ended, null, { repeat: "FREQ=WEEKLY" }, TZ, NOW), TZ)).toBe("FREQ=WEEKLY");
  });

  it("drops the exceptions after a new last day, and keeps the others", () => {
    const moved = moveEvent(moveEvent(weekly, "20261012T080000Z", "2026-10-13T15:00", "2026-10-13T16:00", TZ, NOW), "20261026T090000Z", "2026-10-27T15:00", "2026-10-27T16:00", TZ, NOW);
    const ended = editEvent(moved, null, { repeat: "FREQ=WEEKLY;UNTIL=20261020" }, TZ, NOW);
    expect(starts(ended)).toEqual(["2026-10-05T10:00", "2026-10-13T15:00", "2026-10-19T10:00"]);
    expect(lines(ended).filter((l) => l.startsWith("RECURRENCE-ID"))).toHaveLength(1);
  });

  it("changed to another pattern from an occurrence: the series moves by as much, its exceptions gone", () => {
    const moved = moveEvent(weekly, "20261012T080000Z", "2026-10-13T15:00", "2026-10-13T16:00", TZ, NOW);
    const daily = editEvent(moved, "20261019T080000Z", { repeat: "FREQ=DAILY;UNTIL=20261008", start: "2026-10-19T11:00", end: "2026-10-19T11:30" }, TZ, NOW);
    expect(occ(daily).map((o) => `${o.start}–${o.end!.slice(11)}`)).toEqual(["2026-10-05T11:00–11:30", "2026-10-06T11:00–11:30", "2026-10-07T11:00–11:30", "2026-10-08T11:00–11:30"]);
    expect(lines(daily).filter((l) => l.startsWith("RECURRENCE-ID") || l.startsWith("BEGIN:VEVENT"))).toEqual(["BEGIN:VEVENT"]);
  });

  it("taken off from an occurrence: that occurrence, as edited, is the event left", () => {
    const once = editEvent(weekly, "20261019T080000Z", { repeat: null, summary: "Point final" }, TZ, NOW);
    expect(occ(once)).toEqual([expect.objectContaining({ start: "2026-10-19T10:00", title: "Point final", recurring: false })]);
    expect(lines(once).some((l) => /^(RRULE|RECURRENCE-ID|EXDATE)/.test(l) && !l.includes("BYMONTH"))).toBe(false);
  });

  it("keeps its last day in DTSTART's form when the series becomes whole days", () => {
    const data = newEvent("r", { summary: "Cours", start: "2026-10-05T10:00", end: "2026-10-05T12:00", rrule: "FREQ=WEEKLY;UNTIL=20261019" }, TZ, NOW);
    expect(rrule(editEvent(data, null, { start: "2026-10-05", end: "2026-10-06" }, TZ, NOW))).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261019"]);
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
    "BEGIN:VEVENT\r\nUID:inv\r\nSUMMARY:Jury\r\nDTSTART:20261017T090000Z\r\nDTEND:20261017T100000Z\r\nX-CALTASKS-SOURCE-ACCOUNT:school\r\n" +
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
    const relayed = invite.replace("X-CALTASKS-SOURCE-ACCOUNT:school\r\n", "X-CALTASKS-SOURCE-ACCOUNT:school\r\nX-CALTASKS-RSVP-STATE:confirmed\r\n");
    expect(occ(relayed)[0]!.invitation).toEqual({ partstat: "NEEDS-ACTION", relay: "confirmed" });
    const answered = setPartstat(relayed, ["abd@bench.test"], "ACCEPTED", NOW)!;
    expect(lines(answered).some((l) => l.startsWith("X-CALTASKS-RSVP-STATE"))).toBe(false);
    expect(lines(answered)).toContain("X-CALTASKS-SOURCE-ACCOUNT:school");
    const again = answered.replace("X-CALTASKS-SOURCE-ACCOUNT:school\r\n", "X-CALTASKS-SOURCE-ACCOUNT:school\r\nX-CALTASKS-RSVP-STATE:pending\r\n");
    expect(lines(setPartstat(again, ["abd@bench.test"], "ACCEPTED", NOW)!)).toContain("X-CALTASKS-RSVP-STATE:pending");
  });

  describe("a change the server refused (it changed meanwhile)", () => {
    const me = ["abd@bench.test"];
    const LATER = new Date("2026-11-05T10:00:00Z");
    // "Accept" pushed, then the backend wrote how it went: the cache still has the version before that.
    const base = setPartstat(invite, me, "ACCEPTED", NOW)!;
    const server = base.replace("X-CALTASKS-SOURCE-ACCOUNT:school\r\n", "X-CALTASKS-SOURCE-ACCOUNT:school\r\nX-CALTASKS-RSVP-STATE:confirmed\r\n");
    const declined = setPartstat(base, me, "DECLINED", LATER)!;

    it("answers again on the server's version", () => {
      const again = redoOnServer(declined, base, server, me, LATER)!;
      expect(again.clash).toBe(false);
      expect(lines(again.push!)).toContain("ATTENDEE;PARTSTAT=DECLINED:mailto:abd@bench.test");
      expect(lines(again.push!).some((l) => l.startsWith("X-CALTASKS-RSVP-STATE"))).toBe(false); // the backend writes it again
      expect(lines(again.push!)).toContain("X-CALTASKS-SOURCE-ACCOUNT:school");
    });

    it("sends nothing when the server already has it", () => {
      const there = setPartstat(server, me, "DECLINED", LATER)!;
      expect(redoOnServer(declined, base, there, me, LATER)).toEqual({ push: null, clash: false });
    });

    it("loses to an answer made elsewhere meanwhile", () => {
      const elsewhere = setPartstat(server, me, "TENTATIVE", LATER)!;
      expect(redoOnServer(declined, base, elsewhere, me, LATER)).toEqual({ push: null, clash: true });
    });

    it("sends nothing for an answer clicked back to the one it had, unless the server's changed", () => {
      const back = setPartstat(declined, me, "ACCEPTED", LATER)!;
      expect(redoOnServer(back, base, server, me, LATER)).toEqual({ push: null, clash: false });
      const elsewhere = setPartstat(server, me, "TENTATIVE", LATER)!;
      expect(redoOnServer(back, base, elsewhere, me, LATER)).toEqual({ push: null, clash: true });
    });

    it("leaves any other change to the clash notice", () => {
      const renamed = renameEvent(base, null, "Jury (salle B)", LATER);
      expect(redoOnServer(renamed, base, server, me, LATER)).toBeNull();
      expect(redoOnServer(renameEvent(declined, null, "Jury (salle B)", LATER), base, server, me, LATER)).toBeNull();
      expect(redoOnServer(declined, undefined, server, me, LATER)).toBeNull();
    });

    describe("in a series", () => {
      const course = cal(
        "BEGIN:VEVENT\r\nUID:cours\r\nSUMMARY:Cours\r\nDTSTART;TZID=Europe/Paris:20261005T100000\r\nDTEND;TZID=Europe/Paris:20261005T110000\r\n" +
          "RRULE:FREQ=WEEKLY;COUNT=4\r\nX-CALTASKS-SOURCE-ACCOUNT:school\r\nORGANIZER:mailto:prof@uni.edu\r\n" +
          "ATTENDEE;PARTSTAT=ACCEPTED:mailto:prof@uni.edu\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:abd@bench.test\r\nEND:VEVENT\r\n",
      );
      // Monday 5 removed and pushed; the backend wrote it again, and the organizer changed the room meanwhile.
      const pushed = cancelOccurrence(course, "20261005T080000Z", NOW);
      const there = pushed.replace("SUMMARY:Cours", "SUMMARY:Cours (salle B)");
      const second = cancelOccurrence(pushed, "20261012T080000Z", LATER);

      it("removes a second occurrence again on the server's version", () => {
        const again = redoOnServer(second, pushed, there, me, LATER)!;
        expect(again.clash).toBe(false);
        expect(occ(again.push!).map((o) => [o.start, o.title])).toEqual([
          ["2026-10-19T10:00", "Cours (salle B)"],
          ["2026-10-26T10:00", "Cours (salle B)"],
        ]);
      });

      it("sends nothing when the server already removed it", () => {
        const gone = cancelOccurrence(there, "20261012T080000Z", LATER);
        expect(redoOnServer(second, pushed, gone, me, LATER)).toEqual({ push: null, clash: false });
      });

      it("removes it even when my answer lost to one made elsewhere", () => {
        const both = cancelOccurrence(setPartstat(pushed, me, "DECLINED", LATER)!, "20261012T080000Z", LATER);
        const elsewhere = setPartstat(there, me, "TENTATIVE", LATER)!;
        const again = redoOnServer(both, pushed, elsewhere, me, LATER)!;
        expect(again.clash).toBe(true);
        expect(occ(again.push!).map((o) => [o.start, o.invitation?.partstat])).toEqual([
          ["2026-10-19T10:00", "TENTATIVE"],
          ["2026-10-26T10:00", "TENTATIVE"],
        ]);
      });
    });
  });

  it("knows mirrored events", () => {
    expect(isMirror(invite)).toBe(true);
    expect(isMirror(weekly)).toBe(false);
  });
});

describe("an event's video meeting", () => {
  const MEET = { url: "https://meet.google.com/abc-defg-hij", label: "Meet" };
  const ZOOM = { url: "https://us02web.zoom.us/j/81234567890", label: "Zoom" };
  const made = (fields: { location?: string; meeting?: typeof MEET }) =>
    newEvent("v", { summary: "Point", start: "2026-10-16T10:00", end: "2026-10-16T11:00", ...fields }, TZ, NOW);
  const prop = (data: string, name: string) => lines(data).filter((l) => l.startsWith(name));

  it("is written as the backend writes one: CONFERENCE, and the place or a line in the notes for the iPhone", () => {
    const alone = made({ meeting: MEET });
    expect(prop(alone, "CONFERENCE")).toEqual(["CONFERENCE;FEATURE=VIDEO;LABEL=Meet;VALUE=URI:https://meet.google.com/abc-defg-hij"]);
    expect(prop(alone, "LOCATION")).toEqual(["LOCATION:https://meet.google.com/abc-defg-hij"]);
    expect(occ(alone)[0]).toMatchObject({ meeting: { url: MEET.url, provider: "Meet" }, location: null });
    const placed = made({ location: "Salle 3", meeting: MEET });
    expect(prop(placed, "LOCATION")).toEqual(["LOCATION:Salle 3"]);
    expect(prop(placed, "DESCRIPTION")).toEqual(["DESCRIPTION:Meet: https://meet.google.com/abc-defg-hij"]);
    expect(occ(placed)[0]).toMatchObject({ meeting: { url: MEET.url }, location: "Salle 3" });
  });

  it("changed or taken off: the old link goes from everywhere, the notes' other lines and a dial-in stay", () => {
    const placed = made({ location: "Salle 3", meeting: MEET }).replace("DESCRIPTION:Meet:", "DESCRIPTION:Code 1234\\n\\nMeet:");
    const dialIn = placed.replace("END:VEVENT", "CONFERENCE;VALUE=URI;FEATURE=PHONE:tel:+33100000000\r\nEND:VEVENT");
    const zoom = editEvent(dialIn, null, { meeting: ZOOM }, TZ, NOW);
    expect(occ(zoom)[0]).toMatchObject({ meeting: { url: ZOOM.url, provider: "Zoom" }, location: "Salle 3" });
    expect(prop(zoom, "CONFERENCE")).toEqual(["CONFERENCE;FEATURE=PHONE;VALUE=URI:tel:+33100000000", "CONFERENCE;FEATURE=VIDEO;LABEL=Zoom;VALUE=URI:https://us02web.zoom.us/j/81234567890"]);
    expect(prop(zoom, "DESCRIPTION")).toEqual(["DESCRIPTION:Code 1234\\n\\nZoom: https://us02web.zoom.us/j/81234567890"]);
    const none = editEvent(zoom, null, { meeting: null }, TZ, NOW);
    expect(occ(none)[0]).toMatchObject({ meeting: null, location: "Salle 3" });
    expect(prop(none, "DESCRIPTION")).toEqual(["DESCRIPTION:Code 1234"]);
    expect(prop(none, "CONFERENCE")).toEqual(["CONFERENCE;FEATURE=PHONE;VALUE=URI:tel:+33100000000"]);
    // The place that was only its link goes with it.
    expect(prop(editEvent(made({ meeting: MEET }), null, { meeting: null }, TZ, NOW), "LOCATION")).toEqual([]);
  });

  it("follows a place typed over the place that was only its link, to the notes", () => {
    const moved = editEvent(made({ meeting: MEET }), null, { location: "Salle 3", meeting: MEET }, TZ, NOW);
    expect(occ(moved)[0]).toMatchObject({ meeting: { url: MEET.url }, location: "Salle 3" });
    expect(prop(moved, "DESCRIPTION")).toEqual(["DESCRIPTION:Meet: https://meet.google.com/abc-defg-hij"]);
    expect(prop(moved, "CONFERENCE")).toHaveLength(1);
  });

  it("set from the iPhone's place or notes, the link becomes the event's meeting where it was", () => {
    const fromPhone = cal(
      "BEGIN:VEVENT\r\nUID:p\r\nSUMMARY:Point\r\nDTSTART;TZID=Europe/Paris:20261016T100000\r\nDTEND;TZID=Europe/Paris:20261016T110000\r\n" +
        "DESCRIPTION:Ordre du jour\\nLien de la visio : https://us02web.zoom.us/j/1\r\nEND:VEVENT\r\n",
    );
    const changed = editEvent(fromPhone, null, { meeting: MEET }, TZ, NOW);
    expect(prop(changed, "DESCRIPTION")).toEqual(["DESCRIPTION:Ordre du jour"]);
    expect(prop(changed, "LOCATION")).toEqual(["LOCATION:https://meet.google.com/abc-defg-hij"]);
    expect(occ(changed)[0]!.meeting).toEqual({ url: MEET.url, provider: "Meet" });
  });

  it("changed on one occurrence of a series alone", () => {
    const edited = editEvent(weekly, "20261019T080000Z", { meeting: ZOOM }, TZ, NOW);
    expect(occ(edited).map((o) => o.meeting?.provider ?? null)).toEqual([null, null, "Zoom", null]);
  });
});
