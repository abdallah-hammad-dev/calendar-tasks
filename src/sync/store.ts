import type { CalendarInfo, Discovery } from "../caldav/client";

export interface CachedItem {
  etag: string;
  data: string;
}

export interface CachedCalendar {
  info: CalendarInfo;
  /** Token of the last successful pull (the server's current one is `info.syncToken`). */
  syncToken?: string;
  /** ctag at the last successful pull, for servers without sync tokens. */
  ctag?: string;
  /** By absolute item URL. */
  items: Record<string, CachedItem>;
}

/**
 * A local change waiting to be pushed. `baseEtag` undefined = create. `baseData` is the item as it was before
 * the local change, so a conflict can be merged field by field.
 */
export type PendingOp =
  | { kind: "put"; url: string; calendarUrl: string; data: string; baseEtag?: string; baseData?: string }
  | { kind: "delete"; url: string; calendarUrl: string; baseEtag?: string };

/** Everything the extension knows about the server, per device (never synced with the vault). */
export interface CacheSnapshot {
  version: 1;
  /** Server URL + username. A different account starts from an empty cache. */
  account: string;
  discovery?: Discovery;
  calendars: Record<string, CachedCalendar>;
  pending: PendingOp[];
  lastSync?: number;
}

export function emptySnapshot(account: string): CacheSnapshot {
  return { version: 1, account, calendars: {}, pending: [] };
}

export interface CacheStore {
  load(): Promise<CacheSnapshot | null>;
  save(snapshot: CacheSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements CacheStore {
  saved: CacheSnapshot | null = null;
  async load(): Promise<CacheSnapshot | null> {
    return this.saved ? structuredClone(this.saved) : null;
  }
  async save(snapshot: CacheSnapshot): Promise<void> {
    this.saved = structuredClone(snapshot);
  }
  async clear(): Promise<void> {
    this.saved = null;
  }
}

/**
 * IndexedDB: per device and not synced with the vault, which is what a sync-token cache needs (two devices
 * sharing one cache file would mix their states). Available on desktop and mobile.
 */
export class IdbStore implements CacheStore {
  private static readonly STORE = "cache";
  private static readonly KEY = "snapshot";
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly name: string,
    private readonly idb: IDBFactory = indexedDB,
  ) {}

  async load(): Promise<CacheSnapshot | null> {
    const value = await this.run<unknown>("readonly", (s) => s.get(IdbStore.KEY));
    return isSnapshot(value) ? value : null;
  }

  async save(snapshot: CacheSnapshot): Promise<void> {
    await this.run("readwrite", (s) => s.put(snapshot, IdbStore.KEY));
  }

  async clear(): Promise<void> {
    await this.run("readwrite", (s) => s.delete(IdbStore.KEY));
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.idb.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IdbStore.STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IdbStore.STORE, mode);
      const req = op(tx.objectStore(IdbStore.STORE));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }
}

function isSnapshot(v: unknown): v is CacheSnapshot {
  return typeof v === "object" && v !== null && (v as CacheSnapshot).version === 1;
}
