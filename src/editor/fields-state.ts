import { EditorSelection, Facet, MapMode, StateEffect, StateField, type EditorState, type TransactionSpec } from "@codemirror/state";
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
}

export const fieldConfig = Facet.define<FieldConfig, FieldConfig>({
  combine: (values) => values[0] ?? { today: () => wallClock(new Date(), localZone()), lang: () => "en", knownTags: () => [] },
});

/** What a chip of a task already made stands for: one of its fields, or one of its tags. */
export type ChipKey = "priority" | "due" | "repeat" | `tag:${string}`;

/** The field being typed: its `@`, and the chip it was opened from (it takes that one's place). */
export interface OpenField {
  at: number;
  replaces?: ChipKey;
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

/** Opens a chip's field at the end of the line holding `pos`, in the chip's place, its value selected: typing replaces it. */
export function openChipField(state: EditorState, pos: number, key: ChipKey, text: { word: string; value: string }): TransactionSpec {
  const line = state.doc.lineAt(pos);
  const lead = /\s$/.test(line.text) ? "" : " ";
  const at = line.to + lead.length;
  const from = at + text.word.length;
  return {
    changes: { from: line.to, insert: lead + text.word + text.value },
    selection: EditorSelection.range(from, from + text.value.length),
    effects: openFieldEffect.of({ at, replaces: key }),
    userEvent: "input",
  };
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
 * a task's line with nothing typed after the link (the cursor after its chips), the same with its chips, from the
 * last one.
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
  const line = state.doc.lineAt(sel.head);
  const before = blocks.find((b) => b.to <= sel.head && !state.doc.sliceString(b.to, sel.head).trim());
  if (before) {
    target.dispatch({ selection: EditorSelection.range(before.to, before.from) });
    return true;
  }
  const link = parseLinkLine(line.text);
  if (!chips || !link || sel.head !== line.to || line.text.slice(link.end).trim()) return false;
  const picked = state.field(chipSelection, false);
  if (picked && picked.line === line.from) {
    chips.remove(line.text, picked.key);
    target.dispatch({ effects: [selectChipEffect.of(null), removeChipEffect.of({ line: line.from, key: picked.key })] });
    return true;
  }
  const removed = removedOn(state, line.from);
  const keys = chips.keys(line.text).filter((k) => !removed.includes(k));
  if (!keys.length) return false;
  target.dispatch({ effects: selectChipEffect.of({ line: line.from, key: keys[keys.length - 1]! }) });
  return true;
}

/** Delete just before a block: the same, forwards. */
export function deleteBlock(target: Target): boolean {
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
  if (!after) return false;
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
