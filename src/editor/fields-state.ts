import { EditorSelection, Facet, MapMode, StateEffect, StateField, type EditorState, type Line, type Transaction, type TransactionSpec } from "@codemirror/state";
import { localZone, wallClock } from "../ical/time";
import { parseLinkLine, parseTaskLine, typedAt } from "./convert";
import type { Ymd } from "./date-token";
import type { Priority } from "../constants";
import { dateText, featureWord, lineTokens, normalizeRule, priorityWord, repeatLabel, suggestAt, type Feature, type LineToken } from "./when";

/**
 * Fields on a task line (spec §5.2, 2026-10-26, asked: "ça te fait des champs, visibles sur la ligne, une fois
 * remplis ils se transforment en bloc"). The text stays the `@` grammar (`@deadline ven`, `@tag famille`); what
 * it shows is the field being typed (the `@` the assistant reads) and a block for every other `@` with a value.
 * Backspace selects a block, then deletes it. This file is the state, without the DOM (`fields-view.ts` draws).
 */

export interface FieldConfig {
  today(): Ymd;
  lang(): "fr" | "en";
  knownTags(): string[];
  /**
   * The value of this chip of the task linked at the start of the line, as its field says it (`text` null: the `@`
   * can't say it); null when the task has none.
   */
  chipValue?(state: EditorState, lineText: string, key: ChipKey): { text: string | null } | null;
}

export const fieldConfig = Facet.define<FieldConfig, FieldConfig>({
  combine: (values) => values[0] ?? { today: () => wallClock(new Date(), localZone()), lang: () => "en", knownTags: () => [] },
});

/** What a chip of a task already made stands for: one of its fields, or one of its tags. */
export type ChipKey = "priority" | "due" | "repeat" | `tag:${string}`;

/**
 * The field being typed: its `@`, and the chip it stands in place of: the one clicked, or (`auto`) the one whose
 * field is typed after a task's link. `was`: that chip's value, shown faint while nothing is typed.
 */
export interface OpenField {
  at: number;
  replaces?: ChipKey;
  was?: string;
  auto?: boolean;
}

export const openFieldEffect = StateEffect.define<OpenField>({ map: (f, m) => ({ ...f, at: m.mapPos(f.at, 1) }) });
export const closeFieldEffect = StateEffect.define<null>();

/** Where `@` tokens are read on the line holding `pos`: all of a `- [ ]` line, after the link of a `- [[Task]]` one. */
export function fieldLine(state: EditorState, pos: number): { from: number; base: number; text: string; link: string | null } | null {
  const line = state.doc.lineAt(pos);
  if (parseTaskLine(line.text)) return { from: line.from, base: line.from, text: line.text, link: null };
  const link = parseLinkLine(line.text);
  return link ? { from: line.from, base: line.from + link.end, text: line.text.slice(link.end), link: link.linkpath } : null;
}

/** A line's `@` tokens, at their places in the document. */
export function tokensAt(state: EditorState, pos: number): (LineToken & { link: string | null })[] {
  const fl = fieldLine(state, pos);
  if (!fl) return [];
  const today = state.facet(fieldConfig).today();
  return lineTokens(fl.text, today).map((t) => ({
    ...t,
    start: t.start + fl.base,
    end: t.end + fl.base,
    valueStart: t.valueStart + fl.base,
    link: fl.link,
  }));
}

/**
 * How far the field at `at` goes: its words, and further while the assistant still reads what is typed up to the
 * cursor ("@deadline ve" on the way to "ven"). Null if there is no field there any more.
 */
export function fieldExtent(state: EditorState, at: number): { from: number; to: number; token: (LineToken & { link: string | null }) | null } | null {
  const fl = fieldLine(state, at);
  if (!fl || at < fl.base || state.doc.sliceString(at, at + 1) !== "@") return null;
  const col = at - fl.base;
  if (col > 0 && !/\s/.test(fl.text[col - 1]!)) return null;
  const token = tokensAt(state, at).find((t) => t.start === at) ?? null;
  let to = token ? token.end : at + 1;
  const head = state.selection.main.head;
  if (head > to && head <= fl.base + fl.text.length) {
    const cfg = state.facet(fieldConfig);
    if (suggestAt(state.doc.sliceString(at + 1, head), cfg.today(), cfg.lang(), undefined, cfg.knownTags())) to = head;
  }
  return { from: at, to, token };
}

/** The `@` the cursor has just typed or is typing in, if it opens a field. */
function typedField(state: EditorState): number | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const col = typedAt(line.text, sel.head - line.from);
  return col === null ? null : line.from + col;
}

/** The fields a task has one of: typed after its link, they stand for the chip it has. */
const SINGLE: Partial<Record<Feature, ChipKey>> = { priority: "priority", due: "due", repeat: "repeat" };

/** The chip of the task linked on the line that the field at `ext` is typed for, if the task has that value. */
function chipTyped(state: EditorState, ext: NonNullable<ReturnType<typeof fieldExtent>>): { key: ChipKey; was?: string } | null {
  const key = ext.token?.feature ? SINGLE[ext.token.feature] : undefined;
  if (!key || !fieldLine(state, ext.from)?.link) return null;
  const value = state.facet(fieldConfig).chipValue?.(state, state.doc.lineAt(ext.from).text, key);
  return value ? { key, ...(value.text ? { was: value.text } : {}) } : null;
}

/** The field open, if any: opened by typing an `@` (or in one), or by a click on a block or chip; closed once left. */
export const openField = StateField.define<OpenField | null>({
  create: () => null,
  update(value, tr) {
    let field = value;
    if (field) {
      const at = tr.changes.mapPos(field.at, 1, MapMode.TrackAfter);
      field = at === null ? null : { ...field, at };
    }
    for (const e of tr.effects) {
      if (e.is(openFieldEffect)) field = e.value;
      if (e.is(closeFieldEffect)) return null;
    }
    // Typing in an `@`, or a cursor put right after one (the assistant's "something else" writes " @"), opens it.
    const typed = tr.docChanged || tr.selection ? typedField(tr.state) : null;
    if (typed !== null && typed !== field?.at && ((tr.docChanged && tr.isUserEvent("input")) || tr.state.selection.main.head === typed + 1)) {
      field = { at: typed };
    }
    if (!field) return null;
    const ext = fieldExtent(tr.state, field.at);
    const sel = tr.state.selection.main;
    if (!ext || sel.from <= ext.from || sel.to > ext.to) return null;
    // `@priorité` typed after the link of a task that has one opens that one, as a click on its chip would
    // (2026-10-27, the user: "pk ça ouvre pas celui déjà existant").
    if (field.auto || (!field.replaces && !field.was)) {
      const chip = chipTyped(tr.state, ext);
      if (chip?.key !== field.replaces || chip?.was !== field.was) field = chip ? { at: field.at, replaces: chip.key, was: chip.was, auto: true } : { at: field.at };
    }
    return field;
  },
});

/** The blocks of the line holding `pos`: every `@` with a value but the field being typed. */
export function blocksAt(state: EditorState, pos: number): { from: number; to: number; token: LineToken }[] {
  const open = state.field(openField, false)?.at;
  return tokensAt(state, pos)
    .filter((t) => t.complete && t.start !== open)
    .map((t) => ({ from: t.start, to: t.end, token: t }));
}

/**
 * What a chip's field starts with (`@deadline 30/10/2026 14h`, `@répéter chaque lundi`, `@tag famille`,
 * `@priorité haute`), or null when the `@` can't say the task's value the same way (then the form edits it).
 */
export function chipFieldText(
  task: { due: string | null; repeat: string | null; priority?: Priority | null },
  key: ChipKey,
  lang: "fr" | "en",
  today: Ymd,
): { word: string; value: string } | null {
  const feature = key.startsWith("tag:") ? "tag" : (key as Exclude<Feature, "block" | "tag">);
  const value =
    key === "due" ? task.due && dateText(task.due)
    : key === "repeat" ? task.repeat && repeatLabel(task.repeat, lang)
    : key === "priority" ? task.priority && priorityWord(task.priority, lang)
    : key.slice(4);
  if (!value) return null;
  const word = `@${featureWord(feature, lang)} `;
  const back = lineTokens(word + value, today)[0];
  if (!back?.complete || back.end !== word.length + value.length) return null;
  const w = back.when;
  const same =
    key === "due" ? w.due === task.due
    : key === "repeat" ? !!w.repeat && normalizeRule(w.repeat) === normalizeRule(task.repeat ?? "")
    : key === "priority" ? w.priority === task.priority
    : w.tags?.[0] === value;
  return same ? { word, value } : null;
}

/**
 * Opens a chip's field at the end of the line holding `pos`, in the chip's place: its keyword, its value shown faint
 * (`was`) for the assistant's list to offer every choice under it (2026-10-27, the user: a list at once rather than
 * the value selected). Left without a new value, the chip stays as it was.
 */
export function openChipField(state: EditorState, pos: number, key: ChipKey, text: { word: string; value: string }): TransactionSpec {
  const line = state.doc.lineAt(pos);
  const lead = /\s$/.test(line.text) ? "" : " ";
  const at = line.to + lead.length;
  return {
    changes: { from: line.to, insert: lead + text.word },
    selection: EditorSelection.cursor(at + text.word.length),
    effects: openFieldEffect.of({ at, replaces: key, was: text.value }),
    userEvent: "input",
  };
}

/**
 * Opens a block's field (a click on it), as a chip's opens: its keyword (written in for a shortcut like `@demain`),
 * its value shown faint (`was`), the assistant's list under it. Left without a new value, the value comes back
 * (`restoreField`).
 */
export function openBlockField(state: EditorState, token: LineToken): TransactionSpec | null {
  if (!token.feature) return null;
  const spaced = state.doc.sliceString(token.valueStart, token.valueStart + 1) === " ";
  const from = spaced ? token.valueStart + 1 : token.valueStart;
  const was = state.doc.sliceString(from, token.end);
  // `@demain` has no keyword: the field says what it is for (`@deadline `).
  const keyword = token.valueStart === token.start + 1 ? `${featureWord(token.feature, state.facet(fieldConfig).lang())} ` : "";
  const at = token.start;
  return {
    changes: { from, to: token.end, insert: keyword },
    selection: EditorSelection.cursor(from + keyword.length),
    effects: openFieldEffect.of({ at, was }),
    userEvent: "input",
  };
}

/**
 * A field that stood for a value (a chip's or a block's, `was`; any field after a task's link) closing without a
 * new one: left as it opened, or half typed (`@priorité h`). A chip's goes from the line (its chip is drawn again),
 * a block's gets its value back. Nothing when it got a value or its `@` was deleted. Made in the same transaction,
 * so a line left at once (and converted) has it right.
 */
export function restoreField(tr: Transaction): TransactionSpec | null {
  const was = tr.startState.field(openField, false);
  const onLink = was && !!fieldLine(tr.startState, was.at)?.link;
  if (!was || (!was.was && !onLink)) return null;
  const at = tr.changes.mapPos(was.at, 1, MapMode.TrackDel);
  if (at === null || tr.state.field(openField, false)?.at === at) return null;
  const token = tokensAt(tr.state, at).find((t) => t.start === at);
  if (!token || token.complete || tr.state.doc.sliceString(at, at + 1) !== "@") return null;
  // What the field read: its keyword, and what was typed after it while the assistant still read it.
  const ext = fieldExtent(tr.startState, was.at);
  const read = Math.max(token.end, ext ? tr.changes.mapPos(ext.to, 1) : token.end);
  const line = tr.state.doc.lineAt(at);
  if (onLink) {
    const to = tr.state.doc.sliceString(read, line.to).trim() ? read : line.to;
    return { changes: { from: at, to }, sequential: true };
  }
  const spaced = tr.state.doc.sliceString(token.valueStart, token.valueStart + 1) === " ";
  const from = spaced ? token.valueStart + 1 : token.valueStart;
  const to = Math.max(from, read);
  const next = tr.state.doc.sliceString(to, to + 1);
  return { changes: { from: spaced ? from : token.valueStart, to, insert: (spaced ? "" : " ") + was.was + (next && !/\s/.test(next) ? " " : "") }, sequential: true };
}

/** A chip of a task already made, selected by a first Backspace (the second takes it off the task). */
export const selectChipEffect = StateEffect.define<{ line: number; key: ChipKey } | null>();

export const chipSelection = StateField.define<{ line: number; key: ChipKey } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(selectChipEffect)) return e.value;
    return tr.docChanged || tr.selection ? null : value;
  },
});

/** A chip just taken off (by Backspace): not drawn while its task note catches up. */
export const removeChipEffect = StateEffect.define<{ line: number; key: ChipKey }>();
/** The task notes were read again (`refreshTaskDecorations`): what was taken off is off the model too. */
export const clearRemovedEffect = StateEffect.define<null>();

export const removedChips = StateField.define<{ line: number; key: ChipKey }[]>({
  create: () => [],
  update(value, tr) {
    let out = tr.docChanged ? value.map((r) => ({ ...r, line: tr.state.doc.lineAt(tr.changes.mapPos(r.line)).from })) : value;
    for (const e of tr.effects) {
      if (e.is(removeChipEffect)) out = [...out, e.value];
      if (e.is(clearRemovedEffect)) out = [];
    }
    return out;
  },
});

/** The chips taken off this line and not yet off the model. */
export function removedOn(state: EditorState, line: number): ChipKey[] {
  return (state.field(removedChips, false) ?? []).filter((r) => r.line === line).map((r) => r.key);
}

/**
 * Where the cursor stands among the chips of a task already made, at its line's end: after `gap` of those drawn
 * (2026-10-27, asked: to take the deadline off with Backspace, not only the last chip). None: after them all. Kept
 * while what's typed there goes on (a field stands in the gap), dropped once the cursor moves or the field closes.
 */
export const setChipGapEffect = StateEffect.define<{ line: number; gap: number } | null>();

export const chipGap = StateField.define<{ line: number; gap: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChipGapEffect)) return e.value;
    if (!value) return null;
    // A click, or the cursor moved (not the editor reading back the same selection).
    if (!tr.docChanged) return tr.isUserEvent("select.pointer") || (tr.selection && !tr.selection.eq(tr.startState.selection)) ? null : value;
    if (tr.startState.field(openField, false) && !tr.state.field(openField, false)) return null;
    const line = tr.state.doc.lineAt(tr.changes.mapPos(value.line));
    return tr.state.selection.main.head >= line.from && tr.state.selection.main.head <= line.to ? { ...value, line: line.from } : null;
  },
});

/** The gap the cursor is in on this line, out of `count` chips (all of them when none was chosen). */
export function gapOn(state: EditorState, line: number, count: number): number {
  const g = state.field(chipGap, false);
  return g && g.line === line ? Math.min(g.gap, count) : count;
}

/** The line of a task already made whose end the cursor is at, with nothing typed after its link. */
function chipLine(state: EditorState): { line: Line; linkEnd: number } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const link = parseLinkLine(line.text);
  if (!link || line.text.slice(link.end).trim()) return null;
  return { line, linkEnd: line.from + link.end };
}

/** The chips of that line the cursor moves among: those drawn. */
function shownKeys(state: EditorState, line: Line, chips: ChipActions): ChipKey[] {
  const removed = removedOn(state, line.from);
  return chips.keys(line.text).filter((k) => !removed.includes(k));
}

/**
 * ← and → at the end of a task's line move the cursor over its chips one by one; → at the end of its link goes to
 * before the first. Past the first or the last, the editor's own move.
 */
export function moveAmongChips(target: Target, chips: ChipActions | undefined, dir: -1 | 1): boolean {
  const { state } = target;
  const at = chips && chipLine(state);
  if (!at) return false;
  const { line, linkEnd } = at;
  const keys = shownKeys(state, line, chips);
  const head = state.selection.main.head;
  if (!keys.length || line.to === linkEnd) return false;
  if (dir === 1 && head === linkEnd) {
    target.dispatch({ selection: EditorSelection.cursor(line.to), effects: [setChipGapEffect.of({ line: line.from, gap: 0 }), selectChipEffect.of(null)] });
    return true;
  }
  if (head !== line.to) return false;
  const next = gapOn(state, line.from, keys.length) + dir;
  if (next < 0 || next > keys.length) return false;
  target.dispatch({ effects: [setChipGapEffect.of(next === keys.length ? null : { line: line.from, gap: next }), selectChipEffect.of(null)] });
  return true;
}

export interface Target {
  state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

export interface ChipActions {
  /** The chips that can be taken off the task linked at the start of this line, in their order on screen. */
  keys(lineText: string): ChipKey[];
  /** Takes one off. */
  remove(lineText: string, key: ChipKey): void;
}

/**
 * Backspace next to a block: the first selects it, the second deletes it (with the space before it). At the end of
 * a task's line with nothing typed after the link, the same with the chip before the cursor (`chipGap`).
 */
export function backspaceBlock(target: Target, chips?: ChipActions): boolean {
  const { state } = target;
  const sel = state.selection.main;
  const blocks = blocksAt(state, sel.head);
  const selected = blocks.find((b) => b.from === sel.from && b.to === sel.to);
  if (selected) {
    const from = selected.from > 0 && state.doc.sliceString(selected.from - 1, selected.from) === " " ? selected.from - 1 : selected.from;
    target.dispatch({ changes: { from, to: selected.to }, selection: EditorSelection.cursor(from), userEvent: "delete.backward" });
    return true;
  }
  if (!sel.empty) return false;
  const before = blocks.find((b) => b.to <= sel.head && !state.doc.sliceString(b.to, sel.head).trim());
  if (before) {
    target.dispatch({ selection: EditorSelection.range(before.to, before.from) });
    return true;
  }
  return chipKey(target, chips, -1);
}

/** Backspace (`dir` -1) or Delete (1) on the chip before or after the cursor: selects it, then takes it off. */
function chipKey(target: Target, chips: ChipActions | undefined, dir: -1 | 1): boolean {
  const { state } = target;
  const at = chips && chipLine(state);
  if (!at || state.selection.main.head !== at.line.to) return false;
  const { line } = at;
  const keys = shownKeys(state, line, chips);
  if (!keys.length) return false;
  const gap = gapOn(state, line.from, keys.length);
  const picked = state.field(chipSelection, false);
  if (picked && picked.line === line.from) {
    chips.remove(line.text, picked.key);
    // The cursor stays where it was among those left.
    const left = gap - (keys.indexOf(picked.key) < gap ? 1 : 0);
    const effects = [selectChipEffect.of(null), removeChipEffect.of({ line: line.from, key: picked.key })];
    target.dispatch({ effects: [...effects, setChipGapEffect.of(left >= keys.length - 1 ? null : { line: line.from, gap: left })] });
    return true;
  }
  const key = keys[dir === -1 ? gap - 1 : gap];
  // Against the link, nothing to take off: not the link's text either.
  if (!key) return dir === -1;
  target.dispatch({ effects: selectChipEffect.of({ line: line.from, key }) });
  return true;
}

/** Delete just before a block, or a chip: the same, forwards. */
export function deleteBlock(target: Target, chips?: ChipActions): boolean {
  const { state } = target;
  const sel = state.selection.main;
  const blocks = blocksAt(state, sel.head);
  const selected = blocks.find((b) => b.from === sel.from && b.to === sel.to);
  if (selected) {
    const to = state.doc.sliceString(selected.to, selected.to + 1) === " " ? selected.to + 1 : selected.to;
    target.dispatch({ changes: { from: selected.from, to }, selection: EditorSelection.cursor(selected.from), userEvent: "delete.forward" });
    return true;
  }
  if (!sel.empty) return false;
  const after = blocks.find((b) => b.from >= sel.head && !state.doc.sliceString(sel.head, b.from).trim());
  if (!after) return chipKey(target, chips, 1);
  target.dispatch({ selection: EditorSelection.range(after.from, after.to) });
  return true;
}

/**
 * Text typed against a block gets a space between: typed right after `@tag famille` it would become part of the
 * tag, typed right before its `@` it would make it an `@` inside a word.
 */
export function padTyping(state: EditorState, from: number, to: number, text: string): string {
  if (from !== to || !text || (/^\s/.test(text) && /\s$/.test(text))) return text;
  const blocks = blocksAt(state, from);
  let out = text;
  if (!/^\s/.test(out) && blocks.some((b) => b.to === from)) out = ` ${out}`;
  if (!/\s$/.test(out) && blocks.some((b) => b.from === from)) out = `${out} `;
  return out;
}
