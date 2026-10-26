import { NOTE_TYPE, PROP } from "../constants";
import { isTaskNote, sanitizeTitle } from "../tasks/notes";
import { findTags, tagsOf } from "../tasks/tags";
import type { VaultPort } from "../tasks/TaskSync";
import { findWhen, repeatToNote, type Block, type WhenToken } from "./when";

export interface LineParts {
  indent: string;
  bullet: string;
  text: string;
}

const TASK_LINE = /^(\s*)([-*+]) \[ \] (.*\S.*)$/;
const LINK = /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** `- [ ] text` (also `*` and `+`), not ticked ones. */
export function parseTaskLine(line: string): LineParts | null {
  const m = TASK_LINE.exec(line);
  return m ? { indent: m[1]!, bullet: m[2]!, text: m[3]!.trim() } : null;
}

const LINK_LINE = /^\s*[-*+] (?:\[.\] )?\[\[([^\]|#]+)[^\]]*\]\]/;

/** A list line that starts with a link (`- [[Task]] …`, what a converted line looks like): the link and where it ends. */
export function parseLinkLine(line: string): { linkpath: string; end: number } | null {
  const m = LINK_LINE.exec(line);
  return m ? { linkpath: m[1]!.trim(), end: m[0].length } : null;
}

/**
 * Where the `@` being typed before `ch` is, if it opens the assistant: at the start, after a space, or right after
 * the link of a `- [[Task]]` line (a click on the line puts the cursor there, the chips hiding that no space is).
 * Null otherwise (an e-mail address…).
 */
export function typedAt(line: string, ch: number): number | null {
  const at = line.lastIndexOf("@", ch - 1);
  if (at < 0) return null;
  return at === 0 || /\s/.test(line[at - 1]!) || at === parseLinkLine(line)?.end ? at : null;
}

/**
 * `@` tokens and `#tags` written after the link of a `- [[Task]]` line (to change that task), and the line without
 * them. `tags` holds the `#tags` (the `@tag` ones are in `found`).
 */
export function linkLineEdit(
  line: string,
  today: { year: number; month: number; day: number },
): { linkpath: string; rest: string; found: WhenToken | null; tags: string[] } | null {
  const link = parseLinkLine(line);
  if (!link) return null;
  const tail = line.slice(link.end);
  const found = findWhen(tail, today);
  const tagged = findTags(tail);
  if (!found && !tagged.tags.length) return null;
  return { linkpath: link.linkpath, rest: line.slice(0, link.end) + cutSpans(tail, [...(found?.spans ?? []), ...tagged.spans]), found, tags: tagged.tags };
}

/** `text` without these spans, each with the space before it. */
export function cutSpans(text: string, spans: { start: number; end: number }[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    const start = s.start > 0 && /\s/.test(out[s.start - 1]!) ? s.start - 1 : s.start;
    out = out.slice(0, start) + out.slice(s.end);
  }
  return out.trimEnd();
}

/**
 * Whether a task line's text asks to be a task (spec §5.2): an `@` with dates (`@ven 14h`, `@chaque lundi`…) or a
 * lone `@` (no date). Converted as soon as the cursor leaves the line; other `- [ ]` lines stay small steps.
 */
export function hasTaskMarker(text: string, today: { year: number; month: number; day: number }): boolean {
  return findWhen(text, today) !== null;
}

export interface PlannedTask {
  title: string;
  due: string | null;
  /** RRULE value. */
  repeat: string | null;
  /** Time to block for it: events linked to the task once it has its reminder. */
  blocks: Block[];
  /** Its tags, written `@tag famille` or `#famille` on the line. */
  tags: string[];
  /** Parent task note path, when the line is written in a task note. */
  parent: string | null;
  /** The original text, kept as the note's first line when it held links. */
  body: string;
}

export interface PlanContext {
  /** The note the line is written in. */
  sourcePath: string;
  vault: Pick<VaultPort, "getNote">;
  today: { year: number; month: number; day: number };
}

/** What a task line turns into (spec §5.2). Null if nothing is left for a title. */
export function planTask(text: string, ctx: PlanContext): PlannedTask | null {
  const marker = findWhen(text, ctx.today);
  // The `@` words and the `#tags` leave the title; both kinds of tag go to the task.
  const tagged = findTags(text);
  let rest = cutSpans(text, [...(marker?.spans ?? []), ...tagged.spans]);

  // Links keep their display text; the line is kept in the note so none is lost.
  let links = false;
  rest = rest.replace(LINK, (whole, bang: string, linkpath: string, _sub: string | undefined, alias: string | undefined) => {
    links = true;
    return bang ? "" : (alias ?? linkpath.split("/").pop()!);
  });
  const words = rest.replace(/\s+/g, " ").trim();
  if (!words) return null;

  const source = ctx.vault.getNote(ctx.sourcePath);
  return {
    title: sanitizeTitle(words),
    due: marker?.when.due ?? null,
    repeat: marker?.when.repeat ?? null,
    blocks: marker?.when.blocks ?? [],
    tags: tagsOf([...(marker?.when.tags ?? []), ...tagged.tags]),
    parent: isTaskNote(source?.frontmatter ?? null) ? ctx.sourcePath : null,
    body: links ? text : "",
  };
}

/** Frontmatter of the new task note; `link(path)` gives the `[[…]]` text for a note, from the new note. */
export function plannedFrontmatter(plan: PlannedTask, link: (path: string) => string): Record<string, unknown> {
  const fm: Record<string, unknown> = { [PROP.type]: NOTE_TYPE.task, [PROP.done]: false };
  if (plan.due) fm[PROP.due] = plan.due;
  if (plan.repeat) fm[PROP.repeat] = repeatToNote(plan.repeat);
  if (plan.tags.length) fm[PROP.tags] = plan.tags;
  if (plan.parent) fm[PROP.parent] = `[[${link(plan.parent)}]]`;
  return fm;
}
