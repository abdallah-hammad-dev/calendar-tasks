import type {
  CalDavApi,
  CalendarChanges,
  CalendarInfo,
  DeleteResult,
  Discovery,
  ItemRef,
  NewCalendar,
  PutResult,
  RemoteItem,
  SyncResult,
} from "../../src/caldav/client";

interface FakeCalendar {
  info: Omit<CalendarInfo, "syncToken">;
  items: Map<string, { etag: string; data: string }>;
  version: number;
  /** url → version of its last change (and whether it was a removal). */
  changes: Map<string, { version: number; removed: boolean }>;
}

export const HOME = "https://cal.test/dav/calendars/abd/";

/**
 * In-memory CalDAV server implementing the engine's API, with sync tokens, etags and preconditions.
 * Test hooks: `external*` simulate edits made elsewhere (e.g. on the iPhone), `forgetTokens` invalidates
 * tokens, `supportsSync`, `offline` and `beforePut` shape behavior.
 */
export class FakeServer implements CalDavApi {
  calls: string[] = [];
  supportsSync = true;
  /** sabre/dav quirk: answer "no changes" (echoing the token) instead of rejecting an unknown token. */
  echoUnknownTokens = false;
  offline = false;
  beforePut?: (url: string) => Promise<void> | void;
  private cals = new Map<string, FakeCalendar>();
  private etagSeq = 0;
  private epoch = 1;

  addCalendar(name: string, opts: Partial<Omit<CalendarInfo, "url" | "syncToken">> = {}): string {
    const url = `${HOME}${name}/`;
    this.cals.set(url, {
      info: { url, displayName: name, components: ["VEVENT", "VTODO"], readOnly: false, ...opts },
      items: new Map(),
      version: 0,
      changes: new Map(),
    });
    return url;
  }

  removeCalendar(url: string): void {
    this.cals.delete(url);
  }

  externalPut(url: string, data: string): string {
    const cal = this.calOf(url);
    const etag = `"e${++this.etagSeq}"`;
    cal.items.set(url, { etag, data });
    cal.changes.set(url, { version: ++cal.version, removed: false });
    return etag;
  }

  externalDelete(url: string): void {
    const cal = this.calOf(url);
    cal.items.delete(url);
    cal.changes.set(url, { version: ++cal.version, removed: true });
  }

  forgetTokens(): void {
    this.epoch++;
  }

  stored(url: string): { etag: string; data: string } | undefined {
    return this.calOf(url).items.get(url);
  }

  async discover(): Promise<Discovery> {
    this.check("discover");
    return { principalUrl: "https://cal.test/dav/principals/abd/", homeUrl: HOME, addresses: ["abd@bench.test"] };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    this.check("listCalendars");
    return [...this.cals.values()].map((c) =>
      this.supportsSync ? { ...c.info, syncToken: this.token(c) } : { ...c.info, ctag: `ctag-${c.version}` },
    );
  }

  async syncCollection(calendarUrl: string, token?: string): Promise<SyncResult> {
    this.check(`sync ${token ?? "-"}`);
    if (!this.supportsSync) return { kind: "unsupported" };
    const cal = this.cals.get(calendarUrl)!;
    let since = 0;
    if (token) {
      const m = /^tok-(\d+)-(\d+)$/.exec(token);
      if (!m || Number(m[1]) !== this.epoch) {
        return this.echoUnknownTokens ? { kind: "ok", changed: [], removed: [], syncToken: token } : { kind: "invalid-token" };
      }
      since = Number(m[2]);
    }
    const changed: ItemRef[] = [];
    const removed: string[] = [];
    for (const [url, ch] of cal.changes) {
      if (ch.version <= since) continue;
      if (ch.removed) {
        if (token) removed.push(url);
      } else changed.push({ url, etag: cal.items.get(url)!.etag });
    }
    return { kind: "ok", changed, removed, syncToken: this.token(cal) };
  }

  async listEtags(calendarUrl: string): Promise<ItemRef[]> {
    this.check("listEtags");
    return [...this.cals.get(calendarUrl)!.items].map(([url, it]) => ({ url, etag: it.etag }));
  }

  async multiget(calendarUrl: string, urls: string[]): Promise<RemoteItem[]> {
    this.check(`multiget ${urls.length}`);
    const cal = this.cals.get(calendarUrl)!;
    return urls.flatMap((url) => {
      const it = cal.items.get(url);
      return it ? [{ url, ...it }] : [];
    });
  }

  async get(url: string): Promise<RemoteItem | null> {
    this.check("get");
    const it = this.calOf(url).items.get(url);
    return it ? { url, ...it } : null;
  }

  async put(url: string, data: string, baseEtag?: string): Promise<PutResult> {
    this.check(`put ${baseEtag ? "update" : "create"}`);
    await this.beforePut?.(url);
    const current = this.calOf(url).items.get(url);
    if (baseEtag ? current?.etag !== baseEtag : current) return { kind: "conflict" };
    return { kind: "ok", etag: this.externalPut(url, data) };
  }

  async delete(url: string, baseEtag?: string): Promise<DeleteResult> {
    this.check("delete");
    const current = this.calOf(url).items.get(url);
    if (!current) return "gone";
    if (baseEtag && current.etag !== baseEtag) return "conflict";
    this.externalDelete(url);
    return "ok";
  }

  private token(cal: FakeCalendar): string {
    return `tok-${this.epoch}-${cal.version}`;
  }

  private calOf(url: string): FakeCalendar {
    const cal = [...this.cals.values()].find((c) => url.startsWith(c.info.url));
    if (!cal) throw new Error(`no calendar for ${url}`);
    return cal;
  }

  async createCalendar(url: string, spec: NewCalendar): Promise<void> {
    this.check("createCalendar");
    if (this.cals.has(url)) throw new Error("Exists");
    this.cals.set(url, { info: { url, displayName: spec.displayName, color: spec.color, components: spec.components, readOnly: false }, items: new Map(), version: 0, changes: new Map() });
  }

  async deleteCalendar(url: string): Promise<void> {
    this.check("deleteCalendar");
    if (this.cals.get(url)?.info.readOnly) throw new Error("Refused");
    this.cals.delete(url);
  }

  async updateCalendar(url: string, changes: CalendarChanges): Promise<void> {
    this.check("updateCalendar");
    const cal = this.cals.get(url);
    if (!cal) throw new Error(`No calendar ${url}`);
    if (cal.info.readOnly) throw new Error("Refused");
    cal.info = { ...cal.info, ...changes };
  }

  private check(call: string): void {
    if (this.offline) throw new Error("Network is down");
    this.calls.push(call);
  }
}
