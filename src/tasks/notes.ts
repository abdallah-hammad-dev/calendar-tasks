import { NOTE_TYPE, PROP, type Priority } from "../constants";
import { formatLocalDate, formatLocalDateTime, parseLocal } from "../ical/time";
import { repeatFromNote } from "../editor/when";

/** What a task note says, read from its frontmatter. */
export interface NoteState {
  done: boolean;
  due: string | null;
  /** RRULE; null = doesn't repeat; undefined = a `repeat` that isn't understood (left alone on the server). */
  repeat: string | null | undefined;
  /** null = none; undefined = a `priority` that isn't one (left alone on the server). */
  priority: Priority | null | undefined;
  /** Link paths (inside `[[…]]`), not resolved. */
  project: string | null;
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
    project: linkpathOf(fm[PROP.project]),
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

/** A note's `collection` (a task's, or a project's: where its tasks go), as written; null when there's none. */
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

/** `"[[Olera]]"`, `"[[Projects/Olera|Olera]]"`, `"Olera"` (or a one-item list) → link path. */
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
  return (s || "Untitled task").slice(0, MAX_TITLE).trim();
}

/** Whether a note's file name stands for this summary (including the " (2)" we add for duplicates). */
export function titleMatches(summary: string, basename: string): boolean {
  const t = sanitizeTitle(summary);
  return basename === t || new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`).test(basename);
}

/** `folder/base.md`, or `folder/base (2).md`… if taken. */
export function uniquePath(exists: (path: string) => boolean, folder: string, base: string): string {
  const prefix = folder ? `${folder}/` : "";
  let path = `${prefix}${base}.md`;
  for (let i = 2; exists(path); i++) path = `${prefix}${base} (${i}).md`;
  return path;
}
