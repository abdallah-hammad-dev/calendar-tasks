import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { MemoryStore } from "../src/sync/store";
import { noteUid } from "../src/tasks/notes";
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
/** The UID of the reminder of a task note made outside the plugin. */
const uidOf = (path: string) => noteUid("Vault", path);
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
      created: "2026-10-15T05:10", // CREATED:20261015T031024Z, in Paris
      caldav_uid: "9EABE155-4E3A-467A-ACA6-830C40BEAB6B",
    });
    await engine.sync(); // pushes the link
    const back = readTask(server.stored(url)!.data, TZ)!;
    expect(back.url).toBe(taskLink("Vault", "9EABE155-4E3A-467A-ACA6-830C40BEAB6B"));
    expect(back.hasLinkLine).toBe(true);
    expect(server.stored(url)!.data).toContain("BEGIN:VALARM"); // iOS's alarm survives
  });

  it("gives the note the reminder's creation date once, and never overwrites it", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Timbres\r\nCREATED:20261020T163000Z\r\n"));
    server.externalPut(`${calendar}b.ics`, vtodo("b", "SUMMARY:Sans CREATED\r\n"));
    await start();
    expect(vault.fm("Tâches/Timbres.md")!.created).toBe("2026-10-20T18:30");
    expect(vault.fm("Tâches/Sans CREATED.md")!.created).toBeUndefined();
    await vault.editFrontmatter("Tâches/Timbres.md", (fm) => (fm.created = "2026-10-01"));
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Timbres\r\nCREATED:20261020T163000Z\r\nSTATUS:COMPLETED\r\n"));
    await cycle();
    expect(vault.fm("Tâches/Timbres.md")).toMatchObject({ done: true, created: "2026-10-01" });
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

  it("doesn't bring a reminder deleted on the phone back when its note changes or Obsidian restarts", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    server.externalPut(`${calendar}r.ics`, vtodo("r", "SUMMARY:R\r\nDTSTART;VALUE=DATE:20261020\r\nDUE;VALUE=DATE:20261020\r\nRRULE:FREQ=WEEKLY\r\n"));
    await start();
    server.externalDelete(`${calendar}a.ics`);
    server.externalDelete(`${calendar}r.ics`);
    await cycle();
    await tasks.noteChanged("Tâches/A.md"); // what the unlinking write triggers in Obsidian
    await tasks.noteChanged("Tâches/R.md");
    await tasks.pushAll(); // next startup
    await cycle();
    expect(onServer(uidOf("Tâches/A.md"))).toBeNull();
    expect(onServer(uidOf("Tâches/R.md"))).toBeNull();
    expect(vault.fm("Tâches/R.md")).toMatchObject({ done: true, due: "2026-10-20" }); // not moved on
    expect(vault.fm("Tâches/R.md")!.caldav_uid).toBeUndefined();
  });

  it("gives a deleted reminder's note a new reminder when it's unticked", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    server.externalDelete(`${calendar}a.ics`);
    await cycle();
    await vault.editFrontmatter("Tâches/A.md", (fm) => (fm.done = false));
    await tasks.noteChanged("Tâches/A.md");
    await tasks.whenIdle();
    await engine.sync();
    expect(onServer(uidOf("Tâches/A.md"))).toMatchObject({ summary: "A", done: false });
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
    expect(vault.fm("Tâches/Préparer slides.md")!.caldav_uid).toBe(uidOf("Tâches/Préparer slides.md"));
    await cycle();
    expect(onServer(uidOf("Tâches/Préparer slides.md"))).toMatchObject({ summary: "Préparer slides", due: "2026-10-20T14:00", done: false });
  });

  it("creates one reminder when a new note is pushed again before Obsidian re-read it", async () => {
    await start();
    vault.add("Tâches/Rapport.md", { type: "task", done: false });
    vault.lag("Tâches/Rapport.md"); // reads without its UID until Obsidian parses what's written
    await tasks.noteChanged("Tâches/Rapport.md");
    await tasks.noteChanged("Tâches/Rapport.md");
    vault.catchUp("Tâches/Rapport.md");
    await tasks.noteChanged("Tâches/Rapport.md");
    await cycle();
    expect(vault.fm("Tâches/Rapport.md")!.caldav_uid).toBe(uidOf("Tâches/Rapport.md"));
    expect(server.stored(`${calendar}new-1.ics`)).toBeUndefined();
    expect(created).toEqual([`Tâches/Rapport.md:${uidOf("Tâches/Rapport.md")}`]);
  });

  it("dates a new task note, here and on the server; a note that says when it was made keeps it", async () => {
    await start();
    vault.add("Tâches/Rapport.md", { type: "task", done: false });
    vault.add("Tâches/Ancienne.md", { type: "task", done: false, created: "2026-10-01T09:30" });
    await tasks.noteChanged("Tâches/Rapport.md");
    await tasks.noteChanged("Tâches/Ancienne.md");
    await cycle();
    const made = vault.fm("Tâches/Rapport.md")!.created;
    expect(made).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(onServer(uidOf("Tâches/Rapport.md"))!.created).toBe(made);
    expect(vault.fm("Tâches/Ancienne.md")!.created).toBe("2026-10-01T09:30");
    expect(onServer(uidOf("Tâches/Ancienne.md"))!.created).toBe("2026-10-01T09:30");
  });

  it("says when a new task note gets its UID (time blocks link to it)", async () => {
    await start();
    vault.add("Tâches/Rapport.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/Rapport.md");
    expect(created).toEqual([`Tâches/Rapport.md:${uidOf("Tâches/Rapport.md")}`]);
  });

  it("a task made by the plugin is written with its reminder: the note's first version has its UID", async () => {
    await start();
    await tasks.createNote("Tâches/Appeler Paul.md", { type: "task", done: false, due: "2026-10-31" }, "Pour le devis");
    const fm = vault.fm("Tâches/Appeler Paul.md")!;
    expect(fm).toMatchObject({ type: "task", due: "2026-10-31", caldav_uid: "new-1", collection: "tasks" });
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(vault.files.get("Tâches/Appeler Paul.md")!.body).toBe("Pour le devis");
    expect(created).toEqual(["Tâches/Appeler Paul.md:new-1"]);
    await tasks.noteChanged("Tâches/Appeler Paul.md"); // Obsidian sees it appear
    await cycle();
    expect(onServer("new-1")).toMatchObject({ summary: "Appeler Paul", due: "2026-10-31", created: fm.created });
    expect(await server.listEtags(calendar)).toHaveLength(1);
  });

  it("a task the plugin can't write leaves no reminder; without a collection, it's written as it is", async () => {
    await start();
    vault.add("Tâches/Pris.md", { type: "note" });
    await expect(tasks.createNote("Tâches/Pris.md", { type: "task", done: false }, "")).rejects.toThrow(/exists/);
    await cycle();
    expect(await server.listEtags(calendar)).toHaveLength(0);
    expect(created).toEqual([]);

    server.removeCalendar(calendar);
    await engine.sync();
    await tasks.createNote("Tâches/Sans liste.md", { type: "task", done: false }, "");
    expect(vault.fm("Tâches/Sans liste.md")).toEqual({ type: "task", done: false });
  });

  it("a note made by hand where a renamed one was gets its own reminder", async () => {
    await start();
    vault.add("Tâches/A.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/A.md");
    await vault.rename("Tâches/A.md", "Tâches/B.md");
    await tasks.noteRenamed("Tâches/A.md", "Tâches/B.md");
    vault.add("Tâches/A.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/A.md");
    await cycle();
    expect(vault.fm("Tâches/B.md")!.caldav_uid).toBe(uidOf("Tâches/A.md"));
    expect(vault.fm("Tâches/A.md")!.caldav_uid).toBe("new-1");
    expect(onServer("new-1")).toMatchObject({ summary: "A" });
    expect(onServer(uidOf("Tâches/A.md"))).toMatchObject({ summary: "B" });
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

  it("a deadline set from the calendar changes the reminder at once, then the note", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nDUE;TZID=Europe/Paris:20261020T140000\r\n"));
    await start();
    const url = `${calendar}a.ics`;
    const done = tasks.setDue("Tâches/A.md", "2026-10-22T16:00");
    await done;
    // The calendar draws from the cached reminder: it's there before any sync or note debounce.
    expect(readTask(engine.item(url)!.data, TZ)!.due).toBe("2026-10-22T16:00");
    expect(vault.fm("Tâches/A.md")).toMatchObject({ due: "2026-10-22T16:00" });
    await tasks.noteChanged("Tâches/A.md"); // the note's own change, later: nothing more to push
    await cycle();
    expect(onServer("a")!.due).toBe("2026-10-22T16:00");
    await tasks.setDue("Tâches/A.md", null);
    expect(readTask(engine.item(url)!.data, TZ)!.due).toBeNull();
    expect(vault.fm("Tâches/A.md")).not.toHaveProperty("due");
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
    expect(at(pro, uidOf("Tâches/T.md"))).toBeTruthy();
    expect(vault.fm("Tâches/T.md")).toMatchObject({ caldav_uid: uidOf("Tâches/T.md"), collection: "Pro" });
  });

  it("without a default, the first by name that holds tasks", async () => {
    await start();
    vault.add("Tâches/T.md", { type: "task", done: false });
    await tasks.noteChanged("Tâches/T.md");
    await cycle();
    expect(vault.fm("Tâches/T.md")!.collection).toBe("Pro"); // "Events only" can't hold it
  });

  it("goes where its note says, else with its parent, else to the default", async () => {
    settings.defaultCalendar = calendar;
    server.externalPut(`${pro}parent.ics`, vtodo("parent", "SUMMARY:Parent\r\n"));
    await start();
    vault.add("Tâches/Named.md", { type: "task", done: false, collection: "Pro" });
    vault.add("Tâches/Child.md", { type: "task", done: false, parent: "[[Parent]]" });
    vault.add("Tâches/Plain.md", { type: "task", done: false, tags: ["pro"] }); // a tag isn't a collection
    for (const p of ["Named", "Child", "Plain"]) await tasks.noteChanged(`Tâches/${p}.md`);
    await cycle();
    expect(["Named", "Child", "Plain"].map((p) => vault.fm(`Tâches/${p}.md`)!.collection)).toEqual(["Pro", "Pro", "tasks"]);
    expect(["Named", "Child"].map((p) => !!at(pro, uidOf(`Tâches/${p}.md`)))).toEqual([true, true]);
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
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2027-01-11" });
    await engine.sync();
    expect(onServer("a")).toMatchObject({ done: false, due: "2027-01-11" });
    // Once: the ticked copy isn't put back (it was, to add our link, and the next pull moved it on again).
    expect(notices).toEqual(["next:Sport:2027-01-11"]);
  });
});

describe("when a task was ticked", () => {
  /** The clock, in Paris (winter time from 2026-10-25 03:00). */
  const at = (local: string) => vi.setSystemTime(new Date(`${local}:00+01:00`));
  const tick = async (path: string, done: boolean) => {
    await vault.editFrontmatter(path, (fm) => (fm.done = done)); // as Bases or the properties do: no time said
    await tasks.noteChanged(path);
    await cycle();
  };
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("keeps when it was ticked here, in the note and as COMPLETED; unticked it goes, ticked again it's the new time", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    at("2026-10-25T14:32");
    await tick("Tâches/A.md", true);
    expect(vault.fm("Tâches/A.md")).toMatchObject({ done: true, completed: "2026-10-25T14:32" });
    expect(onServer("a")!.completed).toBe("2026-10-25T14:32");
    await tick("Tâches/A.md", false);
    expect(vault.fm("Tâches/A.md")!.completed).toBeUndefined();
    expect(onServer("a")!.completed).toBeNull();
    at("2026-10-26T09:00");
    await tick("Tâches/A.md", true);
    expect(vault.fm("Tâches/A.md")!.completed).toBe("2026-10-26T09:00");
    expect(onServer("a")!.completed).toBe("2026-10-26T09:00");
  });

  it("takes the phone's time when it's ticked there, and drops it when it's unticked there", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await start();
    at("2026-10-25T18:00");
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261025T080000Z\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")).toMatchObject({ done: true, completed: "2026-10-25T09:00" });
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nSTATUS:NEEDS-ACTION\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")!.done).toBe(false);
    expect(vault.fm("Tâches/A.md")!.completed).toBeUndefined();
  });

  it("never guesses: a note done before, without a reminder, gets no time; one with a ticked reminder gets its time", async () => {
    vault.add("Tâches/Vieille.md", { type: "task", done: true });
    server.externalPut(`${calendar}b.ics`, vtodo("b", "SUMMARY:B\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261001T070000Z\r\n"));
    vault.add("Tâches/B.md", { type: "task", done: true, caldav_uid: "b" });
    at("2026-10-25T14:32");
    await start();
    expect(vault.fm("Tâches/Vieille.md")!.completed).toBeUndefined();
    expect(vault.fm("Tâches/B.md")!.completed).toBe("2026-10-01T09:00");
  });

  it("counts a tick once when it's pushed again before Obsidian re-read the note", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20261101\r\nDUE;VALUE=DATE:20261101\r\nRRULE:FREQ=DAILY\r\n"));
    await start();
    at("2026-10-25T22:59");
    await vault.editFrontmatter("Tâches/Sport.md", (fm) => (fm.done = true));
    vault.lag("Tâches/Sport.md"); // reads "done" until Obsidian parses what's written next
    await tasks.noteChanged("Tâches/Sport.md");
    await tasks.noteChanged("Tâches/Sport.md");
    vault.catchUp("Tâches/Sport.md");
    await cycle();
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2026-11-02", completions: ["2026-10-25T22:59"] });
    expect(notices).toEqual(["next:Sport:2026-11-02"]);
    expect(onServer("a")).toMatchObject({ done: false, due: "2026-11-02" });
  });

  it("a repeating task keeps each time it was done, here or on the phone", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20261026\r\nDUE;VALUE=DATE:20261026\r\nRRULE:FREQ=WEEKLY\r\n"));
    await start();
    at("2026-10-26T19:15");
    await tick("Tâches/Sport.md", true);
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2026-11-02", completions: ["2026-10-26T19:15"] });
    expect(vault.fm("Tâches/Sport.md")!.completed).toBeUndefined();
    expect(onServer("a")!.completed).toBeNull();
    at("2026-11-02T20:00");
    server.externalPut(
      `${calendar}a.ics`,
      vtodo("a", "SUMMARY:Sport\r\nDTSTART;VALUE=DATE:20261102\r\nDUE;VALUE=DATE:20261102\r\nRRULE:FREQ=WEEKLY\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261102T180500Z\r\n"),
    );
    await cycle();
    expect(notices.filter((n) => n.startsWith("next:"))).toEqual(["next:Sport:2026-11-02", "next:Sport:2026-11-09"]); // once each
    expect(vault.fm("Tâches/Sport.md")).toMatchObject({ done: false, due: "2026-11-09", completions: ["2026-10-26T19:15", "2026-11-02T19:05"] });
  });
});

describe("tags and sub-tasks", () => {
  it("sends the note's tags as categories", async () => {
    await start();
    vault.add("Tâches/T1.md", { type: "task", done: false, tags: ["famille", "#urgent"] });
    vault.add("Tâches/T2.md", { type: "task", done: false, tags: "maison" });
    await tasks.noteChanged("Tâches/T1.md");
    await tasks.noteChanged("Tâches/T2.md");
    await cycle();
    expect(onServer(uidOf("Tâches/T1.md"))!.categories).toEqual(["famille", "urgent"]);
    expect(onServer(uidOf("Tâches/T2.md"))!.categories).toEqual(["maison"]);
  });

  it("turns categories into tags, keeping the reminder's spelling and what can't be a tag", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nCATEGORIES:Work stuff,Famille,2026\r\n"));
    await start();
    expect(vault.fm("Tâches/A.md")!.tags).toEqual(["Work-stuff", "Famille"]);
    await cycle();
    expect(onServer("a")!.categories).toEqual(["Work stuff", "Famille", "2026"]); // untouched: no echo

    await vault.editFrontmatter("Tâches/A.md", (fm) => (fm.tags = ["famille", "urgent"]));
    await tasks.noteChanged("Tâches/A.md");
    await cycle();
    expect(onServer("a")!.categories).toEqual(["Famille", "2026", "urgent"]);
    expect(vault.fm("Tâches/A.md")!.tags).toEqual(["famille", "urgent"]); // the note's case stays
  });

  it("follows tags changed on the phone, and takes them all off", async () => {
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nCATEGORIES:famille\r\n"));
    await start();
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\nCATEGORIES:famille,urgent\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")!.tags).toEqual(["famille", "urgent"]);
    server.externalPut(`${calendar}a.ics`, vtodo("a", "SUMMARY:A\r\n"));
    await cycle();
    expect(vault.fm("Tâches/A.md")!.tags).toBeUndefined();
  });

  it("links sub-tasks both ways", async () => {
    server.externalPut(`${calendar}child.ics`, vtodo("child", "SUMMARY:Child\r\nRELATED-TO:parent\r\n"));
    server.externalPut(`${calendar}parent.ics`, vtodo("parent", "SUMMARY:Parent\r\n"));
    await start();
    expect(vault.fm("Tâches/Child.md")!.parent).toBe("[[Parent]]");

    vault.add("Tâches/New child.md", { type: "task", done: false, parent: "[[Parent]]" });
    await tasks.noteChanged("Tâches/New child.md");
    await cycle();
    expect(onServer(uidOf("Tâches/New child.md"))!.parentUid).toBe("parent");
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

describe("two devices, LiveSync copying notes between them", () => {
  interface Device {
    vault: FakeVault;
    engine: SyncEngine;
    tasks: TaskSync;
    made: string[];
  }
  let seq: number;
  beforeEach(() => (seq = 0));

  async function device(name: string): Promise<Device> {
    const d = { vault: new FakeVault(), made: [] as string[] } as Device;
    d.engine = new SyncEngine(server, new MemoryStore(), "acct", {
      onChange: (c) => void d.tasks.onServerChange(c),
      onConflict: (c) => void d.tasks.onConflict(c),
    });
    d.tasks = new TaskSync({
      vault: d.vault,
      engine: d.engine,
      settings: () => settings,
      vaultName: "Vault",
      tz: () => TZ,
      newUid: () => `${name}-${++seq}`,
      requestSync: () => undefined,
      notify: (m, kind) => notices.push(`${kind}:${m}`),
      created: (path, uid) => d.made.push(`${path}:${uid}`),
    });
    await d.engine.init();
    d.tasks.rebuild();
    await sync(d);
    return d;
  }
  async function sync(d: Device): Promise<void> {
    await d.engine.sync();
    await d.tasks.whenIdle();
    await d.tasks.pullAll();
  }
  /** LiveSync brings the note as it is on `from` now. */
  const copy = (from: Device, to: Device, path: string) => to.vault.add(path, from.vault.fm(path)!, { body: from.vault.files.get(path)!.body });
  const reminders = async () => (await server.listEtags(calendar)).length;
  const P = "Tâches/Courses.md";

  it("a task made with the plugin reaches the other device with its UID: one reminder, one note", async () => {
    const pc = await device("pc");
    const phone = await device("phone");
    await pc.tasks.createNote(P, { type: "task", done: false, due: "2026-10-31" }, "");
    copy(pc, phone, P); // before the PC's next sync
    await phone.tasks.noteChanged(P);
    await sync(phone);
    await sync(pc);
    await sync(phone);
    expect(await reminders()).toBe(1);
    expect(onServer("pc-1")).toMatchObject({ summary: "Courses", due: "2026-10-31" });
    expect([...phone.vault.files.keys()]).toEqual([P]);
    expect(phone.vault.fm(P)).toEqual(pc.vault.fm(P));
    expect(phone.made).toEqual([]);
  });

  it("the other device pulling the reminder before it looked at the note makes no second note", async () => {
    const pc = await device("pc");
    const phone = await device("phone");
    await pc.tasks.createNote(P, { type: "task", done: false }, "");
    copy(pc, phone, P);
    await sync(pc);
    await sync(phone);
    expect([...phone.vault.files.keys()]).toEqual([P]);
    await phone.tasks.noteChanged(P);
    await sync(phone);
    expect(await reminders()).toBe(1);
  });

  it("a note made by hand, seen by both before either wrote its UID: one reminder", async () => {
    const pc = await device("pc");
    const phone = await device("phone");
    pc.vault.add(P, { type: "task", done: false, due: "2026-11-02" });
    copy(pc, phone, P);
    await pc.tasks.noteChanged(P);
    await phone.tasks.noteChanged(P);
    await sync(pc);
    await sync(phone); // its push is refused: the PC's is there
    await sync(pc);
    expect(await reminders()).toBe(1);
    expect(onServer(uidOf(P))).toMatchObject({ summary: "Courses", due: "2026-11-02" });
    for (const d of [pc, phone]) {
      expect([...d.vault.files.keys()]).toEqual([P]);
      expect(d.vault.fm(P)!.caldav_uid).toBe(uidOf(P));
    }
  });

  it("a note made by hand whose reminder the other device pulls first: that note gets it", async () => {
    const pc = await device("pc");
    const phone = await device("phone");
    pc.vault.add(P, { type: "task", done: false });
    copy(pc, phone, P); // without its UID
    await pc.tasks.noteChanged(P);
    await sync(pc);
    await sync(phone);
    expect([...phone.vault.files.keys()]).toEqual([P]);
    expect(phone.vault.fm(P)!.caldav_uid).toBe(uidOf(P));
    await phone.tasks.noteChanged(P);
    await sync(phone);
    expect(await reminders()).toBe(1);
  });

  it("ticked on the other device before this one looked at the note: it stays ticked", async () => {
    const pc = await device("pc");
    const phone = await device("phone");
    pc.vault.add(P, { type: "task", done: false });
    copy(pc, phone, P);
    await pc.tasks.noteChanged(P);
    await sync(pc);
    await pc.vault.editFrontmatter(P, (fm) => (fm.done = true));
    await pc.tasks.noteChanged(P);
    await sync(pc);
    await phone.tasks.noteChanged(P); // still the copy without UID, not done
    await sync(phone);
    expect(await reminders()).toBe(1);
    expect(onServer(uidOf(P))!.done).toBe(true);
    expect(phone.vault.fm(P)).toMatchObject({ done: true, caldav_uid: uidOf(P) });
  });
});
