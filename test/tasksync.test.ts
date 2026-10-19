import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { MemoryStore } from "../src/sync/store";
import { TaskSync } from "../src/tasks/TaskSync";
import { readTask, taskLink } from "../src/tasks/vtodo";
import { FakeServer } from "./support/fake-server";
import { FakeVault } from "./support/fake-vault";
import { fixture } from "./support/fixtures";

const TZ = "Europe/Paris";
const vtodo = (uid: string, lines: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VTODO\r\nUID:${uid}\r\n${lines}END:VTODO\r\nEND:VCALENDAR\r\n`;

let server: FakeServer;
let vault: FakeVault;
let engine: SyncEngine;
let tasks: TaskSync;
let calendar: string;
let notices: string[];
let created: string[];
let uidSeq: number;
let settings: { tasksFolder: string; reminderNoteLink: boolean; defaultCalendar: string };

/** One full sync round, then let task sync settle. */
async function cycle(): Promise<void> {
  await engine.sync();
  await tasks.whenIdle();
  await tasks.pullAll();
}
/** What the server holds for an item, read back as a task. */
const onServer = (uid: string) => {
  const it = server.stored(`${calendar}${uid}.ics`);
  return it ? readTask(it.data, TZ) : null;
};

async function start(): Promise<void> {
  engine = new SyncEngine(server, new MemoryStore(), "acct", {
    onChange: (c) => void tasks.onServerChange(c),
    onConflict: (c) => void tasks.onConflict(c),
  });
  tasks = new TaskSync({
    vault,
    engine,
    settings: () => settings,
    vaultName: "Vault",
    tz: () => TZ,
    newUid: () => `new-${++uidSeq}`,
    requestSync: () => undefined,
    notify: (m, kind, detail) => notices.push(`${kind}:${m}${detail ? `:${detail}` : ""}`),
    created: (path, uid) => created.push(`${path}:${uid}`),
  });
  await engine.init();
  tasks.rebuild();
  await tasks.pushAll();
  await cycle();
}

beforeEach(() => {
  server = new FakeServer();
  vault = new FakeVault();
  calendar = server.addCalendar("tasks");
  notices = [];
  created = [];
  uidSeq = 0;
  settings = { tasksFolder: "Tâches", reminderNoteLink: true, defaultCalendar: "" };
});

describe("from the server to notes", () => {
  it("gives a reminder made on the iPhone its note, and links the reminder back to it", async () => {
    const url = `${calendar}9EABE155-4E3A-467A-ACA6-830C40BEAB6B.ics`;
    server.externalPut(url, fixture("ios-new-reminder.ics"));
    await start();
    expect(vault.fm("Tâches/Test 6.md")).toEqual({
      type: "task",
      collection: "tasks",
      done: false,
      due: "2026-10-19T15:00",
      caldav_uid: "9EABE155-4E3A-467A-ACA6-830C40BEAB6B",
    });
    await engine.sync(); // pushes the link
    const back = readTask(server.stored(url)!.data, TZ)!;
    expect(back.url).toBe(taskLink("Vault", "9EABE155-4E3A-467A-ACA6-830C40BEAB6B"));
    expect(back.hasLinkLine).toBe(true);
    expect(server.stored(url)!.data).toContain("BEGIN:VALARM"); // iOS's alarm survives
  });

  it("skips tasks already done when first seen", async () => {
    server.externalPut(`${calendar}old.ics`, vtodo("old", "SUMMARY:Old\r\nSTATUS:COMPLETED\r\n"));
    await start();
    expect(vault.files.size).toBe(0);
  });

  it("follows changes made on the phone: ticked, moved, renamed", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Appeler Paul\r\nDUE;VALUE=DATE:20261020\r\n"));
    await start();
    vault.add("Notes/Daily.md", { mentions: "[[Appeler Paul]]" });
    server.externalPut(
      `${calendar}a.ics`,
      vtodo("a", "SUMMARY:Appeler Paul et Marie\r\nDUE;VALUE=DATE:20261021\r\nSTATUS:COMPLETED\r\n"),
    );
    await cycle();
    expect(vault.exists("Tâches/Appeler Paul.md")).toBe(false);
    expect(vault.fm("Tâches/Appeler Paul et Marie.md")).toMatchObject({ done: true, due: "2026-10-21" });
    expect(vault.fm("Notes/Daily.md")).toEqual({ mentions: "[[Appeler Paul et Marie]]" });
  });

  it("names duplicates with a suffix and doesn't rename them back", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Courses\r\n"));
    server.externalPut(`${calendar}b.ics`, vtodo("b", "SUMMARY:Courses\r\n"));
    await start();
    expect(vault.exists("Tâches/Courses.md") && vault.exists("Tâches/Courses (2).md")).toBe(true);
    await cycle();
    expect(onServer("a")!.summary).toBe("Courses");
    expect(onServer("b")!.summary).toBe("Courses");
  });

  it("marks the note done and unlinks it when the reminder is deleted on the phone", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    server.externalDelete(`${calendar}a.ics`);
    await cycle();
    expect(vault.fm("Tâches/A.md")).toEqual({ type: "task", done: true });
  });

  it("keeps the note when the reminder moves to another list (and back), whichever list is read first", async () => {
    const other = server.addCalendar("zz-other"); // read after "tasks"
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    server.externalDelete(`${calendar}a.ics`);
    server.externalPut(`${other}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ caldav_uid: "a", done: false, collection: "zz-other" });
    expect(vault.allNotes().map((n) => n.path)).toEqual(["Tâches/A.md"]);
    server.externalDelete(`${other}a.ics`);
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ caldav_uid: "a", done: false });
    // Edits go to where it is now.
    await vault.editFrontmatter("Tâches/A.md", (fm) => (fm.done = true));
    await tasks.noteChanged("Tâches/A.md");
    await tasks.whenIdle();
    await engine.sync();
    expect(onServer("a")?.done).toBe(true);
  });

  it("keeps a tick made here while the phone moved the reminder to another list", async () => {
    const other = server.addCalendar("zz-other");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    await cycle(); // the link to the note is pushed
    await vault.editFrontmatter("Tâches/A.md", (fm) => (fm.done = true));
    await tasks.noteChanged("Tâches/A.md"); // queued for the old place
    const onPhone = server.stored(`${calendar}a.ics`)!.data;
    server.externalDelete(`${calendar}a.ics`);
    server.externalPut(`${other}a.ics`, onPhone);
    await cycle();
    await cycle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ caldav_uid: "a", done: true });
    expect(readTask(server.stored(`${other}a.ics`)!.data, TZ)?.done).toBe(true);
    expect(vault.allNotes()).toHaveLength(1);
  });

  it("leaves notes alone when a whole calendar disappears", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    server.removeCalendar(calendar);
    await cycle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ caldav_uid: "a", done: false });
  });

  it("a list deleted here is its reminders deleted: the notes stay, done and unlinked", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    await engine.deleteCalendar(calendar);
    await tasks.whenIdle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ done: true });
    expect(vault.fm("Tâches/A.md")!.caldav_uid).toBeUndefined();
    expect(vault.allNotes()).toHaveLength(1);
  });
});

describe("from notes to the server", () => {
  it("creates the reminder for a new task note", async () => {
    await start();
    vault.add("Tâches/Préparer slides.md", { type: "task", done: false, due: "2026-10-20T14:00" });
    await tasks.noteChanged("Tâches/Préparer slides.md");
    expect(vault.fm("Tâches/Préparer slides.md")!.caldav_uid).toBe("new-1");
    await cycle();
    expect(onServer("new-1")).toMatchObject({ summary: "Préparer slides", due: "2026-10-20T14:00", done: false });
  });

  it("says when a new task note gets its UID (time blocks link to it)", async () => {
    await start();
    vault.add("Tâches/Rapport.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/Rapport.md");
    expect(created).toEqual(["Tâches/Rapport.md:new-1"]);
  });

  it("ticks, reschedules and renames", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/A.md", (fm) => {
      fm.done = true;
      fm.due = "2026-11-02";
    });
    await tasks.noteChanged("Tâches/A.md");
    await vault.rename("Tâches/A.md", "Tâches/A bis.md");
    await tasks.noteRenamed("Tâches/A.md", "Tâches/A bis.md");
    await cycle();
    expect(onServer("a")).toMatchObject({ summary: "A bis", done: true, due: "2026-11-02" });
  });

  it("deletes the reminder when the note is deleted", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    const fm = vault.fm("Tâches/A.md")!;
    vault.remove("Tâches/A.md");
    await tasks.noteDeleted("Tâches/A.md", fm);
    await cycle();
    expect(server.stored(`${calendar}a.ics`)).toBeUndefined();
  });

  it("says so when no calendar accepts tasks", async () => {
    server.removeCalendar(calendar);
    server.addCalendar("events", { components: ["VEVENT"] });
    await start();
    vault.add("Tâches/X.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/X.md");
    expect(notices).toEqual(["no-task-calendar:"]);
  });

  it("settles: nothing more to push once both sides agree", async () => {
    server.externalPut(`${calendar}a.ics`, fixture("ios-new-reminder.ics").replace(/UID:9EAB[^\r]*/, "UID:a"));
    await start();
    await engine.sync();
    await tasks.pushAll();
    await tasks.pullAll();
    expect(engine.pendingCount).toBe(0);
  });
});

describe("collections", () => {
  let pro: string;
  beforeEach(() => {
    pro = server.addCalendar("Pro");
    server.addCalendar("Events only", { components: ["VEVENT"] });
  });
  const at = (cal: string, uid: string) => server.stored(`${cal}${uid}.ics`);

  it("a new task goes to the default collection, and its note says which", async () => {
    settings.defaultCalendar = pro;
    await start();
    vault.add("Tâches/T.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/T.md");
    await cycle();
    expect(at(pro, "new-1")).toBeTruthy();
    expect(vault.fm("Tâches/T.md")).toMatchObject({ caldav_uid: "new-1", collection: "Pro" });
  });

  it("without a default, the first by name that holds tasks", async () => {
    await start();
    vault.add("Tâches/T.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/T.md");
    await cycle();
    expect(vault.fm("Tâches/T.md")!.collection).toBe("Pro"); // "Events only" can't hold it
  });

  it("goes where its note says, else with its parent, else with its project", async () => {
    settings.defaultCalendar = calendar;
    vault.add("Projets/Cours.md", { collection: "pro" }, { tags: ["project"] });
    server.externalPut(`${pro}parent.ics`, vtodo("parent", "SUMMARY:Parent\r\n"));
    await start();
    vault.add("Tâches/Named.md", { type: "task", done: false, collection: "Pro" });
    vault.add("Tâches/Child.md", { type: "task", done: false, parent: "[[Parent]]" });
    vault.add("Tâches/In project.md", { type: "task", done: false, project: "[[Cours]]" });
    vault.add("Tâches/Plain.md", { type: "task", done: false });
    for (const p of ["Named", "Child", "In project", "Plain"]) await tasks.noteChanged(`Tâches/${p}.md`);
    await cycle();
    expect(["Named", "Child", "In project", "Plain"].map((p) => vault.fm(`Tâches/${p}.md`)!.collection)).toEqual(["Pro", "Pro", "Pro", "tasks"]);
    expect([1, 2, 3].map((n) => !!at(pro, `new-${n}`))).toEqual([true, true, true]);
  });

  it("changing the collection in the note moves the task, same reminder, same note", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/A.md", (fm) => {
      fm.collection = "pro";
      fm.done = true;
    });
    await tasks.noteChanged("Tâches/A.md");
    await cycle();
    expect(at(calendar, "a")).toBeUndefined();
    expect(readTask(at(pro, "a")!.data, TZ)).toMatchObject({ uid: "a", done: true });
    expect(vault.fm("Tâches/A.md")).toMatchObject({ caldav_uid: "a", collection: "Pro" });
    expect(vault.allNotes()).toHaveLength(1);
    await cycle(); // and it stays there
    expect(at(pro, "a")).toBeTruthy();
  });

  it("a collection that doesn't exist (or holds no tasks) is told, and the task stays", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    for (const name of ["Nope", "Events only"]) {
      await vault.editFrontmatter("Tâches/A.md", (fm) => (fm.collection = name));
      await tasks.noteChanged("Tâches/A.md");
      await tasks.noteChanged("Tâches/A.md"); // told once
    }
    await cycle();
    expect(notices).toEqual(["no-collection:A:Nope", "no-collection:A:Events only"]);
    expect(at(calendar, "a")).toBeTruthy();
  });

  it("a collection renamed is renamed in the notes, without moving anything", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    await engine.updateCalendar(calendar, { displayName: "Général" });
    await tasks.pullAll();
    expect(vault.fm("Tâches/A.md")!.collection).toBe("Général");
    await tasks.noteChanged("Tâches/A.md");
    await cycle();
    expect(at(calendar, "a")).toBeTruthy();
    expect(notices).toEqual([]);
  });
});

describe("priority", () => {
  const level = (uid: string) => /PRIORITY:(\d)/.exec(server.stored(`${calendar}${uid}.ics`)!.data)?.[1] ?? null;

  it("syncs both ways, as PRIORITY on the server and high / medium / low in the note", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nPRIORITY:1\r\n"));
    await start();
    expect(vault.fm("Tâches/Rapport.md")).toMatchObject({ priority: "high" });
    await vault.editFrontmatter("Tâches/Rapport.md", (fm) => (fm.priority = "basse"));
    await tasks.noteChanged("Tâches/Rapport.md");
    await cycle();
    expect(level("a")).toBe("9");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nPRIORITY:0\r\n"));
    await cycle();
    expect(vault.fm("Tâches/Rapport.md")?.priority).toBeUndefined();
  });

  it("leaves the server alone when the note says something else", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nPRIORITY:5\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/Rapport.md", (fm) => (fm.priority = "urgent"));
    await tasks.noteChanged("Tâches/Rapport.md");
    await cycle();
    expect(level("a")).toBe("5");
  });
});

describe("repeating tasks", () => {
  const rule = (uid: string) => /RRULE:([^\r\n]+)/.exec(server.stored(`${calendar}${uid}.ics`)!.data)?.[1] ?? null;

  it("syncs the repetition both ways, as RRULE on the server and a phrase in the note", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=WEEKLY;INTERVAL=1\r\n"));
    await start();
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ repeat: "every week" });
    await vault.editFrontmatter("Tâches/Sport.md", (fm) => (fm.repeat = "chaque lundi et jeudi"));
    await tasks.noteChanged("Tâches/Sport.md");
    await cycle();
    expect(rule("a")).toBe("FREQ=WEEKLY;BYDAY=MO,TH");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=DAILY\r\n"));
    await cycle();
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ repeat: "every day" });
  });

  it("doesn't push back iOS's own spelling of the same rule", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO\r\n"));
    await start();
    await engine.sync(); // our link
    server.calls = [];
    await tasks.noteChanged("Tâches/Sport.md");
    await cycle();
    expect(server.calls.filter((c) => c.startsWith("put"))).toEqual([]);
  });

  it("comes back at its next date when ticked here", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=WEEKLY\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/Sport.md", (fm) => (fm.done = true));
    await tasks.noteChanged("Tâches/Sport.md");
    await cycle();
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2027-01-11" });
    expect(onServer("a")).toMatchObject({ done: false, due: "2027-01-11", repeat: "FREQ=WEEKLY" });
    expect(notices).toEqual(["next:Sport:2027-01-11"]);
  });

  it("moves on when the phone ticks it without doing so", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=WEEKLY\r\n"));
    await start();
    server.externalPut(
      `${calendar}a.ics`,
      vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20270104\r\nDUE;VALUE=DATE:20270104\r\nRRULE:FREQ=WEEKLY\r\nSTATUS:COMPLETED\r\n"),
    );
    await cycle();
    await cycle();
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2027-01-11" });
    expect(onServer("a")).toMatchObject({ done: false, due: "2027-01-11" });
  });
});

describe("projects and sub-tasks", () => {
  beforeEach(() => {
    vault.add("Projets/Olera.md", { kind: "project" }, { tags: ["project"] });
    vault.add("Notes/Random.md", {});
  });

  it("sends the project as a category, and only real projects", async () => {
    await start();
    vault.add("Tâches/T1.md", { type: "task", done: false, project: "[[Olera]]" });
    vault.add("Tâches/T2.md", { type: "task", done: false, project: "[[Random]]" });
    await tasks.noteChanged("Tâches/T1.md");
    await tasks.noteChanged("Tâches/T2.md");
    await cycle();
    expect(onServer("new-1")!.categories).toEqual(["Olera"]);
    expect(onServer("new-2")!.categories).toEqual([]);
    expect(vault.fm("Tâches/T2.md")!.project).toBe("[[Random]]"); // kept, just not synced
  });

  it("turns a project category into a project link, ignoring other categories", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nCATEGORIES:Work,Olera\r\n"));
    await start();
    expect(vault.fm("Tâches/A.md")!.project).toBe("[[Olera]]");
    await cycle();
    expect(onServer("a")!.categories).toEqual(["Work", "Olera"]); // Work untouched
  });

  it("links sub-tasks both ways", async () => {
    server.externalPut(`${calendar}child.ics`, vtodo("child", "SUMMARY:Child\r\nRELATED-TO:parent\r\n"));
    server.externalPut(`${calendar}parent.ics`, vtodo("parent", "SUMMARY:Parent\r\n"));
    await start();
    expect(vault.fm("Tâches/Child.md")!.parent).toBe("[[Parent]]");

    vault.add("Tâches/New child.md", { type: "task", done: false, parent: "[[Parent]]" });
    await tasks.noteChanged("Tâches/New child.md");
    await cycle();
    expect(onServer("new-1")!.parentUid).toBe("parent");
  });
});

describe("conflicts", () => {
  it("merges: a field changed here and another changed there both survive", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nDUE;VALUE=DATE:20261020\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/Rapport.md", (fm) => (fm.done = true));
    await tasks.noteChanged("Tâches/Rapport.md");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport final\r\nDUE;VALUE=DATE:20261020\r\n"));
    await cycle();
    await cycle();
    expect(onServer("a")).toMatchObject({ summary: "Rapport final", done: true });
    expect(vault.fm("Tâches/Rapport final.md")).toMatchObject({ done: true });
    expect(notices).toEqual([]);
  });

  it("lets the server win when both changed the same field, and says so", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nDUE;VALUE=DATE:20261020\r\n"));
    await start();
    await vault.editFrontmatter("Tâches/Rapport.md", (fm) => (fm.due = "2026-10-25"));
    await tasks.noteChanged("Tâches/Rapport.md");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Rapport\r\nDUE;VALUE=DATE:20261022\r\n"));
    await cycle();
    await cycle();
    expect(onServer("a")!.due).toBe("2026-10-22");
    expect(vault.fm("Tâches/Rapport.md")!.due).toBe("2026-10-22");
    expect(notices).toEqual(["clash:Rapport"]);
  });
});
