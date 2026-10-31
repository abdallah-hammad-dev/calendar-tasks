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

  it("opens again when the system closed its connection (iOS, in the background)", async () => {
    const store = new IdbStore("calendar-tasks/test", new IDBFactory());
    await store.save(emptySnapshot("acct"));
    (await (store as unknown as { db: Promise<IDBDatabase> }).db).close();
    expect(await store.load()).toEqual(emptySnapshot("acct"));
  });

  it("fails, rather than waiting forever, when a transaction is aborted", async () => {
    const store = new IdbStore("calendar-tasks/test", new IDBFactory());
    await store.save(emptySnapshot("acct"));
    const db = await (store as unknown as { db: Promise<IDBDatabase> }).db;
    const transaction = db.transaction.bind(db);
    db.transaction = ((...args: Parameters<typeof transaction>) => {
      const tx = transaction(...args);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (name) => {
        const s = objectStore(name);
        const put = s.put.bind(s);
        // Once its request is done, so no request reports it.
        s.put = (...values) => {
          const req = put(...values);
          req.addEventListener("success", () => tx.abort());
          return req;
        };
        return s;
      };
      return tx;
    }) as typeof db.transaction;
    await expect(store.save(emptySnapshot("acct"))).rejects.toThrow();
  });

  it("keeps vaults apart", async () => {
    const idb = new IDBFactory();
    await new IdbStore("calendar-tasks/one", idb).save(emptySnapshot("acct"));
    expect(await new IdbStore("calendar-tasks/two", idb).load()).toBeNull();
  });
});
