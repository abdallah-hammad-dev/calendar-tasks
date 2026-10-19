import { describe, expect, it } from "vitest";
import { hrefs, key, NS, parseErrorConditions, parseMultistatus, text } from "../src/caldav/xml";
import { fixture } from "./support/fixtures";
import { xmldomParser as parse } from "./support/xmldom";

describe.each(["davis", "radicale"])("%s responses", (server) => {
  it("finds the current user principal", () => {
    const ms = parseMultistatus(fixture(`${server}-current-user-principal.xml`), parse);
    const principal = hrefs(ms.responses[0]!.props.get(key(NS.dav, "current-user-principal")))[0];
    expect(principal).toBe(server === "davis" ? "/dav/principals/abd/" : "/abd/");
  });

  it("reads the calendar home set", () => {
    const r = parseMultistatus(fixture(`${server}-principal.xml`), parse).responses[0]!;
    expect(hrefs(r.props.get(key(NS.cal, "calendar-home-set")))[0]).toBe(
      server === "davis" ? "/dav/calendars/abd/" : "/abd/",
    );
  });

  it("lists sync-collection changes with etags and the new token", () => {
    const ms = parseMultistatus(fixture(`${server}-sync-initial.xml`), parse);
    expect(ms.syncToken).toMatch(/sync/);
    const items = ms.responses.filter((r) => r.props.has(key(NS.dav, "getetag")));
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(text(r.props.get(key(NS.dav, "getetag")))).toMatch(/^"/);
  });

  it("recognizes an invalid sync token error", () => {
    expect(parseErrorConditions(fixture(`${server}-sync-invalid-token.xml`), parse)).toContain("valid-sync-token");
  });
});

describe("parseMultistatus", () => {
  it("keeps only properties from 200 propstats", () => {
    const ms = parseMultistatus(fixture("davis-calendar-home.xml"), parse);
    const home = ms.responses.find((r) => r.href === "/dav/calendars/abd/")!;
    expect(home.props.has(key(NS.dav, "resourcetype"))).toBe(true);
    expect(home.props.has(key(NS.dav, "displayname"))).toBe(false); // in the 404 propstat
  });

  it("reads response-level statuses (removed items)", () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/c/gone.ics</href>
      <status>HTTP/1.1 404 Not Found</status></response><sync-token>t2</sync-token></multistatus>`;
    const ms = parseMultistatus(xml, parse);
    expect(ms.responses[0]).toMatchObject({ href: "/c/gone.ics", status: 404 });
    expect(ms.syncToken).toBe("t2");
  });

  it("rejects what isn't a multistatus", () => {
    expect(() => parseMultistatus("<html/>", parse)).toThrow();
  });
});
