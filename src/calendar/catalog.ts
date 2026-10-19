import { itemInfo, type ItemKind } from "../caldav/ical";
import type { SyncEngine } from "../sync/engine";

export interface CatalogEntry {
  url: string;
  calendarUrl: string;
  kind: ItemKind;
}

/** uid → item, for every cached item; rebuilt lazily after each change from the server. */
export class ItemCatalog {
  private byUid: Map<string, CatalogEntry> | null = null;

  constructor(private readonly engine: () => Pick<SyncEngine, "calendars"> | null) {}

  invalidate(): void {
    this.byUid = null;
  }

  get(uid: string): CatalogEntry | undefined {
    return this.map().get(uid);
  }

  private map(): Map<string, CatalogEntry> {
    if (this.byUid) return this.byUid;
    const m = new Map<string, CatalogEntry>();
    for (const cal of this.engine()?.calendars() ?? []) {
      for (const [url, it] of Object.entries(cal.items)) {
        const info = itemInfo(it.data);
        if (info) m.set(info.uid, { url, calendarUrl: cal.info.url, kind: info.kind });
      }
    }
    this.byUid = m;
    return m;
  }
}
