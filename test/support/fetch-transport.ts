import type { DavTransport } from "../../src/caldav/transport";

/** Node's fetch as a transport, for integration tests against a real server. */
export const fetchTransport: DavTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "follow" });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, text: await res.text() };
};
