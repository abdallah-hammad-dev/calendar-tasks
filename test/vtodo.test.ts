import { describe, expect, it } from "vitest";
import { newTask, readTask, sameFields, taskLink, writeTask, type TaskFields } from "../src/tasks/vtodo";
import { fixture } from "./support/fixtures";

const PARIS = { tz: "Europe/Paris", now: new Date("2026-10-15T12:00:00Z") };
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, "");
const lines = (s: string) => unfold(s).split("\r\n");
const cal = (todo: string, extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${extra}BEGIN:VTODO\r\nUID:u1\r\nSUMMARY:S\r\n${todo}END:VTODO\r\nEND:VCALENDAR\r\n`;

describe("readTask", () => {
  it("reads a reminder created on the iPhone", () => {
    expect(readTask(fixture("ios-new-reminder.ics"), "Europe/Paris")).toEqual({
      uid: "9EABE155-4E3A-467A-ACA6-830C40BEAB6B",
      summary: "Test 6",
      done: false,
      due: "2026-10-19T15:00",
      created: "2026-10-15T05:10", // CREATED:20261015T031024Z
      categories: [],
      parentUid: null,
      repeat: null,
      priority: null,
      completed: null,
      notes: "",
      url: null,
      hasLinkLine: false,
    });
  });

  it("reads a reminder ticked on the iPhone, separating our link from the notes", () => {
    const t = readTask(fixture("ios-completed-reminder.ics"), "Europe/Paris")!;
    expect(t).toMatchObject({ done: true, due: "2026-10-16T10:00", hasLinkLine: true });
    expect(t.completed).toBe("2026-10-15T06:00"); // COMPLETED:20261015T040023Z, in Paris
    expect(t.notes).toBe("Le cocher sur l'iPhone puis lancer ./check.sh");
    expect(t.url).toBe("obsidian://calendar-tasks?uid=test-rappel");
  });

  it("converts due dates to the user's zone", () => {
    expect(readTask(cal("DUE:20261016T080000Z\r\n"), "Europe/Paris")!.due).toBe("2026-10-16T10:00");
    expect(readTask(fixture("ios-new-reminder.ics"), "America/New_York")!.due).toBe("2026-10-19T09:00");
    expect(readTask(cal("DUE;VALUE=DATE:20261020\r\n"), "Europe/Paris")!.due).toBe("2026-10-20");
    expect(readTask(cal("DUE:20261020T140000\r\n"), "Europe/Paris")!.due).toBe("2026-10-20T14:00"); // floating
  });

  it("uses the item's own VTIMEZONE for non-IANA zone names (Outlook)", () => {
    const romance =
      "BEGIN:VTIMEZONE\r\nTZID:Romance Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\n" +
      "TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10\r\nEND:STANDARD\r\n" +
      "BEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\n" +
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n";
    const data = cal("DUE;TZID=Romance Standard Time:20261016T100000\r\n", romance);
    expect(readTask(data, "Europe/Paris")!.due).toBe("2026-10-16T10:00");
    expect(readTask(data, "UTC")!.due).toBe("2026-10-16T08:00");
  });

  it("reads parent links with or without RELTYPE, and categories", () => {
    expect(readTask(cal("RELATED-TO:p1\r\nCATEGORIES:Olera,Work\r\n"), "UTC")).toMatchObject({
      parentUid: "p1",
      categories: ["Olera", "Work"],
    });
    expect(readTask(cal("RELATED-TO;RELTYPE=SIBLING:x\r\n"), "UTC")!.parentUid).toBeNull();
  });

  it("returns null for anything that isn't a VTODO", () => {
    expect(readTask("garbage", "UTC")).toBeNull();
    expect(readTask(fixture("ios-new-reminder.ics").replace(/VTODO/g, "VEVENT"), "UTC")).toBeNull();
  });
});

describe("priority", () => {
  const level = (n: number) => readTask(cal(`PRIORITY:${n}\r\n`), "Europe/Paris")!.priority;
  const written = (data: string) => lines(data).find((x) => x.startsWith("PRIORITY")) ?? null;

  it("reads RFC 5545's nine levels as three", () => {
    expect([0, 1, 2, 4, 5, 6, 9].map(level)).toEqual([null, "high", "high", "high", "medium", "low", "low"]);
  });

  it("writes what Reminders writes, and only when the level changes", () => {
    expect(written(writeTask(cal(""), { priority: "high" }, PARIS))).toBe("PRIORITY:1");
    expect(written(writeTask(cal(""), { priority: "medium" }, PARIS))).toBe("PRIORITY:5");
    expect(written(writeTask(cal("PRIORITY:5\r\n"), { priority: null }, PARIS))).toBeNull();
    expect(written(writeTask(cal("PRIORITY:2\r\n"), { priority: "high" }, PARIS))).toBe("PRIORITY:2");
  });
});

describe("writeTask", () => {
  it("ticks a task without touching what it doesn't own", () => {
    const before = fixture("ios-new-reminder.ics");
    const after = writeTask(before, { done: true }, PARIS);
    const l = lines(after);
    expect(l).toContain("STATUS:COMPLETED");
    expect(l).toContain("PERCENT-COMPLETE:100");
    expect(l).toContain("COMPLETED:20261015T120000Z");
    expect(l).toContain("BEGIN:VALARM");
    expect(l).toContain("DUE;TZID=Europe/Paris:20261019T150000");
    expect(l.filter((x) => x === "BEGIN:VTIMEZONE")).toHaveLength(1);
    expect(readTask(writeTask(after, { done: false }, PARIS), "Europe/Paris")!.done).toBe(false);
    expect(lines(writeTask(after, { done: false }, PARIS)).some((x) => x.startsWith("COMPLETED"))).toBe(false);
  });

  it("writes when it was ticked, the note's time in UTC", () => {
    const ticked = writeTask(fixture("ios-new-reminder.ics"), { done: true, completed: "2026-10-25T14:32" }, PARIS);
    expect(lines(ticked)).toContain("COMPLETED:20261025T133200Z"); // winter time in Paris from that morning
    expect(readTask(ticked, "Europe/Paris")!.completed).toBe("2026-10-25T14:32");
    const changed = writeTask(ticked, { completed: "2026-10-24T09:00" }, PARIS);
    expect(lines(changed)).toContain("COMPLETED:20261024T070000Z");
    expect(lines(changed).filter((x) => x.startsWith("COMPLETED:"))).toHaveLength(1);
  });

  it("writes due dates the way iOS does (DTSTART = DUE), with TZID and a VTIMEZONE", () => {
    const timed = writeTask(cal(""), { due: "2026-10-20T14:00" }, PARIS);
    const l = lines(timed);
    expect(l).toContain("DUE;TZID=Europe/Paris:20261020T140000");
    expect(l).toContain("DTSTART;TZID=Europe/Paris:20261020T140000");
    expect(l.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(l.indexOf("BEGIN:VTODO"));
    expect(readTask(timed, "Europe/Paris")!.due).toBe("2026-10-20T14:00");

    const allDay = lines(writeTask(timed, { due: "2026-10-21" }, PARIS));
    expect(allDay).toContain("DUE;VALUE=DATE:20261021");
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261021");
    expect(lines(writeTask(timed, { due: null }, PARIS)).some((x) => /^(DUE|DTSTART).*:2026/.test(x))).toBe(false);
  });

  it("replaces the parent link, whatever form iOS left it in", () => {
    const l = lines(writeTask(cal("RELATED-TO:old\r\n"), { parentUid: "new" }, PARIS));
    expect(l.filter((x) => x.startsWith("RELATED-TO"))).toEqual(["RELATED-TO;RELTYPE=PARENT:new"]);
    expect(lines(writeTask(cal("RELATED-TO:old\r\n"), { parentUid: null }, PARIS)).some((x) => x.startsWith("RELATED-TO"))).toBe(
      false,
    );
  });

  it("keeps our link as URL and as the last line of the notes, once", () => {
    const link = taskLink("My Vault", "u1");
    expect(link).toBe("obsidian://calendar-tasks?vault=My%20Vault&uid=u1");
    const opts = { ...PARIS, link, linkInNotes: true };
    const once = writeTask(cal("DESCRIPTION:Acheter du pain\r\n"), {}, opts);
    const twice = writeTask(once, {}, opts);
    const t = readTask(twice, "Europe/Paris")!;
    expect(t).toMatchObject({ url: link, hasLinkLine: true, notes: "Acheter du pain" });
    expect(unfold(twice)).toContain(`DESCRIPTION:Acheter du pain\\n\\n${link}`);
    const off = readTask(writeTask(twice, {}, { ...opts, linkInNotes: false }), "Europe/Paris")!;
    expect(off).toMatchObject({ hasLinkLine: false, notes: "Acheter du pain", url: link });
  });

  it("sets and clears categories", () => {
    const withCats = writeTask(cal(""), { categories: ["Olera"] }, PARIS);
    expect(lines(withCats)).toContain("CATEGORIES:Olera");
    expect(lines(writeTask(withCats, { categories: [] }, PARIS)).some((x) => x.startsWith("CATEGORIES"))).toBe(false);
  });
});

describe("repetition", () => {
  it("writes RRULE next to the due date, reads iOS's spelling back as the same rule, and removes it", () => {
    const weekly = writeTask(cal("DUE;VALUE=DATE:20261020\r\n"), { repeat: "FREQ=WEEKLY" }, PARIS);
    expect(lines(weekly)).toContain("RRULE:FREQ=WEEKLY");
    expect(readTask(cal("DTSTART;VALUE=DATE:20261020\r\nDUE;VALUE=DATE:20261020\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO\r\n"), "Europe/Paris")?.repeat).toBe("FREQ=WEEKLY");
    expect(lines(writeTask(weekly, { repeat: null }, PARIS)).some((x) => x.startsWith("RRULE"))).toBe(false);
  });

  it("keeps the rule in the note only when there's no date to hang it on", () => {
    expect(lines(writeTask(cal(""), { repeat: "FREQ=WEEKLY" }, PARIS)).some((x) => x.startsWith("RRULE"))).toBe(false);
  });
});

describe("newTask", () => {
  it("round-trips every owned field", () => {
    const fields: TaskFields = {
      summary: "Préparer slides",
      done: false,
      due: "2026-10-20T14:00",
      categories: ["Olera"],
      parentUid: "p1",
      repeat: "FREQ=WEEKLY;BYDAY=TU",
      priority: "medium",
      completed: null,
    };
    const data = newTask("new-1", fields, { ...PARIS, link: taskLink("V", "new-1"), linkInNotes: true });
    const t = readTask(data, "Europe/Paris")!;
    expect(sameFields(t, fields)).toBe(true);
    expect(t).toMatchObject({ uid: "new-1", hasLinkLine: true, notes: "" });
    expect(lines(data)).toContain("PRODID:-//calendar-tasks//Obsidian//EN");
  });
});
