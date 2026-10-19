import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type CalendarChange, type Conflict } from "../src/sync/engine";
import { MemoryStore } from "../src/sync/store";
import { FakeServer } from "./support/fake-server";

const ics = (uid: string, summary = uid) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;

let server: FakeServer;
let store: MemoryStore;
let changes: CalendarChange[];
let conflicts: Conflict[];
let tasks: string;

function engine(account = "acct"): SyncEngine {
  return new SyncEngine(server, store, account, {
    onChange: (c) => changes.push(c),
    onConflict: (c) => conflicts.push(c),
  });
}

async function started(): Promise<SyncEngine> {
  const e = engine();
  await e.init();
  expect((await e.sync()).ok).toBe(true);
  return e;
}

beforeEach(() => {
  server = new FakeServer();
  store = new MemoryStore();
  changes = [];
  conflicts = [];
  tasks = server.addCalendar("tasks");
});

describe("pulling", () => {
  it("downloads everything on the first sync", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    server.externalPut(`${tasks}b.ics`, ics("b"));
    const e = await started();
    expect(e.calendars().map((c) => c.info.displayName)).toEqual(["tasks"]);
    expect(Object.keys(e.calendars()[0]!.items).sort()).toEqual([`${tasks}a.ics`, `${tasks}b.ics`]);
    expect(changes).toEqual([{ calendarUrl: tasks, added: [`${tasks}a.ics`, `${tasks}b.ics`], updated: [], removed: [] }]);
  });

  it("skips the calendar entirely when its token hasn't moved", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    server.calls = [];
    await e.sync();
    expect(server.calls).toEqual(["listCalendars"]);
  });

  it("picks up changes and removals made elsewhere", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    server.externalPut(`${tasks}b.ics`, ics("b"));
    const e = await started();
    changes = [];
    server.externalPut(`${tasks}a.ics`, ics("a", "renamed on the iPhone"));
    server.externalDelete(`${tasks}b.ics`);
    server.externalPut(`${tasks}c.ics`, ics("c"));
    await e.sync();
    expect(changes).toEqual([
      { calendarUrl: tasks, added: [`${tasks}c.ics`], updated: [`${tasks}a.ics`], removed: [`${tasks}b.ics`] },
    ]);
    expect(e.item(`${tasks}a.ics`)?.data).toContain("renamed on the iPhone");
  });

  it("starts over when the server forgot our token", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    server.externalPut(`${tasks}b.ics`, ics("b"));
    const e = await started();
    server.externalDelete(`${tasks}b.ics`);
    server.forgetTokens();
    changes = [];
    await e.sync();
    expect(Object.keys(e.calendars()[0]!.items)).toEqual([`${tasks}a.ics`]);
    expect(changes).toEqual([{ calendarUrl: tasks, added: [], updated: [], removed: [`${tasks}b.ics`] }]);
  });

  it("starts over when the server silently echoes a token it can't serve (sabre/dav)", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    server.echoUnknownTokens = true;
    server.forgetTokens();
    server.externalPut(`${tasks}b.ics`, ics("b"));
    await e.sync();
    expect(e.item(`${tasks}b.ics`)).toBeDefined();
    server.calls = [];
    await e.sync();
    expect(server.calls).toEqual(["listCalendars"]); // and the new token is a good one
  });

  it("doesn't trust a full listing that suddenly comes back empty until the next sync confirms it", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    server.externalPut(`${tasks}b.ics`, ics("b"));
    const e = await started();
    server.externalDelete(`${tasks}a.ics`);
    server.externalDelete(`${tasks}b.ics`);
    server.forgetTokens(); // forces a full listing, which is now empty
    changes = [];
    await e.sync();
    expect(Object.keys(e.calendars()[0]!.items)).toHaveLength(2); // kept: could be a server hiccup
    expect(changes).toEqual([]);
    await e.sync();
    expect(e.calendars()[0]!.items).toEqual({}); // confirmed
    expect(changes).toEqual([{ calendarUrl: tasks, added: [], updated: [], removed: [`${tasks}a.ics`, `${tasks}b.ics`] }]);
  });

  it("falls back to etag listings without sync-collection", async () => {
    server.supportsSync = false;
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    server.externalPut(`${tasks}a.ics`, ics("a", "v2"));
    await e.sync();
    expect(server.calls.filter((c) => c === "listEtags")).toHaveLength(2);
    expect(e.item(`${tasks}a.ics`)?.data).toContain("v2");
    server.calls = [];
    await e.sync();
    expect(server.calls).toEqual(["listCalendars"]); // unchanged ctag: nothing to list
  });

  it("forgets calendars removed from the server", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    server.removeCalendar(tasks);
    changes = [];
    await e.sync();
    expect(e.calendars()).toEqual([]);
    expect(changes).toEqual([
      { calendarUrl: tasks, added: [], updated: [], removed: [`${tasks}a.ics`], calendarRemoved: true },
    ]);
  });
});

describe("pushing", () => {
  it("creates new items and doesn't re-download them", async () => {
    const e = await started();
    const url = e.newItemUrl(tasks, "new task/1");
    expect(url).toBe(`${tasks}new_task_1.ics`);
    await e.putItem(tasks, url, ics("new task/1"));
    expect(e.pendingCount).toBe(1);
    changes = [];
    server.calls = [];
    const r = await e.sync();
    expect(r).toMatchObject({ ok: true, pushed: 1, pending: 0 });
    expect(server.stored(url)?.data).toBe(ics("new task/1"));
    expect(server.calls).toContain("put create");
    expect(server.calls.some((c) => c.startsWith("multiget"))).toBe(false);
    expect(changes).toEqual([]); // our own change is not reported back
  });

  it("updates with the etag it last saw", async () => {
    const etag = server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    await e.putItem(tasks, `${tasks}a.ics`, ics("a", "done"));
    await e.sync();
    expect(server.stored(`${tasks}a.ics`)?.data).toContain("done");
    expect(server.stored(`${tasks}a.ics`)?.etag).not.toBe(etag);
    expect(e.item(`${tasks}a.ics`)?.etag).toBe(server.stored(`${tasks}a.ics`)?.etag);
  });

  it("keeps the server's version on conflict and says so", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    server.externalPut(`${tasks}a.ics`, ics("a", "changed on the iPhone"));
    await e.putItem(tasks, `${tasks}a.ics`, ics("a", "changed in Obsidian"));
    const r = await e.sync();
    expect(r).toMatchObject({ ok: true, conflicts: 1, pending: 0 });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.server?.data).toContain("changed on the iPhone");
    expect(e.item(`${tasks}a.ics`)?.data).toContain("changed on the iPhone");
    expect(server.stored(`${tasks}a.ics`)?.data).toContain("changed on the iPhone");
  });

  it("deletes, and treats a conflicting delete as a conflict", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    server.externalPut(`${tasks}b.ics`, ics("b"));
    const e = await started();
    await e.deleteItem(`${tasks}a.ics`);
    server.externalPut(`${tasks}b.ics`, ics("b", "v2"));
    await e.deleteItem(`${tasks}b.ics`);
    expect(e.item(`${tasks}a.ics`)).toBeUndefined();
    await e.sync();
    expect(server.stored(`${tasks}a.ics`)).toBeUndefined();
    expect(server.stored(`${tasks}b.ics`)?.data).toContain("v2");
    expect(e.item(`${tasks}b.ics`)?.data).toContain("v2"); // restored
    expect(conflicts.map((c) => c.op.kind)).toEqual(["delete"]);
  });

  it("never sends an item created and deleted before syncing", async () => {
    const e = await started();
    const url = e.newItemUrl(tasks, "temp");
    await e.putItem(tasks, url, ics("temp"));
    await e.deleteItem(url);
    server.calls = [];
    await e.sync();
    expect(e.pendingCount).toBe(0);
    expect(server.calls.filter((c) => c.startsWith("put") || c === "delete")).toEqual([]);
  });

  it("keeps local changes while offline and pushes them later", async () => {
    const e = await started();
    const url = e.newItemUrl(tasks, "offline");
    server.offline = true;
    await e.putItem(tasks, url, ics("offline"));
    const r = await e.sync();
    expect(r).toMatchObject({ ok: false, error: "Network is down", pending: 1 });

    // Survives a restart (the queue is persisted).
    const again = engine();
    await again.init();
    server.offline = false;
    expect(await again.sync()).toMatchObject({ ok: true, pushed: 1, pending: 0 });
    expect(server.stored(url)).toBeDefined();
  });

  it("handles an edit made while the previous push is in flight", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    await e.putItem(tasks, `${tasks}a.ics`, ics("a", "first"));
    server.beforePut = async () => {
      server.beforePut = undefined;
      await e.putItem(tasks, `${tasks}a.ics`, ics("a", "second"));
    };
    await e.sync(); // pushes "first"; "second" is queued during the request
    expect(e.pendingCount).toBe(1);
    await e.sync();
    expect(conflicts).toEqual([]);
    expect(server.stored(`${tasks}a.ics`)?.data).toContain("second");
  });

  it("refuses to write to a read-only calendar", async () => {
    const mirror = server.addCalendar("mirror", { readOnly: true });
    const e = await started();
    await expect(e.putItem(mirror, `${mirror}x.ics`, ics("x"))).rejects.toThrow(/read-only/);
  });
});

describe("cache", () => {
  it("survives a restart and starts from scratch for another account", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    await started();
    const same = engine();
    await same.init();
    expect(same.item(`${tasks}a.ics`)).toBeDefined();
    const other = engine("someone-else");
    await other.init();
    expect(other.calendars()).toEqual([]);
  });

  it("runs one sync at a time", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = engine();
    await e.init();
    const [a, b] = await Promise.all([e.sync(), e.sync()]);
    expect(a).toBe(b);
    expect(server.calls.filter((c) => c === "discover")).toHaveLength(1);
  });
});

describe("change reports", () => {
  it("come once every calendar is read: an item moved to another calendar is already there", async () => {
    const other = server.addCalendar("zz-other");
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    const seen: string[] = [];
    const watcher = new SyncEngine(server, store, "acct", {
      onChange: (c) => seen.push(`${c.removed.length ? "removed" : "added"}:${watcher.item(`${other}a.ics`) ? "there" : "missing"}`),
    });
    await watcher.init();
    server.externalDelete(`${tasks}a.ics`);
    server.externalPut(`${other}a.ics`, ics("a"));
    await watcher.sync();
    expect(seen).toEqual(["removed:there", "added:there"]);
    expect(e).toBeDefined();
  });
});

describe("calendar changes", () => {
  it("renames and recolors on the server, then in the cache (kept after a sync)", async () => {
    const e = await started();
    await e.updateCalendar(tasks, { displayName: "Rappels", color: "#FF9500FF" });
    expect(e.calendars()[0]!.info).toMatchObject({ displayName: "Rappels", color: "#FF9500FF" });
    expect((await e.sync()).ok).toBe(true);
    expect(e.calendars()[0]!.info).toMatchObject({ displayName: "Rappels", color: "#FF9500FF" });
    expect((await store.load())?.calendars[tasks]?.info.displayName).toBe("Rappels");
  });

  it("changes nothing locally when the server refuses or can't be reached", async () => {
    const e = await started();
    server.offline = true;
    await expect(e.updateCalendar(tasks, { displayName: "Rappels" })).rejects.toThrow();
    expect(e.calendars()[0]!.info.displayName).toBe("tasks");
  });
});

describe("creating and deleting calendars", () => {
  it("creates one on the server, in the cache at once, read back by the next sync", async () => {
    const e = await started();
    const url = await e.createCalendar("new-list", { displayName: "Courses", color: "#30A46C", components: ["VTODO"] });
    expect(url).toBe(new URL("new-list/", tasks.replace(/tasks\/$/, "")).href);
    expect(e.calendars().map((c) => c.info.displayName)).toEqual(["tasks", "Courses"]);
    expect((await server.listCalendars()).find((c) => c.url === url)).toMatchObject({ displayName: "Courses", color: "#30A46C", components: ["VTODO"] });
    expect((await e.sync()).ok).toBe(true);
    expect(e.calendars().find((c) => c.info.url === url)?.info.displayName).toBe("Courses");
    expect(changes).toEqual([]);
  });

  it("deletes one: its items are reported removed (on purpose, not a calendar vanishing) and its queue dropped", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    changes = [];
    await e.putItem(tasks, `${tasks}b.ics`, ics("b"));
    await e.deleteCalendar(tasks);
    expect(await server.listCalendars()).toEqual([]);
    expect(e.calendars()).toEqual([]);
    expect(e.pendingCount).toBe(0);
    expect(changes).toEqual([{ calendarUrl: tasks, added: [], updated: [], removed: [`${tasks}a.ics`, `${tasks}b.ics`] }]);
    expect((await e.sync()).ok).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("changes nothing here when the server can't be reached", async () => {
    server.externalPut(`${tasks}a.ics`, ics("a"));
    const e = await started();
    changes = [];
    server.offline = true;
    await expect(e.deleteCalendar(tasks)).rejects.toThrow();
    await expect(e.createCalendar("x", { displayName: "X", color: "#E5484D", components: ["VEVENT"] })).rejects.toThrow();
    expect(e.calendars().map((c) => Object.keys(c.items).length)).toEqual([1]);
    expect(changes).toEqual([]);
  });
});
