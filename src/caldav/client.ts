import { basicAuth, type DavResponse, type DavTransport } from "./transport";
import { child, children, escapeXml, hrefs, key, NS, parseErrorConditions, parseMultistatus, text } from "./xml";
import type { Multistatus, XNode, XmlParser } from "./xml";

export interface Discovery {
  principalUrl: string;
  homeUrl: string;
  /** "Me" as the server sees it (`calendar-user-address-set`, mailto only), lowercase, without `mailto:`. */
  addresses: string[];
}

export interface CalendarInfo {
  url: string;
  displayName: string;
  color?: string;
  /** Supported components, e.g. ["VEVENT", "VTODO"]. */
  components: string[];
  /** The server's current sync token (DAV:sync-token), if it advertises one. */
  syncToken?: string;
  /** The calendar's ctag (CalendarServer extension), for servers without sync tokens. */
  ctag?: string;
  /** No write privilege, e.g. a mirror of an external account. */
  readOnly: boolean;
}

export interface ItemRef {
  url: string;
  etag: string;
}

export interface RemoteItem extends ItemRef {
  data: string;
}

export type SyncResult =
  | { kind: "ok"; changed: ItemRef[]; removed: string[]; syncToken: string }
  | { kind: "invalid-token" }
  | { kind: "unsupported" };

export type PutResult = { kind: "ok"; etag?: string } | { kind: "conflict" };

/** What can be changed on a calendar itself. */
export interface CalendarChanges {
  displayName?: string;
  /** "#RRGGBB" or Apple's "#RRGGBBAA". */
  color?: string;
}
export type DeleteResult = "ok" | "gone" | "conflict";

/** A calendar to create: its name, color, and what it holds. */
export interface NewCalendar {
  displayName: string;
  color: string;
  components: ("VEVENT" | "VTODO")[];
}

export class DavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DavError";
  }
}

/**
 * The status of a change the server refuses for good (sent again, it would be refused again: invalid data, too
 * big, forbidden), else null. Wrong credentials, rate limits, timeouts and server errors pass.
 */
export function refusalStatus(e: unknown): number | null {
  if (!(e instanceof DavError) || e.status === undefined) return null;
  const s = e.status;
  return s >= 400 && s < 500 && ![401, 407, 408, 423, 425, 429].includes(s) ? s : null;
}

/** What the sync engine needs from a server; `CalDavClient` is the real one, tests use fakes. */
export interface CalDavApi {
  discover(): Promise<Discovery>;
  listCalendars(homeUrl: string): Promise<CalendarInfo[]>;
  syncCollection(calendarUrl: string, token?: string): Promise<SyncResult>;
  listEtags(calendarUrl: string): Promise<ItemRef[]>;
  multiget(calendarUrl: string, urls: string[]): Promise<RemoteItem[]>;
  get(url: string): Promise<RemoteItem | null>;
  put(url: string, data: string, baseEtag?: string): Promise<PutResult>;
  delete(url: string, baseEtag?: string): Promise<DeleteResult>;
  updateCalendar(url: string, changes: CalendarChanges): Promise<void>;
  createCalendar(url: string, spec: NewCalendar): Promise<void>;
  deleteCalendar(url: string): Promise<void>;
}

export interface ClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  transport: DavTransport;
  parseXml: XmlParser;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const MULTIGET_CHUNK = 50;

/** A small CalDAV client (RFC 4791, sync-collection RFC 6578), written against Davis and Radicale. */
export class CalDavClient implements CalDavApi {
  private readonly auth: string;

  constructor(private readonly opts: ClientOptions) {
    this.auth = basicAuth(opts.username, opts.password);
  }

  async discover(): Promise<Discovery> {
    const body = `${XML_HEAD}<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
    let principal: string | undefined;
    let base = this.opts.serverUrl;
    for (const candidate of [this.opts.serverUrl, new URL("/.well-known/caldav", this.opts.serverUrl).href]) {
      const res = await this.request("PROPFIND", candidate, body, { Depth: "0" });
      if (res.status === 401) throw new DavError("Wrong username or password", 401);
      if (res.status !== 207) continue;
      const found = this.multistatus(res).responses.flatMap((r) =>
        hrefs(r.props.get(key(NS.dav, "current-user-principal"))),
      )[0];
      if (found) {
        principal = found;
        base = candidate;
        break;
      }
    }
    if (!principal) throw new DavError("No CalDAV account found at this address");
    const principalUrl = new URL(principal, base).href;

    const res = await this.expect207(
      "PROPFIND",
      principalUrl,
      `${XML_HEAD}<d:propfind xmlns:d="DAV:" xmlns:c="${NS.cal}"><d:prop>` +
        `<c:calendar-home-set/><c:calendar-user-address-set/></d:prop></d:propfind>`,
      { Depth: "0" },
    );
    const r = this.multistatus(res).responses[0];
    const home = hrefs(r?.props.get(key(NS.cal, "calendar-home-set")))[0];
    if (!home) throw new DavError("The account has no calendar home");
    const addresses = hrefs(r?.props.get(key(NS.cal, "calendar-user-address-set")))
      .filter((h) => h.toLowerCase().startsWith("mailto:"))
      .map((h) => h.slice(7).toLowerCase());
    return { principalUrl, homeUrl: new URL(home, principalUrl).href, addresses };
  }

  async listCalendars(homeUrl: string): Promise<CalendarInfo[]> {
    const res = await this.expect207(
      "PROPFIND",
      homeUrl,
      `${XML_HEAD}<d:propfind xmlns:d="DAV:" xmlns:c="${NS.cal}" xmlns:cs="${NS.cs}" xmlns:a="${NS.apple}"><d:prop>` +
        `<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/>` +
        `<a:calendar-color/><d:current-user-privilege-set/></d:prop></d:propfind>`,
      { Depth: "1" },
    );
    const out: CalendarInfo[] = [];
    for (const r of this.multistatus(res).responses) {
      const type = r.props.get(key(NS.dav, "resourcetype"));
      if (!type || !child(type, NS.cal, "calendar")) continue;
      const comps = r.props.get(key(NS.cal, "supported-calendar-component-set"));
      const components = comps
        ? children(comps, NS.cal, "comp").map((c) => (c.getAttribute?.("name") ?? "").toUpperCase())
        : ["VEVENT", "VTODO"];
      const url = new URL(r.href, homeUrl).href;
      out.push({
        url,
        displayName: text(r.props.get(key(NS.dav, "displayname"))) || decodeURIComponent(lastSegment(url)),
        color: text(r.props.get(key(NS.apple, "calendar-color"))) || undefined,
        components,
        syncToken: text(r.props.get(key(NS.dav, "sync-token"))) || undefined,
        ctag: text(r.props.get(key(NS.cs, "getctag"))) || undefined,
        readOnly: !canWrite(r.props.get(key(NS.dav, "current-user-privilege-set"))),
      });
    }
    return out;
  }

  async syncCollection(calendarUrl: string, token?: string): Promise<SyncResult> {
    const res = await this.request(
      "REPORT",
      calendarUrl,
      `${XML_HEAD}<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token ? escapeXml(token) : ""}</d:sync-token>` +
        `<d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
      { Depth: "0" },
    );
    if (res.status === 207) {
      const ms = this.multistatus(res);
      const changed: ItemRef[] = [];
      const removed: string[] = [];
      for (const r of ms.responses) {
        const url = new URL(r.href, calendarUrl).href;
        if (url === calendarUrl) continue;
        const etag = text(r.props.get(key(NS.dav, "getetag")));
        if (r.status === 404) removed.push(url);
        else if (etag) changed.push({ url, etag });
      }
      if (!ms.syncToken) return { kind: "unsupported" };
      return { kind: "ok", changed, removed, syncToken: ms.syncToken };
    }
    if (parseErrorConditions(res.text, this.opts.parseXml).includes("valid-sync-token")) return { kind: "invalid-token" };
    if ([400, 403, 405, 409, 415, 501].includes(res.status)) return token ? { kind: "invalid-token" } : { kind: "unsupported" };
    throw new DavError(`Sync failed (HTTP ${res.status})`, res.status);
  }

  async listEtags(calendarUrl: string): Promise<ItemRef[]> {
    const res = await this.expect207(
      "PROPFIND",
      calendarUrl,
      `${XML_HEAD}<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`,
      { Depth: "1" },
    );
    return this.multistatus(res)
      .responses.map((r) => ({ url: new URL(r.href, calendarUrl).href, etag: text(r.props.get(key(NS.dav, "getetag"))) }))
      .filter((r) => r.url !== calendarUrl && r.etag);
  }

  async multiget(calendarUrl: string, urls: string[]): Promise<RemoteItem[]> {
    const out: RemoteItem[] = [];
    for (let i = 0; i < urls.length; i += MULTIGET_CHUNK) {
      const chunk = urls.slice(i, i + MULTIGET_CHUNK);
      const res = await this.expect207(
        "REPORT",
        calendarUrl,
        `${XML_HEAD}<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${NS.cal}"><d:prop><d:getetag/><c:calendar-data/>` +
          `</d:prop>${chunk.map((u) => `<d:href>${escapeXml(new URL(u).pathname)}</d:href>`).join("")}` +
          `</c:calendar-multiget>`,
        { Depth: "1" },
      );
      for (const r of this.multistatus(res).responses) {
        const data = r.props.get(key(NS.cal, "calendar-data"))?.textContent ?? "";
        const etag = text(r.props.get(key(NS.dav, "getetag")));
        if (data && etag) out.push({ url: new URL(r.href, calendarUrl).href, etag, data });
      }
    }
    return out;
  }

  /**
   * One item, read with a multiget on its collection rather than a GET: the ETag then comes from the answer's body.
   * A server that compresses its answer may change the ETag *header*, and If-Match refuses that one (Davis's
   * Caddy appends "-gzip" over 512 bytes; Obsidian asks for gzip). A missing item (or collection) is null.
   */
  async get(url: string): Promise<RemoteItem | null> {
    try {
      const [item] = await this.multiget(new URL(".", url).href, [url]);
      return item ? { ...item, url } : null;
    } catch (e) {
      if (e instanceof DavError && (e.status === 404 || e.status === 410)) return null;
      throw e;
    }
  }

  async put(url: string, data: string, baseEtag?: string): Promise<PutResult> {
    const res = await this.request("PUT", url, data, {
      "Content-Type": "text/calendar; charset=utf-8",
      ...(baseEtag ? { "If-Match": baseEtag } : { "If-None-Match": "*" }),
    });
    if (res.status === 412) return { kind: "conflict" };
    if (res.status === 200 || res.status === 201 || res.status === 204) return { kind: "ok", etag: res.headers.etag };
    throw new DavError(`Write failed (HTTP ${res.status})`, res.status);
  }

  async delete(url: string, baseEtag?: string): Promise<DeleteResult> {
    const res = await this.request("DELETE", url, undefined, baseEtag ? { "If-Match": baseEtag } : {});
    if (res.status === 412) return "conflict";
    if (res.status === 404 || res.status === 410) return "gone";
    if (res.status >= 200 && res.status < 300) return "ok";
    throw new DavError(`Delete failed (HTTP ${res.status})`, res.status);
  }

  /**
   * Renames a calendar or changes its color (PROPPATCH; the color is Apple's `calendar-color`, which iOS reads).
   * The server answers per property; one refused means none was applied (RFC 4918 §9.2), so that's an error.
   */
  async updateCalendar(url: string, changes: CalendarChanges): Promise<void> {
    const props: [string, string, string][] = [];
    if (changes.displayName !== undefined) props.push([NS.dav, "displayname", `<d:displayname>${escapeXml(changes.displayName)}</d:displayname>`]);
    if (changes.color !== undefined) props.push([NS.apple, "calendar-color", `<a:calendar-color>${escapeXml(changes.color)}</a:calendar-color>`]);
    if (!props.length) return;
    const res = await this.expect207(
      "PROPPATCH",
      url,
      `${XML_HEAD}<d:propertyupdate xmlns:d="DAV:" xmlns:a="${NS.apple}"><d:set><d:prop>` +
        `${props.map((p) => p[2]).join("")}</d:prop></d:set></d:propertyupdate>`,
      {},
    );
    const done = this.multistatus(res).responses[0]?.props;
    if (!props.every(([ns, local]) => done?.has(key(ns, local)))) throw new DavError("The server refused to change this calendar");
  }

  /** A new calendar at `url` (MKCALENDAR, RFC 4791 §5.3.1), named, colored, holding events or tasks. */
  async createCalendar(url: string, spec: NewCalendar): Promise<void> {
    const res = await this.request(
      "MKCALENDAR",
      url,
      `${XML_HEAD}<c:mkcalendar xmlns:d="DAV:" xmlns:c="${NS.cal}" xmlns:a="${NS.apple}"><d:set><d:prop>` +
        `<d:displayname>${escapeXml(spec.displayName)}</d:displayname><a:calendar-color>${escapeXml(spec.color)}</a:calendar-color>` +
        `<c:supported-calendar-component-set>${spec.components.map((c) => `<c:comp name="${c}"/>`).join("")}</c:supported-calendar-component-set>` +
        `</d:prop></d:set></c:mkcalendar>`,
    );
    if (res.status === 401) throw new DavError("Wrong username or password", 401);
    if (res.status !== 201) throw new DavError(`The server refused to create the calendar (HTTP ${res.status})`, res.status);
  }

  /** Deletes a calendar and everything in it; one already gone counts as deleted. */
  async deleteCalendar(url: string): Promise<void> {
    const res = await this.request("DELETE", url);
    if (res.status === 401) throw new DavError("Wrong username or password", 401);
    if (res.status === 404 || res.status === 410 || (res.status >= 200 && res.status < 300)) return;
    throw new DavError(`The server refused to delete the calendar (HTTP ${res.status})`, res.status);
  }

  private async request(
    method: string,
    url: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<DavResponse> {
    return this.opts.transport({
      method,
      url,
      body,
      headers: {
        Authorization: this.auth,
        ...(body !== undefined && method !== "PUT" ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
        ...headers,
      },
    });
  }

  private async expect207(method: string, url: string, body: string, headers: Record<string, string>) {
    const res = await this.request(method, url, body, headers);
    if (res.status === 401) throw new DavError("Wrong username or password", 401);
    if (res.status !== 207) throw new DavError(`${method} ${new URL(url).pathname} failed (HTTP ${res.status})`, res.status);
    return res;
  }

  private multistatus(res: DavResponse): Multistatus {
    return parseMultistatus(res.text, this.opts.parseXml);
  }
}

function canWrite(privileges: XNode | undefined): boolean {
  if (!privileges) return true;
  const names = children(privileges, NS.dav, "privilege").flatMap((p) => children(p).map((c) => c.localName));
  return names.some((n) => n === "write" || n === "write-content" || n === "all");
}

function lastSegment(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
}
