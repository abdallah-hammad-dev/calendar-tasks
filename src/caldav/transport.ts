import { requestUrl } from "obsidian";

export interface DavRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DavResponse {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  text: string;
}

/** One HTTP round trip. Throws only on network failure; HTTP errors come back as a status. */
export type DavTransport = (req: DavRequest) => Promise<DavResponse>;

/** Obsidian's `requestUrl`: no CORS on mobile, custom methods (PROPFIND, REPORT) allowed, redirects followed. */
export const obsidianTransport: DavTransport = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  return { status: res.status, headers: lowerKeys(res.headers), text: res.text };
};

export function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** `Authorization` header value; UTF-8 safe. */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}
