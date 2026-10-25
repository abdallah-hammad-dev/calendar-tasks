/**
 * A task's tags (spec §4.2): Obsidian's own, in the note's `tags` property (without "#"), the one way to group
 * tasks (2026-10-25: projects were dropped, the user found them odd). Synced as the reminder's `CATEGORIES`.
 */

/** Obsidian's tag rule: letters, digits, "_", "-", "/" (nesting), and not only digits. */
const TAG = /^[\p{L}\p{N}_\-/]+$/u;

export function isTag(s: string): boolean {
  return TAG.test(s) && /\D/.test(s);
}

/** Same tag, whatever the case (Obsidian matches tags that way). */
export const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The `tags` property: a list or a string ("famille, urgent"), with or without "#"; what isn't a tag is left out. */
export function tagsOf(v: unknown): string[] {
  const raw = Array.isArray(v) ? (v as unknown[]) : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const tag = r.trim().replace(/^#+/, "");
    if (isTag(tag) && !out.some((t) => sameTag(t, tag))) out.push(tag);
  }
  return out;
}

/** `#tags` in a line (after a space or at its start), with where each is. */
export function findTags(text: string): { tags: string[]; spans: { start: number; end: number }[] } {
  const tags: string[] = [];
  const spans: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu)) {
    const tag = m[2]!;
    if (!isTag(tag)) continue;
    const start = m.index + m[1]!.length;
    spans.push({ start, end: start + 1 + tag.length });
    if (!tags.some((t) => sameTag(t, tag))) tags.push(tag);
  }
  return { tags, spans };
}

/** A reminder's category as a tag ("Work stuff" → "Work-stuff"); null when it can't be one ("2026"). */
export function tagOfCategory(category: string): string | null {
  const tag = category.trim().replace(/^#+/, "").replace(/\s+/g, "-");
  return isTag(tag) ? tag : null;
}

/** The note's tags from the reminder's categories. */
export function tagsFromCategories(categories: string[]): string[] {
  return tagsOf(categories.flatMap((c) => tagOfCategory(c) ?? []));
}

/**
 * The reminder's categories for the note's tags: a category already there for a tag keeps its spelling ("Work
 * stuff" for #Work-stuff), one that can't be a tag stays, the others go; new tags are added.
 */
export function categoriesFor(tags: string[], current: string[]): string[] {
  const out = current.filter((c) => {
    const tag = tagOfCategory(c);
    return !tag || tags.some((t) => sameTag(t, tag));
  });
  for (const t of tags) if (!out.some((c) => sameTag(tagOfCategory(c) ?? "", t))) out.push(t);
  return out;
}

/** The `tags` property with these added, the new ones last (those there kept as written); null if it has them all. */
export function withTags(value: unknown, add: string[]): unknown[] | null {
  const have = tagsOf(value);
  const missing = tagsOf(add).filter((tag) => !have.some((h) => sameTag(h, tag)));
  if (!missing.length) return null;
  return [...(Array.isArray(value) ? (value as unknown[]) : have), ...missing];
}

/** Same tags, in any order and case. */
export function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => sameTag(x, y)));
}
