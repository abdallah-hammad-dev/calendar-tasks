import { refusalStatus, type CalDavApi, type CalendarChanges, type CalendarInfo, type Discovery, type NewCalendar, type RemoteItem } from "../caldav/client";
import { emptySnapshot, type CacheSnapshot, type CacheStore, type CachedCalendar, type CachedItem, type PendingOp } from "./store";

/** Items that changed on the server (never emitted for the caller's own `put` / `delete`). */
export interface CalendarChange {
  calendarUrl: string;
  added: string[];
  updated: string[];
  removed: string[];
  /** The whole calendar disappeared from the account (its items are listed in `removed`). */
  calendarRemoved?: boolean;
}

/** A local change the server refused because the item changed there first. The cache now holds `server`. */
export interface Conflict {
  op: PendingOp;
  server: RemoteItem | null;
}

/** A local change the server refused for good (invalid, too big, forbidden): dropped from the queue, kept here. */
export interface Refusal {
  op: PendingOp;
  status: number;
}

export interface SyncListener {
  onChange?(change: CalendarChange): void;
  onConflict?(conflict: Conflict): void;
  onRefused?(refusal: Refusal): void;
}

export interface SyncReport {
  ok: boolean;
  error?: string;
  calendars: number;
  pulled: number;
  pushed: number;
  conflicts: number;
  pending: number;
}

/**
 * Keeps a local copy of the account's calendars in step with the server: pushes queued local changes with
 * `If-Match`, then pulls with sync-tokens (RFC 6578), falling back to etag listings. Nothing is silently
 * overwritten: a refused push becomes a `Conflict`.
 */
export class SyncEngine {
  private snap: CacheSnapshot;
  private running: Promise<SyncReport> | null = null;
  private rerun = false;
  /** Calendars whose last full listing came back empty while we held items (see `pull`). */
  private emptySeen = new Set<string>();
  /**
   * The op being pushed. Deleted meanwhile, a creation must still be deleted on the server: it's on its way there
   * (the deletion takes its place and gets the new etag, as an edit does).
   */
  private inFlight: PendingOp | null = null;

  constructor(
    private readonly api: CalDavApi,
    private readonly store: CacheStore,
    private readonly account: string,
    private readonly listener: SyncListener = {},
  ) {
    this.snap = emptySnapshot(account);
  }

  /** Loads the cache. A cache from another account is ignored. */
  async init(): Promise<void> {
    const saved = await this.store.load();
    this.snap = saved && saved.account === this.account ? saved : emptySnapshot(this.account);
  }

  get discovery(): Discovery | undefined {
    return this.snap.discovery;
  }

  get lastSync(): number | undefined {
    return this.snap.lastSync;
  }

  get pendingCount(): number {
    return this.snap.pending.length;
  }

  /** A local change to this item is waiting to be pushed. */
  isPending(url: string): boolean {
    return this.snap.pending.some((o) => o.url === url);
  }

  calendars(): CachedCalendar[] {
    return Object.values(this.snap.calendars);
  }

  item(url: string): CachedItem | undefined {
    return this.calendarOf(url)?.items[url];
  }

  /** One sync at a time; a call during a sync schedules one more run and resolves with its report. */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let report: SyncReport;
      do {
        this.rerun = false;
        report = await this.runOnce();
      } while (this.rerun);
      return report;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** URL for a new item in a calendar. */
  newItemUrl(calendarUrl: string, uid: string): string {
    return new URL(`${uid.replace(/[^A-Za-z0-9._-]/g, "_")}.ics`, calendarUrl).href;
  }

  /** Saves an item locally (creating it if new) and queues the push. */
  async putItem(calendarUrl: string, url: string, data: string): Promise<void> {
    const cal = this.writable(calendarUrl);
    const i = this.snap.pending.findIndex((o) => o.url === url);
    const prev = i >= 0 ? this.snap.pending[i] : undefined;
    const op: PendingOp = prev
      ? { kind: "put", url, calendarUrl, data, baseEtag: prev.baseEtag, baseData: prev.kind === "put" ? prev.baseData : undefined }
      : { kind: "put", url, calendarUrl, data, baseEtag: cal.items[url]?.etag, baseData: cal.items[url]?.data };
    if (prev) this.snap.pending[i] = op;
    else this.snap.pending.push(op);
    cal.items[url] = { etag: cal.items[url]?.etag ?? "", data };
    await this.store.save(this.snap);
  }

  /**
   * Renames a calendar or changes its color, on the server first (not queued: it needs the network, and fails
   * with the server's reason), then in the cache.
   */
  async updateCalendar(url: string, changes: CalendarChanges): Promise<void> {
    const cal = this.snap.calendars[url];
    if (!cal) throw new Error("Unknown calendar");
    await this.api.updateCalendar(url, changes);
    cal.info = { ...cal.info, ...changes };
    await this.store.save(this.snap);
  }

  /**
   * Creates a calendar in the account's home, named `id` in its URL, on the server first (not queued). It's in
   * the cache at once, empty; the next sync reads it back. Returns its URL.
   */
  async createCalendar(id: string, spec: NewCalendar): Promise<string> {
    await this.idle();
    this.snap.discovery ??= await this.api.discover();
    const url = new URL(`${encodeURIComponent(id)}/`, this.snap.discovery.homeUrl).href;
    await this.api.createCalendar(url, spec);
    this.snap.calendars[url] = { info: { url, displayName: spec.displayName, color: spec.color, components: spec.components, readOnly: false }, items: {} };
    await this.store.save(this.snap);
    return url;
  }

  /**
   * Deletes a calendar and everything in it, on the server first (not queued), then here: its queued changes are
   * dropped and its items reported removed, like items deleted elsewhere (not `calendarRemoved`, which is a
   * calendar vanishing, maybe for a moment: here it's on purpose).
   */
  async deleteCalendar(url: string): Promise<void> {
    await this.idle();
    const cal = this.snap.calendars[url];
    if (!cal) throw new Error("Unknown calendar");
    await this.api.deleteCalendar(url);
    delete this.snap.calendars[url];
    this.snap.pending = this.snap.pending.filter((o) => o.calendarUrl !== url);
    await this.store.save(this.snap);
    const removed = Object.keys(cal.items);
    if (removed.length) this.listener.onChange?.({ calendarUrl: url, added: [], updated: [], removed });
  }

  /** Waits for a sync under way (a calendar created or deleted in the middle of one would be read half-way). */
  private async idle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** Removes an item locally and queues the deletion. */
  async deleteItem(url: string): Promise<void> {
    const cal = this.calendarOf(url);
    if (!cal) return;
    this.writable(cal.info.url);
    const i = this.snap.pending.findIndex((o) => o.url === url);
    const prev = i >= 0 ? this.snap.pending[i] : undefined;
    if (prev && prev.kind === "put" && prev.baseEtag === undefined && prev !== this.inFlight) {
      this.snap.pending.splice(i, 1); // created and deleted before ever reaching the server
    } else {
      const op: PendingOp = { kind: "delete", url, calendarUrl: cal.info.url, baseEtag: prev ? prev.baseEtag : cal.items[url]?.etag };
      if (prev) this.snap.pending[i] = op;
      else this.snap.pending.push(op);
    }
    delete cal.items[url];
    await this.store.save(this.snap);
  }

  /** Forgets everything local, including unpushed changes. */
  async reset(): Promise<void> {
    this.snap = emptySnapshot(this.account);
    await this.store.clear();
  }

  private async runOnce(): Promise<SyncReport> {
    const report: SyncReport = { ok: true, calendars: 0, pulled: 0, pushed: 0, conflicts: 0, pending: 0 };
    const changes: CalendarChange[] = [];
    const conflicts: Conflict[] = [];
    const refusals: Refusal[] = [];
    try {
      this.snap.discovery ??= await this.api.discover();
      const infos = await this.api.listCalendars(this.snap.discovery.homeUrl);
      this.reconcile(infos, changes);
      report.calendars = infos.length;
      await this.flush(report, conflicts, refusals);
      for (const cal of this.calendars()) report.pulled += await this.pull(cal, changes);
      this.snap.lastSync = Date.now();
    } catch (e) {
      report.ok = false;
      report.error = e instanceof Error ? e.message : String(e);
    }
    // Told once every calendar is read (even after a failure, for those already in the cache): an item moved to
    // another calendar (a reminder put in another list) is already there when its removal from the first, or a
    // push refused because it left, is told. Refused pushes first: the merge must see the local change before the
    // server's version is applied.
    for (const c of conflicts) this.listener.onConflict?.(c);
    for (const r of refusals) this.listener.onRefused?.(r);
    for (const c of changes) this.listener.onChange?.(c);
    report.pending = this.snap.pending.length;
    await this.store.save(this.snap);
    return report;
  }

  private reconcile(infos: CalendarInfo[], changes: CalendarChange[]): void {
    const seen = new Set<string>();
    for (const info of infos) {
      seen.add(info.url);
      const cal = this.snap.calendars[info.url];
      if (cal) cal.info = info;
      else this.snap.calendars[info.url] = { info, items: {} };
    }
    for (const [url, cal] of Object.entries(this.snap.calendars)) {
      if (seen.has(url)) continue;
      delete this.snap.calendars[url];
      this.snap.pending = this.snap.pending.filter((o) => o.calendarUrl !== url);
      const removed = Object.keys(cal.items);
      if (removed.length) changes.push({ calendarUrl: url, added: [], updated: [], removed, calendarRemoved: true });
    }
  }

  private async flush(report: SyncReport, conflicts: Conflict[], refusals: Refusal[]): Promise<void> {
    for (const op of [...this.snap.pending]) {
      const cal = this.snap.calendars[op.calendarUrl];
      if (!cal) continue;
      if (op.kind === "put") {
        this.inFlight = op;
        const res = await this.send(op, this.api.put(op.url, op.data, op.baseEtag), refusals).finally(() => (this.inFlight = null));
        if (!res) continue;
        if (res.kind === "ok") {
          this.done(op);
          const newer = this.snap.pending.find((o) => o.url === op.url);
          let etag = res.etag;
          if (!etag) {
            // The server changed what we sent (or didn't say): read back its version.
            const fresh = await this.api.get(op.url);
            etag = fresh?.etag ?? "";
            if (fresh && !newer) cal.items[op.url] = { etag, data: fresh.data };
          } else if (!newer) {
            cal.items[op.url] = { etag, data: op.data };
          }
          if (newer) {
            newer.baseEtag = etag; // edited again while this push was in flight
            if (cal.items[op.url]) cal.items[op.url]!.etag = etag;
          }
          report.pushed++;
        } else {
          await this.conflict(op, cal, report, conflicts);
        }
      } else {
        const res = await this.send(op, this.api.delete(op.url, op.baseEtag), refusals);
        if (!res) continue;
        if (res === "conflict") await this.conflict(op, cal, report, conflicts);
        else {
          this.done(op);
          report.pushed++;
        }
      }
    }
  }

  /**
   * Sends one change; null when the server refused it for good. It leaves the queue: sent again, it would be
   * refused again, and hold up every change queued after it and every pull (2026-10-28).
   */
  private async send<T>(op: PendingOp, call: Promise<T>, refusals: Refusal[]): Promise<T | null> {
    try {
      return await call;
    } catch (e) {
      const status = refusalStatus(e);
      if (status === null) throw e;
      this.done(op);
      refusals.push({ op, status });
      return null;
    }
  }

  private async conflict(op: PendingOp, cal: CachedCalendar, report: SyncReport, conflicts: Conflict[]): Promise<void> {
    const server = await this.api.get(op.url);
    this.done(op);
    if (server) cal.items[op.url] = { etag: server.etag, data: server.data };
    else delete cal.items[op.url];
    report.conflicts++;
    conflicts.push({ op, server });
  }

  private done(op: PendingOp): void {
    this.snap.pending = this.snap.pending.filter((o) => o !== op);
  }

  /** Returns the number of items added, updated or removed, and adds what changed to `changes`. */
  private async pull(cal: CachedCalendar, changes: CalendarChange[]): Promise<number> {
    const url = cal.info.url;
    const { syncToken: current, ctag } = cal.info;
    if (current ? current === cal.syncToken : ctag !== undefined && ctag === cal.ctag) return 0;

    let incremental = !!cal.syncToken;
    let res = await this.api.syncCollection(url, cal.syncToken);
    if (res.kind === "ok" && incremental && current && res.syncToken === cal.syncToken) {
      // Our token came back unchanged although the server's current token differs: the server can't serve it
      // (sabre/dav answers "no changes" for unknown tokens with its own prefix, e.g. after a restore). Start over.
      res = { kind: "invalid-token" };
    }
    if (res.kind === "invalid-token") {
      incremental = false;
      res = await this.api.syncCollection(url);
    }
    let changed: { url: string; etag: string }[];
    let removed: string[];
    let token: string | undefined;
    let complete: boolean;
    if (res.kind === "ok") {
      changed = res.changed;
      removed = res.removed;
      token = res.syncToken;
      complete = !incremental;
    } else {
      // No sync-collection support: list every etag and diff.
      changed = await this.api.listEtags(url);
      removed = [];
      token = undefined;
      complete = true;
    }

    const pending = new Set(this.snap.pending.map((o) => o.url));
    if (complete) {
      const known = Object.keys(cal.items).filter((u) => !pending.has(u));
      if (!changed.length && known.length) {
        // A full listing came back empty although we hold items: a server hiccup would turn every task note into
        // "deleted on the server". Believe it only when the next sync says the same.
        if (!this.emptySeen.has(url)) {
          this.emptySeen.add(url);
          return 0;
        }
      }
      this.emptySeen.delete(url);
      const listed = new Set(changed.map((r) => r.url));
      removed = Object.keys(cal.items).filter((u) => !listed.has(u));
    }
    removed = removed.filter((u) => !pending.has(u) && cal.items[u]);

    const toFetch = changed.filter((r) => !pending.has(r.url) && cal.items[r.url]?.etag !== r.etag).map((r) => r.url);
    const fetched = toFetch.length ? await this.api.multiget(url, toFetch) : [];
    const change: CalendarChange = { calendarUrl: url, added: [], updated: [], removed };
    for (const it of fetched) {
      (cal.items[it.url] ? change.updated : change.added).push(it.url);
      cal.items[it.url] = { etag: it.etag, data: it.data };
    }
    for (const u of removed) delete cal.items[u];
    cal.syncToken = token;
    cal.ctag = ctag;

    const count = change.added.length + change.updated.length + change.removed.length;
    if (count) changes.push(change);
    return count;
  }

  private calendarOf(url: string): CachedCalendar | undefined {
    return this.calendars().find((c) => url in c.items || this.snap.pending.some((o) => o.url === url && o.calendarUrl === c.info.url));
  }

  private writable(calendarUrl: string): CachedCalendar {
    const cal = this.snap.calendars[calendarUrl];
    if (!cal) throw new Error(`Unknown calendar ${calendarUrl}`);
    if (cal.info.readOnly) throw new Error(`Calendar "${cal.info.displayName}" is read-only`);
    return cal;
  }
}
