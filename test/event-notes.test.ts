import { beforeEach, describe, expect, it } from "vitest";
import { EventNotes, type EventDateFormat } from "../src/calendar/event-notes";
import type { Occurrence } from "../src/calendar/expand";
import { FakeVault } from "./support/fake-vault";

const occ = (over: Partial<Occurrence> = {}): Occurrence => ({
  id: "x",
  kind: "event",
  uid: "ev-1",
  recurrenceId: null,
  itemUrl: "https://cal.test/c/ev-1.ics",
  calendarUrl: "https://cal.test/c/",
  title: "Point Olera",
  allDay: false,
  start: "2026-10-16T10:00",
  end: "2026-10-16T11:00",
  location: null, meeting: null,
  recurring: false,
  done: false,
  taskUid: null,
  invitation: null,
  ...over,
});

let vault: FakeVault;
let notes: EventNotes;
let format: EventDateFormat;
beforeEach(() => {
  vault = new FakeVault();
  format = "DD-MM-YYYY";
  notes = new EventNotes({ vault, eventsFolder: () => "Calendrier", dateFormat: () => format });
});

describe("EventNotes", () => {
  it("creates the note on first open, and finds it afterwards", async () => {
    const path = await notes.ensure(occ());
    expect(path).toBe("Calendrier/16-10-2026 Point Olera.md");
    expect(vault.fm(path)).toEqual({ type: "event", start: "2026-10-16T10:00", end: "2026-10-16T11:00", caldav_uid: "ev-1" });
    expect(await notes.ensure(occ())).toBe(path);
    notes.rebuild();
    expect(notes.pathFor("ev-1", null)).toBe(path);
  });

  it("picks up event notes created on another device, and forgets deleted ones", async () => {
    vault.add("Calendrier/16-10-2026 Point Olera.md", { type: "event", start: "2026-10-16T10:00", caldav_uid: "ev-1" });
    notes.refresh("Calendrier/16-10-2026 Point Olera.md");
    expect(await notes.ensure(occ())).toBe("Calendrier/16-10-2026 Point Olera.md"); // no duplicate
    vault.remove("Calendrier/16-10-2026 Point Olera.md");
    notes.forget("Calendrier/16-10-2026 Point Olera.md");
    expect(notes.pathFor("ev-1", null)).toBeNull();
  });

  it("gives each occurrence of a series its own note", async () => {
    const a = await notes.ensure(occ({ recurring: true, recurrenceId: "20261016T080000Z" }));
    const b = await notes.ensure(occ({ recurring: true, recurrenceId: "20261023T080000Z", start: "2026-10-23T10:00" }));
    expect([a, b]).toEqual(["Calendrier/16-10-2026 Point Olera.md", "Calendrier/23-10-2026 Point Olera.md"]);
    expect(vault.fm(b)!.recurrence_id).toBe("20261023T080000Z");
  });

  it("follows a move and a rename, and leaves the note when the event is gone", async () => {
    const path = await notes.ensure(occ());
    await notes.update(() => occ({ title: "Point Olera v2", start: "2026-10-17T14:00", end: "2026-10-17T15:00" }));
    expect(vault.exists(path)).toBe(false);
    expect(vault.fm("Calendrier/17-10-2026 Point Olera v2.md")).toMatchObject({ start: "2026-10-17T14:00", end: "2026-10-17T15:00" });
    await notes.update(() => null);
    expect(vault.exists("Calendrier/17-10-2026 Point Olera v2.md")).toBe(true);
  });

  it("writes the day as set, and renames the notes when that changes", async () => {
    const path = await notes.ensure(occ());
    format = "DD.MM.YYYY";
    await notes.update(() => occ());
    expect(vault.exists(path)).toBe(false);
    expect(vault.exists("Calendrier/16.10.2026 Point Olera.md")).toBe(true);
    format = "YYYY-MM-DD";
    await notes.update(() => occ());
    expect(vault.exists("Calendrier/2026-10-16 Point Olera.md")).toBe(true);
  });

  it("adds the time when another event of the day has the same title, then a number", async () => {
    const a = await notes.ensure(occ());
    const b = await notes.ensure(occ({ uid: "ev-2", start: "2026-10-16T14:30", end: "2026-10-16T15:00" }));
    const c = await notes.ensure(occ({ uid: "ev-3", allDay: true, start: "2026-10-16", end: "2026-10-17" }));
    const d = await notes.ensure(occ({ uid: "ev-4" }));
    expect([a, b, c, d]).toEqual([
      "Calendrier/16-10-2026 Point Olera.md",
      "Calendrier/16-10-2026 Point Olera 14h30.md",
      "Calendrier/16-10-2026 Point Olera (2).md",
      "Calendrier/16-10-2026 Point Olera 10h.md",
    ]);
    // Each keeps its name while nothing changes.
    await notes.update((uid) => (uid === "ev-2" ? occ({ uid, start: "2026-10-16T14:30", end: "2026-10-16T15:00" }) : null));
    expect(vault.exists(b)).toBe(true);
  });
});
