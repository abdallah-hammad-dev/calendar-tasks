import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CalDavClient } from "../../src/caldav/client";
import { basicAuth } from "../../src/caldav/transport";
import { SyncEngine, type CalendarChange, type Conflict } from "../../src/sync/engine";
import { MemoryStore } from "../../src/sync/store";
import { TaskSync } from "../../src/tasks/TaskSync";
import { readTask } from "../../src/tasks/vtodo";
import { expandItem } from "../../src/calendar/expand";
import { cancelOccurrence, moveEvent, newEvent, setPartstat } from "../../src/calendar/vevent";
import { FakeVault } from "../support/fake-vault";
import { fetchTransport } from "../support/fetch-transport";
import { xmldomParser } from "../support/xmldom";

/** The local bench (~/organisation/calendar). Start Davis with davis/run.sh and Radicale with radicale/run.sh. */
const SERVERS = [
  { name: "Davis", serverUrl: "http://127.0.0.1:9000/dav/", username: "abd", password: "x", address: "abd@bench.test" },
  { name: "Radicale", serverUrl: "http://127.0.0.1:5232/", username: "abd", password: "x", address: undefined },
];

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

const vtodo = (uid: string, summary: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//calendar-tasks//integration//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    "DTSTAMP:20261015T000000Z",
    `SUMMARY:${summary}`,
    "DUE;TZID=Europe/Paris:20261020T100000",
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

for (const srv of SERVERS) {
  describe.skipIf(!(await reachable(srv.serverUrl)))(`against ${srv.name}`, () => {
    const auth = { Authorization: basicAuth(srv.username, srv.password) };
    const raw = (method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
      fetch(url, { method, body, headers: { ...auth, ...headers } });
    const client = new CalDavClient({ ...srv, transport: fetchTransport, parseXml: xmldomParser });
    let calendarUrl: string;
    let changes: CalendarChange[] = [];
    const conflicts: Conflict[] = [];
    let engine: SyncEngine;

    beforeAll(async () => {
      const d = await client.discover();
      calendarUrl = new URL(`it-${Date.now()}/`, d.homeUrl).href;
      const res = await raw(
        "MKCALENDAR",
        calendarUrl,
        `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>` +
          `<d:displayname>Integration test</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/>` +
          `<c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`,
        { "Content-Type": "application/xml" },
      );
      expect(res.status).toBe(201);
      engine = new SyncEngine(client, new MemoryStore(), "it", {
        onChange: (c) => c.calendarUrl === calendarUrl && changes.push(c),
        onConflict: (c) => conflicts.push(c),
      });
      await engine.init();
    });

    afterAll(async () => {
      if (calendarUrl) await raw("DELETE", calendarUrl);
    });

    it("discovers the account", async () => {
      const d = await client.discover();
      expect(d.homeUrl).toMatch(/\/$/);
      if (srv.address) expect(d.addresses).toContain(srv.address);
    });

    it("sees the new calendar, empty", async () => {
      expect(await engine.sync()).toMatchObject({ ok: true });
      const cal = engine.calendars().find((c) => c.info.url === calendarUrl);
      expect(cal?.info).toMatchObject({ displayName: "Integration test", readOnly: false });
      expect(cal?.info.components).toEqual(["VEVENT", "VTODO"]);
      expect(cal?.items).toEqual({});
    });

    it("renames and recolors the calendar", async () => {
      await engine.updateCalendar(calendarUrl, { displayName: "Integration test — renamed", color: "#FF9500FF" });
      const infos = await client.listCalendars((await client.discover()).homeUrl);
      const info = infos.find((c) => c.url === calendarUrl);
      expect(info?.displayName).toBe("Integration test — renamed");
      expect(info?.color?.slice(0, 7).toUpperCase()).toBe("#FF9500");
    });

    it("creates a collection of tasks, then deletes it", async () => {
      const id = `it-new-${Date.now()}`;
      const url = await engine.createCalendar(id, { displayName: "Courses — test", color: "#30A46C", components: ["VTODO"] });
      const listed = async () => (await client.listCalendars((await client.discover()).homeUrl)).find((c) => c.url === url);
      expect(await listed()).toMatchObject({ displayName: "Courses — test", components: ["VTODO"] });
      expect((await listed())?.color?.slice(0, 7).toUpperCase()).toBe("#30A46C");
      expect((await engine.sync()).ok).toBe(true);
      await engine.deleteCalendar(url);
      expect(await listed()).toBeUndefined();
      expect(engine.calendars().some((c) => c.info.url === url)).toBe(false);
    });

    it("pushes a new task", async () => {
      const url = engine.newItemUrl(calendarUrl, "it-task-1");
      await engine.putItem(calendarUrl, url, vtodo("it-task-1", "From Obsidian"));
      expect(await engine.sync()).toMatchObject({ ok: true, pushed: 1, pending: 0 });
      const res = await raw("GET", url);
      const body = await res.text();
      expect(body).toContain("SUMMARY:From Obsidian");
      expect(body).toContain("DUE;TZID=Europe/Paris:20261020T100000");
      expect(engine.item(url)?.etag).toBeTruthy();
    });

    it("pulls a change made elsewhere", async () => {
      const url = engine.newItemUrl(calendarUrl, "it-task-1");
      changes = [];
      await raw("PUT", url, vtodo("it-task-1", "Renamed on the phone"), { "Content-Type": "text/calendar" });
      await engine.sync();
      expect(changes).toEqual([{ calendarUrl, added: [], updated: [url], removed: [] }]);
      expect(engine.item(url)?.data).toContain("Renamed on the phone");
    });

    it("refuses a stale write and keeps the server's version", async () => {
      const url = engine.newItemUrl(calendarUrl, "it-task-1");
      await raw("PUT", url, vtodo("it-task-1", "Phone wins"), { "Content-Type": "text/calendar" });
      await engine.putItem(calendarUrl, url, vtodo("it-task-1", "Obsidian loses"));
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 1 });
      expect(conflicts.at(-1)?.server?.data).toContain("Phone wins");
      expect(engine.item(url)?.data).toContain("Phone wins");
      expect(await (await raw("GET", url)).text()).toContain("Phone wins");
    });

    it("recovers from a token the server rejects", async () => {
      const cal = engine.calendars().find((c) => c.info.url === calendarUrl)!;
      const url = engine.newItemUrl(calendarUrl, "it-task-2");
      await raw("PUT", url, vtodo("it-task-2", "Second"), { "Content-Type": "text/calendar" });
      cal.syncToken = "bogus-token";
      expect(await engine.sync()).toMatchObject({ ok: true });
      expect(engine.item(url)?.data).toContain("Second");
    });

    it.runIf(srv.name === "Davis")("recovers from a token the server silently accepts but can't serve", async () => {
      const cal = engine.calendars().find((c) => c.info.url === calendarUrl)!;
      const url = engine.newItemUrl(calendarUrl, "it-task-2");
      await raw("PUT", url, vtodo("it-task-2", "Second, edited"), { "Content-Type": "text/calendar" });
      cal.syncToken = "http://sabre.io/ns/sync/999999"; // e.g. after restoring the server from a backup
      expect(await engine.sync()).toMatchObject({ ok: true });
      expect(engine.item(url)?.data).toContain("Second, edited");
    });

    it("round-trips a task note through the real server", async () => {
      const vault = new FakeVault();
      const ts = new TaskSync({
        vault,
        engine,
        settings: () => ({ tasksFolder: "Tâches", reminderNoteLink: true, defaultCalendar: calendarUrl }),
        vaultName: "Test vault",
        tz: () => "Europe/Paris",
        newUid: () => `it-note-${Date.now()}`,
        requestSync: () => undefined,
        notify: () => undefined,
      });
      ts.rebuild();
      vault.add("Tâches/Préparer la démo.md", { type: "task", done: false, due: "2026-10-22T09:30", priority: "high" });
      await ts.noteChanged("Tâches/Préparer la démo.md");
      const uid = vault.fm("Tâches/Préparer la démo.md")!.caldav_uid as string;
      expect(await engine.sync()).toMatchObject({ ok: true, pushed: 1, conflicts: 0 });

      const url = engine.newItemUrl(calendarUrl, uid);
      const stored = await (await raw("GET", url)).text();
      expect(readTask(stored, "Europe/Paris")).toMatchObject({ summary: "Préparer la démo", due: "2026-10-22T09:30", done: false, priority: "high" });
      expect(stored).toContain("BEGIN:VTIMEZONE");
      expect(stored).toContain("PRIORITY:1");

      // Ticked on the phone, and its priority lowered: the note follows.
      await raw("PUT", url, stored.replace("STATUS:NEEDS-ACTION", "STATUS:COMPLETED").replace("PRIORITY:1", "PRIORITY:9"), { "Content-Type": "text/calendar" });
      await engine.sync();
      await ts.onServerChange({ calendarUrl, added: [], updated: [url], removed: [] });
      expect(vault.fm("Tâches/Préparer la démo.md")).toMatchObject({ done: true, priority: "low" });
      await engine.deleteItem(url);
      await engine.sync();
    });

    it("moves a task to another collection when its note names it", async () => {
      const other = await engine.createCalendar(`it-move-${Date.now()}`, { displayName: "Pro — test", color: "#0090FF", components: ["VEVENT", "VTODO"] });
      const vault = new FakeVault();
      const ts = new TaskSync({
        vault,
        engine,
        settings: () => ({ tasksFolder: "Tâches", reminderNoteLink: true, defaultCalendar: calendarUrl }),
        vaultName: "Test vault",
        tz: () => "Europe/Paris",
        newUid: () => `it-move-note-${Date.now()}`,
        requestSync: () => undefined,
        notify: () => undefined,
      });
      ts.rebuild();
      vault.add("Tâches/Déplacée.md", { type: "task", done: false });
      await ts.noteChanged("Tâches/Déplacée.md");
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 0, pending: 0 });
      const uid = vault.fm("Tâches/Déplacée.md")!.caldav_uid as string;
      await vault.editFrontmatter("Tâches/Déplacée.md", (fm) => (fm.collection = "Pro — test"));
      await ts.noteChanged("Tâches/Déplacée.md");
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 0, pending: 0 });
      expect((await raw("GET", engine.newItemUrl(calendarUrl, uid))).status).toBe(404);
      expect(await (await raw("GET", engine.newItemUrl(other, uid))).text()).toContain(`UID:${uid}`);
      await engine.deleteCalendar(other);
    });

    it("accepts the events we write: new, moved occurrence, cancelled occurrence, answered invitation", async () => {
      const tz = "Europe/Paris";
      const url = engine.newItemUrl(calendarUrl, "it-weekly");
      const created = newEvent("it-weekly", { summary: "Hebdo", start: "2026-10-05T10:00", end: "2026-10-05T11:00" }, tz).replace(
        "END:VEVENT",
        "RRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT",
      );
      await engine.putItem(calendarUrl, url, created);
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 0, pending: 0 });

      const moved = moveEvent(engine.item(url)!.data, "20261012T080000Z", "2026-10-13T15:00", "2026-10-13T16:00", tz);
      await engine.putItem(calendarUrl, url, moved);
      const cancelled = cancelOccurrence(moved, "20261019T080000Z");
      await engine.putItem(calendarUrl, url, cancelled);
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 0, pending: 0 });
      const stored = await (await raw("GET", url)).text();
      const starts = expandItem(url, calendarUrl, stored, {
        from: new Date("2026-10-01T00:00:00Z"),
        to: new Date("2026-11-01T00:00:00Z"),
        tz,
        me: [],
      }).map((o) => o.start);
      expect(starts).toEqual(["2026-10-05T10:00", "2026-10-13T15:00", "2026-10-26T10:00"]);

      const inviteUrl = engine.newItemUrl(calendarUrl, "it-invite");
      const invite =
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:it-invite\r\nDTSTAMP:20261015T000000Z\r\n" +
        "SUMMARY:Invitation\r\nDTSTART:20261020T090000Z\r\nDTEND:20261020T100000Z\r\nORGANIZER:mailto:boss@example.com\r\n" +
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:abd@bench.test\r\n" +
        "END:VEVENT\r\nEND:VCALENDAR\r\n";
      await raw("PUT", inviteUrl, invite, { "Content-Type": "text/calendar" });
      await engine.sync();
      await engine.putItem(calendarUrl, inviteUrl, setPartstat(engine.item(inviteUrl)!.data, ["abd@bench.test"], "ACCEPTED")!);
      expect(await engine.sync()).toMatchObject({ ok: true, conflicts: 0, pending: 0 });
      expect((await (await raw("GET", inviteUrl)).text()).replace(/\r\n[ \t]/g, "")).toMatch(/PARTSTAT=ACCEPTED[^\r]*:mailto:abd@bench.test/);
      await engine.deleteItem(url);
      await engine.deleteItem(inviteUrl);
      await engine.sync();
    });

    it("pulls a deletion and pushes one", async () => {
      const first = engine.newItemUrl(calendarUrl, "it-task-1");
      const second = engine.newItemUrl(calendarUrl, "it-task-2");
      changes = [];
      await raw("DELETE", second);
      await engine.deleteItem(first);
      expect(await engine.sync()).toMatchObject({ ok: true, pushed: 1, pending: 0 });
      expect(changes).toEqual([{ calendarUrl, added: [], updated: [], removed: [second] }]);
      expect((await raw("GET", first)).status).toBe(404);
      expect(engine.calendars().find((c) => c.info.url === calendarUrl)?.items).toEqual({});
    });

    it("reads an item back with an ETag that If-Match accepts, even over 512 bytes", async () => {
      // Davis's Caddy compresses answers over 512 bytes for a client that asks (fetch does, as Obsidian does) and
      // then appends "-gzip" to the ETag header, which If-Match refuses (412).
      const url = engine.newItemUrl(calendarUrl, "it-big");
      const big = vtodo("it-big", `Big ${"x".repeat(800)}`);
      expect(await client.put(url, big)).toMatchObject({ kind: "ok" });
      const read = await client.get(url);
      expect(read?.data).toContain("UID:it-big");
      expect(await client.put(url, big.replace("Big ", "Bigger "), read!.etag)).toMatchObject({ kind: "ok" });
      expect(await client.get(engine.newItemUrl(calendarUrl, "it-missing"))).toBeNull();
      expect(await client.delete(url)).toBe("ok");
    });
  });
}
