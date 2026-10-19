import { NOTE_TYPE, PROP } from "../constants";
import { isTaskNote, linkpathOf, sanitizeTitle } from "../tasks/notes";
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

/** `@` tokens written after the link of a `- [[Task]]` line (to change that task), and the line without them. */
export function linkLineEdit(line: string, today: { year: number; month: number; day: number }): { linkpath: string; rest: string; found: WhenToken } | null {
  const link = parseLinkLine(line);
  if (!link) return null;
  const tail = line.slice(link.end);
  const found = findWhen(tail, today);
  return found ? { linkpath: link.linkpath, rest: line.slice(0, link.end) + cutSpans(tail, found.spans), found } : null;
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
  /** Project note path. */
  project: string | null;
  /** Parent task note path, when the line is written in a task note. */
  parent: string | null;
  /** The original text, kept as the note's first line when it held links other than the project. */
  body: string;
}

export interface PlanContext {
  /** The note the line is written in. */
  sourcePath: string;
  vault: Pick<VaultPort, "resolve" | "isProject" | "getNote">;
  today: { year: number; month: number; day: number };
}

/** What a task line turns into (spec §5.2). Null if nothing is left for a title. */
export function planTask(text: string, ctx: PlanContext): PlannedTask | null {
  const marker = findWhen(text, ctx.today);
  let rest = text;
  for (const span of [...(marker?.spans ?? [])].reverse()) rest = rest.slice(0, span.start) + rest.slice(span.end);

  // 1. A link to a project note on the line is the project; other links keep their display text.
  let project: string | null = null;
  let otherLinks = false;
  rest = rest.replace(LINK, (whole, bang: string, linkpath: string, _sub: string | undefined, alias: string | undefined) => {
    if (bang) {
      otherLinks = true;
      return "";
    }
    const target = ctx.vault.resolve(linkpath.trim(), ctx.sourcePath);
    if (!project && target && ctx.vault.isProject(target.path)) {
      project = target.path;
      return "";
    }
    otherLinks = true;
    return alias ?? linkpath.split("/").pop()!;
  });
  const words = rest.replace(/\s+/g, " ").trim();
  if (!words) return null;

  const source = ctx.vault.getNote(ctx.sourcePath);
  const sourceFm = source?.frontmatter ?? null;
  const parent = isTaskNote(sourceFm) ? ctx.sourcePath : null;
  if (!project) {
    if (ctx.vault.isProject(ctx.sourcePath)) project = ctx.sourcePath; // 2. written in a project note
    else {
      // 3. the note's own project (a meeting note, or the parent task for a sub-task)
      const link = linkpathOf(sourceFm?.[PROP.project]);
      project = (link && ctx.vault.resolve(link, ctx.sourcePath)?.path) || null;
    }
  }
  return {
    title: sanitizeTitle(words),
    due: marker?.when.due ?? null,
    repeat: marker?.when.repeat ?? null,
    blocks: marker?.when.blocks ?? [],
    project,
    parent,
    body: otherLinks ? text : "",
  };
}

/** Frontmatter of the new task note; `link(path)` gives the `[[…]]` text for a note, from the new note. */
export function plannedFrontmatter(plan: PlannedTask, link: (path: string) => string): Record<string, unknown> {
  const fm: Record<string, unknown> = { [PROP.type]: NOTE_TYPE.task, [PROP.done]: false };
  if (plan.due) fm[PROP.due] = plan.due;
  if (plan.repeat) fm[PROP.repeat] = repeatToNote(plan.repeat);
  if (plan.project) fm[PROP.project] = `[[${link(plan.project)}]]`;
  if (plan.parent) fm[PROP.parent] = `[[${link(plan.parent)}]]`;
  return fm;
}
