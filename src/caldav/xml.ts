/**
 * Just enough WebDAV XML: multistatus responses and error bodies, matched by namespace (servers use any prefix,
 * or none). Works on any DOM implementation: the browser's DOMParser in Obsidian, xmldom in tests.
 */

export const NS = {
  dav: "DAV:",
  cal: "urn:ietf:params:xml:ns:caldav",
  cs: "http://calendarserver.org/ns/",
  apple: "http://apple.com/ns/ical/",
} as const;

/** The DOM surface we use, shared by browser DOM and xmldom. */
export interface XNode {
  nodeType: number;
  localName?: string | null;
  namespaceURI?: string | null;
  textContent: string | null;
  childNodes: ArrayLike<XNode>;
  getAttribute?(name: string): string | null;
}

/** Parses an XML string and returns its root element. */
export type XmlParser = (xml: string) => XNode;

export const domParser: XmlParser = (xml) =>
  new DOMParser().parseFromString(xml, "application/xml").documentElement;

export function children(node: XNode, ns?: string, local?: string): XNode[] {
  const out: XNode[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c && c.nodeType === 1 && (!ns || c.namespaceURI === ns) && (!local || c.localName === local)) out.push(c);
  }
  return out;
}

export function child(node: XNode, ns: string, local: string): XNode | undefined {
  return children(node, ns, local)[0];
}

export function text(node: XNode | undefined): string {
  return (node?.textContent ?? "").trim();
}

/** Texts of the `DAV:href` children of a property element. */
export function hrefs(prop: XNode | undefined): string[] {
  return prop ? children(prop, NS.dav, "href").map(text).filter(Boolean) : [];
}

export interface DavPropResponse {
  href: string;
  /** Response-level status (e.g. 404 for a removed item in a sync-collection report). */
  status?: number;
  /** Properties found with a 200 propstat, keyed `"<namespace> <local-name>"`. */
  props: Map<string, XNode>;
}

export interface Multistatus {
  responses: DavPropResponse[];
  syncToken?: string;
}

export const key = (ns: string, local: string): string => `${ns} ${local}`;

export function parseStatus(line: string): number | undefined {
  const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line.trim());
  return m ? Number(m[1]) : undefined;
}

export function parseMultistatus(xml: string, parse: XmlParser): Multistatus {
  const root = parse(xml);
  if (root.localName !== "multistatus" || root.namespaceURI !== NS.dav) throw new Error("Not a DAV multistatus");
  const responses = children(root, NS.dav, "response").map((r): DavPropResponse => {
    const props = new Map<string, XNode>();
    for (const ps of children(r, NS.dav, "propstat")) {
      if (parseStatus(text(child(ps, NS.dav, "status"))) !== 200) continue;
      const prop = child(ps, NS.dav, "prop");
      for (const p of prop ? children(prop) : []) props.set(key(p.namespaceURI ?? "", p.localName ?? ""), p);
    }
    const status = child(r, NS.dav, "status");
    return { href: text(child(r, NS.dav, "href")), status: status ? parseStatus(text(status)) : undefined, props };
  });
  const token = child(root, NS.dav, "sync-token");
  return { responses, syncToken: token ? text(token) : undefined };
}

/** Precondition names in a `DAV:error` body (e.g. `valid-sync-token`). Empty if the body is not one. */
export function parseErrorConditions(xml: string, parse: XmlParser): string[] {
  try {
    const root = parse(xml);
    if (root.localName !== "error" || root.namespaceURI !== NS.dav) return [];
    return children(root).map((c) => c.localName ?? "");
  } catch {
    return [];
  }
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}
