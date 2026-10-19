import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { emptySnapshot, IdbStore } from "../src/sync/store";

describe("IdbStore", () => {
  it("saves, loads and clears the snapshot", async () => {
    const idb = new IDBFactory();
    const store = new IdbStore("calendar-tasks/test", idb);
    expect(await store.load()).toBeNull();

    const snap = emptySnapshot("acct");
    snap.pending.push({ kind: "delete", url: "https://cal.test/a.ics", calendarUrl: "https://cal.test/", baseEtag: '"1"' });
    await store.save(snap);
    expect(await new IdbStore("calendar-tasks/test", idb).load()).toEqual(snap); // another instance, same database

    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("keeps vaults apart", async () => {
    const idb = new IDBFactory();
    await new IdbStore("calendar-tasks/one", idb).save(emptySnapshot("acct"));
    expect(await new IdbStore("calendar-tasks/two", idb).load()).toBeNull();
  });
});
