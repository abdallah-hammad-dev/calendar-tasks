import type ICAL from "ical.js";

/** A video meeting to join: its link, and who runs it ("Teams", "Zoom"…; null for a service we don't know). */
export interface Meeting {
  url: string;
  provider: string | null;
}

type Comp = InstanceType<typeof ICAL.Component>;

/** Meeting services, by host: named on the button, and taken first from free text (place, description). */
const PROVIDERS: [RegExp, string][] = [
  [/(^|\.)teams\.(microsoft|live)\.com$/, "Teams"],
  [/(^|\.)zoom(gov)?\.(us|com)$/, "Zoom"],
  [/^meet\.google\.com$/, "Meet"],
  [/(^|\.)webex\.com$/, "Webex"],
  [/(^|\.)whereby\.com$/, "Whereby"],
  [/^meet\.jit\.si$/, "Jitsi"],
  [/(^|\.)gotomeeting\.com$|^meet\.goto\.com$/, "GoTo"],
  [/^join\.skype\.com$/, "Skype"],
  [/^facetime\.apple\.com$/, "FaceTime"],
];

/** Properties that are a meeting link by definition: RFC 7986's, then Google's and Microsoft's own. */
const MEETING_PROPS = ["conference", "x-google-conference", "x-microsoft-skypeteamsmeetingurl", "x-microsoft-onlinemeetingconflink"];

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\\]+/gi;

/** Links that are something else than a meeting (a map, a document or file, the calendar's or mail's own pages):
 * never taken as one from free text. */
const NOT_MEETINGS: RegExp[] = [
  /(^|\.)maps\.(google|apple)\.[a-z.]+$/, /^maps\.app\.goo\.gl$/, /^goo\.gl$/, /(^|\.)waze\.com$/, /(^|\.)openstreetmap\.org$/,
  /^(docs|drive|sheets|slides|forms|calendar|support|accounts|mail)\.google\.com$/, /^forms\.gle$/,
  /(^|\.)sharepoint\.com$/, /^onedrive\.live\.com$/, /^1drv\.ms$/, /(^|\.)dropbox\.com$/, /(^|\.)notion\.(so|site)$/,
  /^aka\.ms$/, /^go\.microsoft\.com$/, /^support\.(microsoft|apple)\.com$/, /^outlook\.(office|office365|live)\.com$/,
];
const NOT_MEETING_PATH = /\/maps(\/|$)|unsubscribe|groupsubscription|\.(pdf|docx?|xlsx?|pptx?|odt|ods|zip|png|jpe?g)$/i;

/** Words around a link in the notes that say it is the meeting's. */
const MEETING_WORDS = /visio|vid[ée]o|r[ée]union|meeting|join|rejoindre|conf[ée]rence|appel|call|webinai?re?/i;

/** A web link, unwrapped from mail scanners (Outlook Safe Links, Google's redirect); null if it isn't one. */
function webUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/[).,;:!?\]]+$/, ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const inner = host.endsWith("safelinks.protection.outlook.com")
    ? u.searchParams.get("url")
    : host === "www.google.com" && u.pathname === "/url"
      ? u.searchParams.get("q")
      : null;
  return inner ? webUrl(inner) : u;
}

function providerOf(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  return PROVIDERS.find(([re]) => re.test(host))?.[1] ?? null;
}

function mayBeMeeting(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return !NOT_MEETINGS.some((re) => re.test(host)) && !NOT_MEETING_PATH.test(u.pathname);
}

/** A link to a service we don't know that may be the meeting (2026-10-23, the user: "un lien inconnu dans les
 * notes, affiche-le comme rejoindre la visio"): the first on a line that speaks of a meeting, else the first. */
function anyIn(text: string): Meeting | null {
  let first: Meeting | null = null;
  for (const line of text.split(/\r?\n/)) {
    for (const m of line.matchAll(URL_IN_TEXT)) {
      const u = webUrl(m[0]);
      if (!u || !mayBeMeeting(u)) continue;
      const found = { url: u.href, provider: providerOf(u) };
      if (MEETING_WORDS.test(line)) return found;
      first ??= found;
    }
  }
  return first;
}

/** The first link to a meeting service in a text. */
function knownIn(text: string): Meeting | null {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const u = webUrl(m[0]);
    const provider = u && providerOf(u);
    if (u && provider) return { url: u.href, provider };
  }
  return null;
}

const seen = new WeakMap<Comp, Meeting | null>();

/**
 * The meeting to join for an event (spec §7.1): a property that says so (the video `CONFERENCE` first), else a link
 * to a meeting service in its `URL`, place or description (Teams puts it in the description, Zoom often in the place),
 * else any other link in its place, then in its description (a map, a document or a help page excepted). Never an
 * unknown link from `URL`: that is the event's web page, or our note's link.
 */
export function meetingOf(comp: Comp): Meeting | null {
  if (seen.has(comp)) return seen.get(comp)!;
  let found: Meeting | null = null;
  const said = MEETING_PROPS.flatMap((name) => comp.getAllProperties(name));
  const video = said.filter((p) => /video/i.test(String(p.getParameter("feature") ?? "")));
  for (const p of [...video, ...said]) {
    const u = webUrl(String(p.getFirstValue() ?? ""));
    if (u) {
      found = { url: u.href, provider: providerOf(u) };
      break;
    }
  }
  for (const name of ["url", "location", "description"]) {
    if (found) break;
    const v: unknown = comp.getFirstPropertyValue(name);
    found = typeof v === "string" ? knownIn(v) : null;
  }
  for (const name of ["location", "description"]) {
    if (found) break;
    const v: unknown = comp.getFirstPropertyValue(name);
    found = typeof v === "string" ? anyIn(v) : null;
  }
  seen.set(comp, found);
  return found;
}

/** The place to show: none when it's only the meeting's link (the join button stands for it). */
export function placeOf(location: string | null, meeting: Meeting | null): string | null {
  const text = location?.trim();
  if (!text) return null;
  if (meeting && !/\s/.test(text)) {
    const u = webUrl(text);
    if (u && (u.href === meeting.url || providerOf(u))) return null;
  }
  return text;
}
