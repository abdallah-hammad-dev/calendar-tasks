import { NOTE_TYPE, PROP, type Priority } from "../constants";
import { formatLocalDate, formatLocalDateTime, parseLocal } from "../ical/time";
import { repeatFromNote } from "../editor/when";
import { tagsOf } from "./tags";

/** What a task note says, read from its frontmatter. */
export interface NoteState {
  done: boolean;
  due: string | null;
  /** RRULE; null = doesn't repeat; undefined = a `repeat` that isn't understood (left alone on the server). */
  repeat: string | null | undefined;
  /** null = none; undefined = a `priority` that isn't one (left alone on the server). */
  priority: Priority | null | undefined;
  /** Its tags (without "#"), as written. */
  tags: string[];
  /** Link path (inside `[[…]]`), not resolved. */
  parent: string | null;
  /** When the task was made, local "YYYY-MM-DD[THH:mm]"; null = none; undefined = unreadable (left alone). */
  created: string | null | undefined;
  /** When it was ticked, local "YYYY-MM-DDTHH:mm"; null = none (or unreadable). */
  completed: string | null;
  /** Each time a repeating task was ticked, oldest first (values that can't be read are left out). */
  completions: string[];
  uid: string | null;
  /** The collection named in the note, as written (not resolved). */
  collection: string | null;
}

export function isTaskNote(fm: Record<string, unknown> | null | undefined): boolean {
  return !!fm && fm[PROP.type] === NOTE_TYPE.task;
}

export function readNote(fm: Record<string, unknown> | null | undefined): NoteState | null {
  if (!fm || !isTaskNote(fm)) return null;
  const uid = fm[PROP.uid];
  return {
    done: fm[PROP.done] === true || fm[PROP.done] === "true",
    due: normalizeDue(fm[PROP.due]),
    repeat: fm[PROP.repeat] === undefined || fm[PROP.repeat] === null || fm[PROP.repeat] === "" ? null : (repeatFromNote(fm[PROP.repeat]) ?? undefined),
    priority: priorityOf(fm[PROP.priority]),
    tags: tagsOf(fm[PROP.tags]),
    parent: linkpathOf(fm[PROP.parent]),
    created: fm[PROP.created] === undefined || fm[PROP.created] === null || fm[PROP.created] === "" ? null : (normalizeDue(fm[PROP.created]) ?? undefined),
    completed: normalizeDue(fm[PROP.completed]),
    completions: (Array.isArray(fm[PROP.completions]) ? (fm[PROP.completions] as unknown[]) : [fm[PROP.completions]]).flatMap((v) => normalizeDue(v) ?? []),
    uid: typeof uid === "string" && uid.trim() ? uid.trim() : null,
    collection: collectionOf(fm),
  };
}

/** Ticks or unticks a task note (its frontmatter): ticked, it says when (`now`, local); unticked, that goes. */
export function setDone(fm: Record<string, unknown>, done: boolean, now: string): void {
  if (done && fm[PROP.done] !== true) fm[PROP.completed] = now;
  if (!done) delete fm[PROP.completed];
  fm[PROP.done] = done;
}

const PRIORITY_WORDS: Record<string, Priority> = { high: "high", haute: "high", medium: "medium", moyenne: "medium", low: "low", basse: "low" };

/** A note's `priority`: high / medium / low (haute / moyenne / basse read too); null when there's none. */
export function priorityOf(v: unknown): Priority | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" ? PRIORITY_WORDS[v.trim().toLowerCase()] : undefined;
}

/** A task note's `collection`, as written; null when there's none. */
export function collectionOf(fm: Record<string, unknown> | null | undefined): string | null {
  const raw: unknown = fm?.[PROP.collection];
  const v = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * A local date or date-time (`due`, `created`): "2026-10-15", "2026-10-15T14:00", "2026-10-15 14:00" (or a Date) →
 * canonical local value; else null.
 */
export function normalizeDue(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // A YAML timestamp: js-yaml reads zone-less values as UTC, so the UTC fields are what was written.
    const wall = {
      year: v.getUTCFullYear(),
      month: v.getUTCMonth() + 1,
      day: v.getUTCDate(),
      hour: v.getUTCHours(),
      minute: v.getUTCMinutes(),
      second: 0,
    };
    return wall.hour || wall.minute ? formatLocalDateTime(wall) : formatLocalDate(wall);
  }
  if (typeof v !== "string") return null;
  const p = parseLocal(v);
  if (!p) return null;
  return p.allDay ? formatLocalDate(p.wall) : formatLocalDateTime(p.wall);
}

/** `"[[Rapport]]"`, `"[[Tasks/Rapport|Rapport]]"`, `"Rapport"` (or a one-item list) → link path. */
export function linkpathOf(v: unknown): string | null {
  const raw: unknown = Array.isArray(v) ? (v as unknown[])[0] : v;
  if (typeof raw !== "string") return null;
  const inner = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw)?.[1] ?? raw;
  const path = inner.split("|")[0]!.split("#")[0]!.trim();
  return path || null;
}

const FORBIDDEN = /[\\/:*?"<>|#^[\]\r\n\t]+/g;
const MAX_TITLE = 120;

/** A task title as a file name: forbidden characters become spaces; never empty. */
export function sanitizeTitle(summary: string): string {
  const s = summary.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  // By characters: a cut inside an emoji leaves half of it, which can't be a file name.
  return [...(s || "Untitled task")].slice(0, MAX_TITLE).join("").trim();
}

/** Whether a note's file name stands for this summary (including the " (2)" we add for duplicates). */
export function titleMatches(summary: string, basename: string): boolean {
  return nameMatches(sanitizeTitle(summary), basename);
}

/** Whether a note's file name is `name`, or `name (2)`…: a name already made, not cut again. */
export function nameMatches(name: string, basename: string): boolean {
  return basename === name || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`).test(basename);
}

/** `folder/base.md`, or `folder/base (2).md`… if taken. */
/**
 * The UID of the reminder of a task note made outside the plugin (by hand, from a template): the same on every
 * device, so two devices seeing the new note before either wrote its UID make one reminder, not two. A UUID's
 * shape, from a 128-bit hash (cyrb128) of the vault's name and the note's path.
 */
export function noteUid(vault: string, path: string): string {
  const key = `${vault}/${path}`.normalize("NFC");
  let [a, b, c, d] = [1779033703, 3144134277, 1013904242, 2773480762];
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    a = b ^ Math.imul(a ^ k, 597399067);
    b = c ^ Math.imul(b ^ k, 2869860233);
    c = d ^ Math.imul(c ^ k, 951274213);
    d = a ^ Math.imul(d ^ k, 2716044179);
  }
  a = Math.imul(c ^ (a >>> 18), 597399067);
  b = Math.imul(d ^ (b >>> 22), 2869860233);
  c = Math.imul(a ^ (c >>> 17), 951274213);
  d = Math.imul(b ^ (d >>> 19), 2716044179);
  a ^= b ^ c ^ d;
  const h = [a, b ^ a, c ^ a, d ^ a].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uniquePath(exists: (path: string) => boolean, folder: string, base: string): string {
  const prefix = folder ? `${folder}/` : "";
  let path = `${prefix}${base}.md`;
  for (let i = 2; exists(path); i++) path = `${prefix}${base} (${i}).md`;
  return path;
}
