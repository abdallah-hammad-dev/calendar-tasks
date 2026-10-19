import { describe, expect, it } from "vitest";
import { CalDavClient, DavError } from "../src/caldav/client";
import type { DavRequest, DavResponse } from "../src/caldav/transport";
import { fixture } from "./support/fixtures";
import { xmldomParser } from "./support/xmldom";

type Handler = (req: DavRequest) => Partial<DavResponse> | undefined;

/** Scripted server: the first handler that answers wins; anything unanswered is a 404. */
function client(handlers: Handler[], serverUrl = "https://cal.test/dav/") {
  const requests: DavRequest[] = [];
  const c = new CalDavClient({
    serverUrl,
    username: "abd",
    password: "pässword",
    parseXml: xmldomParser,
    transport: async (req) => {
      requests.push(req);
      for (const h of handlers) {
        const r = h(req);
        if (r) return { status: 200, headers: {}, text: "", ...r };
      }
      return { status: 404, headers: {}, text: "" };
    },
  });
  return { c, requests };
}

const at = (method: string, path: string, res: Partial<DavResponse>): Handler => (req) =>
  req.method === method && new URL(req.url).pathname === path ? res : undefined;

describe("CalDavClient.discover", () => {
  it("finds principal, home and the user's addresses (Davis)", async () => {
    const { c, requests } = client([
      at("PROPFIND", "/dav/", { status: 207, text: fixture("davis-current-user-principal.xml") }),
      at("PROPFIND", "/dav/principals/abd/", { status: 207, text: fixture("davis-principal.xml") }),
    ]);
    expect(await c.discover()).toEqual({
      principalUrl: "https://cal.test/dav/principals/abd/",
      homeUrl: "https://cal.test/dav/calendars/abd/",
      addresses: ["abd@bench.test"],
    });
    expect(requests[0]!.headers?.Authorization).toBe(`Basic ${Buffer.from("abd:pässword").toString("base64")}`);
  });

  it("falls back to /.well-known/caldav", async () => {
    const { c } = client(
      [
        at("PROPFIND", "/.well-known/caldav", { status: 207, text: fixture("radicale-current-user-principal.xml") }),
        at("PROPFIND", "/abd/", { status: 207, text: fixture("radicale-principal.xml") }),
      ],
      "https://cal.test/",
    );
    const d = await c.discover();
    expect(d.homeUrl).toBe("https://cal.test/abd/");
    expect(d.addresses).toEqual([]); // Radicale doesn't advertise a mailto address
  });

  it("reports wrong credentials clearly", async () => {
    const { c } = client([() => ({ status: 401 })]);
    await expect(c.discover()).rejects.toThrow(new DavError("Wrong username or password", 401));
  });
});

describe("CalDavClient.listCalendars", () => {
  it("keeps calendars only, with components, token and write access", async () => {
    const { c } = client([at("PROPFIND", "/dav/calendars/abd/", { status: 207, text: fixture("davis-calendar-home.xml") })]);
    const cals = await c.listCalendars("https://cal.test/dav/calendars/abd/");
    const byName = Object.fromEntries(cals.map((x) => [x.displayName, x]));
    // No inbox/outbox, no home. DEFAULT_TASK_CALENDAR_NAME: the list iOS creates when Reminders is turned on.
    expect(Object.keys(byName).sort()).toEqual(["DEFAULT_TASK_CALENDAR_NAME", "Default Calendar", "Tests"]);
    expect(byName.DEFAULT_TASK_CALENDAR_NAME!.components).toEqual(["VTODO"]);
    expect(byName["Default Calendar"]).toMatchObject({ components: ["VEVENT"], readOnly: false });
    expect(byName.Tests!.components).toEqual(["VEVENT", "VTODO"]);
    expect(byName.Tests!.syncToken).toMatch(/^http:\/\/sabre\.io\/ns\/sync\/\d+$/);
    expect(byName.Tests!.ctag).toBe(byName.Tests!.syncToken); // sabre uses the same value for both
  });
});

describe("CalDavClient.syncCollection", () => {
  const url = "https://cal.test/dav/calendars/abd/tests/";

  it("returns changed and removed items with the new token", async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/calendars/abd/tests/a.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/calendars/abd/tests/b.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
      <d:sync-token>tok-2</d:sync-token></d:multistatus>`;
    const { c, requests } = client([at("REPORT", "/dav/calendars/abd/tests/", { status: 207, text: xml })]);
    expect(await c.syncCollection(url, "tok-1")).toEqual({
      kind: "ok",
      changed: [{ url: `${url}a.ics`, etag: '"1"' }],
      removed: [`${url}b.ics`],
      syncToken: "tok-2",
    });
    expect(requests[0]!.body).toContain("<d:sync-token>tok-1</d:sync-token>");
  });

  it("maps the valid-sync-token error to invalid-token", async () => {
    const { c } = client([() => ({ status: 403, text: fixture("davis-sync-invalid-token.xml") })]);
    expect(await c.syncCollection(url, "old")).toEqual({ kind: "invalid-token" });
  });

  it("says unsupported when the server can't do sync-collection", async () => {
    const { c } = client([() => ({ status: 501 })]);
    expect(await c.syncCollection(url)).toEqual({ kind: "unsupported" });
  });
});

describe("CalDavClient writes", () => {
  const url = "https://cal.test/dav/calendars/abd/tests/a.ics";

  it("creates with If-None-Match and updates with If-Match", async () => {
    const { c, requests } = client([() => ({ status: 201, headers: { etag: '"e2"' } })]);
    expect(await c.put(url, "DATA")).toEqual({ kind: "ok", etag: '"e2"' });
    expect(await c.put(url, "DATA", '"e1"')).toEqual({ kind: "ok", etag: '"e2"' });
    expect(requests[0]!.headers).toMatchObject({ "If-None-Match": "*", "Content-Type": "text/calendar; charset=utf-8" });
    expect(requests[1]!.headers).toMatchObject({ "If-Match": '"e1"' });
  });

  it("turns 412 into a conflict, never an overwrite", async () => {
    const { c } = client([() => ({ status: 412 })]);
    expect(await c.put(url, "DATA", '"stale"')).toEqual({ kind: "conflict" });
    expect(await c.delete(url, '"stale"')).toBe("conflict");
  });

  it("treats deleting a missing item as done", async () => {
    const { c } = client([]);
    expect(await c.delete(url, '"e1"')).toBe("gone");
  });

  it("reads calendar data from a multiget", async () => {
    const { c } = client([at("REPORT", "/dav/calendars/abd/tests/", { status: 207, text: fixture("davis-multiget.xml") })]);
    const items = await c.multiget("https://cal.test/dav/calendars/abd/tests/", [
      "https://cal.test/dav/calendars/abd/tests/test-parent.ics",
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.data).toContain("UID:test-parent");
    expect(items[0]!.etag).toMatch(/^"/);
  });
});

describe("CalDavClient.updateCalendar", () => {
  const ms = (status: string) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars/abd/r/</d:href>` +
    `<d:propstat><d:prop><d:displayname/><x1:calendar-color xmlns:x1="http://apple.com/ns/ical/"/></d:prop>` +
    `<d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response></d:multistatus>`;

  it("sends a PROPPATCH with the name (escaped) and the color (Davis's answer)", async () => {
    const { c, requests } = client([at("PROPPATCH", "/dav/calendars/abd/r/", { status: 207, text: ms("200 OK") })]);
    await c.updateCalendar("https://cal.test/dav/calendars/abd/r/", { displayName: "Rappels & co", color: "#FF9500FF" });
    const body = requests[0]!.body!;
    expect(body).toContain("<d:displayname>Rappels &amp; co</d:displayname>");
    expect(body).toContain('xmlns:a="http://apple.com/ns/ical/"');
    expect(body).toContain("<a:calendar-color>#FF9500FF</a:calendar-color>");
  });

  it("fails when the server refuses a property", async () => {
    const { c } = client([at("PROPPATCH", "/dav/calendars/abd/r/", { status: 207, text: ms("403 Forbidden") })]);
    await expect(c.updateCalendar("https://cal.test/dav/calendars/abd/r/", { color: "#FF9500FF" })).rejects.toThrow(DavError);
  });
});
