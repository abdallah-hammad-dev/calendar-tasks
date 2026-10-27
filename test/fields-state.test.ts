import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  backspaceBlock,
  blocksAt,
  chipFieldText,
  chipGap,
  chipSelection,
  closeFieldEffect,
  deleteBlock,
  fieldConfig,
  fieldExtent,
  gapOn,
  moveAmongChips,
  openBlockField,
  openField,
  openChipField,
  openFieldEffect,
  padTyping,
  removedChips,
  removedOn,
  restoreField,
  tokensAt,
  type ChipKey,
} from "../src/editor/fields-state";

const TODAY = { year: 2026, month: 10, day: 15 }; // a Thursday
const config = fieldConfig.of({ today: () => TODAY, lang: () => "fr", knownTags: () => ["famille", "urgent"] });

const make = (doc: string, cursor = doc.length) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [config, openField, chipSelection, removedChips, chipGap, EditorState.transactionFilter.of((tr) => { const back = restoreField(tr); return back ? [tr, back] : tr; })],
  });

/** Types `text` at the cursor, one key at a time, as a person does. */
function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) {
    const at = s.selection.main.head;
    s = s.update({ changes: { from: at, insert: ch }, selection: EditorSelection.cursor(at + 1), userEvent: "input.type" }).state;
  }
  return s;
}

const move = (state: EditorState, pos: number) => state.update({ selection: EditorSelection.cursor(pos) }).state;
const open = (state: EditorState) => state.field(openField)?.at ?? null;
const blocks = (state: EditorState) => blocksAt(state, state.selection.main.head).map((b) => state.doc.sliceString(b.from, b.to));

/** Runs a command like the editor would, and returns the state after it. */
function run(state: EditorState, command: (t: { state: EditorState; dispatch(spec: TransactionSpec): void }) => boolean) {
  let s = state;
  const handled = command({ state: s, dispatch: (spec) => (s = s.update(spec).state) });
  return { handled, state: s };
}

describe("open field", () => {
  it("opens on the @ typed, stays while the assistant reads, closes once the title goes on", () => {
    let s = type(make("- [ ] Appeler mamie "), "@");
    expect(open(s)).toBe(20);
    s = type(s, "deadline dem");
    expect(open(s)).toBe(20);
    expect(blocks(s)).toEqual([]); // being typed: a field, not a block
    s = type(s, "ain ");
    expect(open(s)).toBe(20); // "demain 14h" could still come
    s = type(s, "pour");
    expect(open(s)).toBeNull();
    expect(blocks(s)).toEqual(["@deadline demain"]);
  });

  it("closes when the cursor leaves it, and doesn't come back by itself", () => {
    let s = type(make("- [ ] Appeler "), "@tag famille");
    expect(open(s)).toBe(14);
    s = move(s, 8);
    expect(open(s)).toBeNull();
    s = move(s, s.doc.length);
    expect(open(s)).toBeNull(); // back after a block: still a block
    expect(blocks(s)).toEqual(["@tag famille"]);
  });

  it("opens after a task's link, glued or not, and never on other lines", () => {
    expect(open(type(make("- [[Rapport]] "), "@"))).toBe(14);
    expect(open(type(make("- [[Rapport]]"), "@"))).toBe(13);
    expect(open(type(make("Une phrase "), "@"))).toBeNull();
    expect(open(type(make("- [ ] écrire à paul"), "@"))).toBeNull(); // inside a word
  });

  it("opens where the assistant writes ' @' (no typing), and on a click's selection of a value", () => {
    let s = make("- [ ] Rapport @demain");
    s = s.update({ changes: { from: s.doc.length, insert: " @" } }).state;
    s = move(s, s.doc.length);
    expect(open(s)).toBe(22);
    const t = make("- [ ] Rapport @tag famille", 0);
    const opened = t.update({ selection: EditorSelection.range(19, 26), effects: openFieldEffect.of({ at: 14 }) }).state;
    expect(open(opened)).toBe(14);
    expect(blocks(opened)).toEqual([]);
  });

  it("reaches as far as the assistant reads", () => {
    const s = type(make("- [ ] Rapport "), "@deadline ve");
    expect(fieldExtent(s, 14)).toMatchObject({ from: 14, to: s.doc.length });
  });
});

describe("Backspace next to a block", () => {
  it("selects it first, then deletes it with the space before it", () => {
    let s = make("- [ ] Appeler @demain @tag famille");
    let r = run(s, backspaceBlock);
    expect(r.handled).toBe(true);
    expect(r.state.doc.sliceString(r.state.selection.main.from, r.state.selection.main.to)).toBe("@tag famille");
    r = run(r.state, backspaceBlock);
    expect(r.state.doc.toString()).toBe("- [ ] Appeler @demain");
    s = r.state;
    r = run(s, backspaceBlock); // the next one, the same way
    r = run(r.state, backspaceBlock);
    expect(r.state.doc.toString()).toBe("- [ ] Appeler");
  });

  it("skips spaces typed after the block, and leaves plain text to the editor", () => {
    const r = run(make("- [ ] Appeler @demain  "), backspaceBlock);
    expect(r.state.doc.sliceString(r.state.selection.main.from, r.state.selection.main.to)).toBe("@demain");
    expect(run(make("- [ ] Appeler @demain pour"), backspaceBlock).handled).toBe(false);
    expect(run(type(make("- [ ] Appeler "), "@demain"), backspaceBlock).handled).toBe(false); // the field being typed
  });

  it("takes the chips of a task already made off one by one, from the last", () => {
    const removed: ChipKey[] = [];
    const chips = { keys: () => ["due", "tag:famille"] as ChipKey[], remove: (_line: string, key: ChipKey) => removed.push(key) };
    let r = run(make("- [[Rapport]]"), (t) => backspaceBlock(t, chips));
    expect(r.handled).toBe(true);
    expect(r.state.field(chipSelection)).toEqual({ line: 0, key: "tag:famille" });
    r = run(r.state, (t) => backspaceBlock(t, chips));
    expect(removed).toEqual(["tag:famille"]);
    expect(r.state.doc.toString()).toBe("- [[Rapport]]"); // the line itself is left alone
    expect(removedOn(r.state, 0)).toEqual(["tag:famille"]); // not drawn until the note is read again
    r = run(r.state, (t) => backspaceBlock(t, chips)); // the model still has it: the next one is picked
    expect(r.state.field(chipSelection)).toEqual({ line: 0, key: "due" });
    // Only from the line's end (after the chips): elsewhere Backspace is the editor's.
    expect(run(make("- [[Rapport]] ", 13), (t) => backspaceBlock(t, chips)).handled).toBe(false);
    expect(run(make("- [[Rapport]] "), (t) => backspaceBlock(t, chips)).handled).toBe(true);
    // Text after the link: Backspace is the editor's.
    const remove = vi.fn();
    expect(run(make("- [[Rapport]] ok"), (t) => backspaceBlock(t, { keys: () => ["due"], remove })).handled).toBe(false);
  });

  it("moves among the chips with ← →, and takes off the one before the cursor", () => {
    const removed: ChipKey[] = [];
    const chips = { keys: () => ["priority", "due", "tag:famille"] as ChipKey[], remove: (_line: string, key: ChipKey) => removed.push(key) };
    const left = (t: Parameters<typeof backspaceBlock>[0]) => moveAmongChips(t, chips, -1);
    const right = (t: Parameters<typeof backspaceBlock>[0]) => moveAmongChips(t, chips, 1);
    const end = make("- [[Rapport]] ");
    let r = run(end, left);
    expect(r.handled).toBe(true);
    expect(gapOn(r.state, 0, 3)).toBe(2); // between the deadline and #famille, the cursor still at the line's end
    expect(r.state.selection.main.head).toBe(14);
    r = run(r.state, (t) => backspaceBlock(t, chips));
    expect(r.state.field(chipSelection)).toEqual({ line: 0, key: "due" }); // the deadline, not the last chip
    r = run(r.state, (t) => backspaceBlock(t, chips));
    expect(removed).toEqual(["due"]);
    expect(gapOn(r.state, 0, 2)).toBe(1); // after the priority, before #famille
    r = run(r.state, (t) => deleteBlock(t, chips));
    expect(r.state.field(chipSelection)).toEqual({ line: 0, key: "tag:famille" }); // Delete: the one after
    // Past the first chip, ← is the editor's; → past the last goes back to "after them all".
    r = run(run(r.state, left).state, left);
    expect(r.handled).toBe(false);
    expect(gapOn(r.state, 0, 2)).toBe(0);
    expect(run(r.state, (t) => backspaceBlock(t, chips)).handled).toBe(true); // against the link: nothing, not its text
    r = run(run(r.state, right).state, right);
    expect(r.state.field(chipGap)).toBeNull();
    expect(run(r.state, right).handled).toBe(false);
    // → at the end of the link goes before the first chip; moving the cursor otherwise forgets the gap.
    r = run(make("- [[Rapport]] ", 13), right);
    expect([r.state.selection.main.head, gapOn(r.state, 0, 3)]).toEqual([14, 0]);
    expect(move(run(end, left).state, 13).field(chipGap)).toBeNull();
    const clicked = run(end, left).state.update({ selection: EditorSelection.cursor(14), userEvent: "select.pointer" }).state;
    expect(clicked.field(chipGap)).toBeNull(); // a click after the chips: after them all
    expect(move(run(end, left).state, 14).field(chipGap)).not.toBeNull(); // the same selection read back
    // Typing in the gap keeps it (the field stands there), until the field closes.
    const typed = type(run(end, left).state, "@prio");
    expect(gapOn(typed, 0, 3)).toBe(2);
    expect(typed.update({ effects: closeFieldEffect.of(null) }).state.field(chipGap)).toBeNull();
  });

  it("does the same forwards with Delete", () => {
    let r = run(make("- [ ] Appeler @demain pour", 14), deleteBlock);
    expect(r.state.doc.sliceString(r.state.selection.main.from, r.state.selection.main.to)).toBe("@demain");
    r = run(r.state, deleteBlock);
    expect(r.state.doc.toString()).toBe("- [ ] Appeler pour");
  });
});

describe("padTyping", () => {
  it("puts a space between a block and what's typed against it", () => {
    const s = make("- [ ] Appeler @tag famille");
    expect(padTyping(s, s.doc.length, s.doc.length, "s")).toBe(" s");
    expect(padTyping(s, 14, 14, "x")).toBe("x ");
    expect(padTyping(s, 8, 8, "x")).toBe("x");
  });
});

describe("a field that stood for a value", () => {
  it("opens a block's field with its value faint, and gives it back if none comes", () => {
    const s = make("- [ ] Appeler @deadline demain pour");
    const token = tokensAt(s, 0).find((t) => t.feature === "due")!;
    const opened = s.update(openBlockField(s, token)!).state;
    expect(opened.doc.toString()).toBe("- [ ] Appeler @deadline  pour");
    expect(opened.field(openField)).toEqual({ at: 14, was: "demain" });
    expect(opened.selection.main.head).toBe(24);
    expect(opened.update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [ ] Appeler @deadline demain pour");
    // Half typed, it goes back too; a new value stays.
    const half = type(opened, "ve");
    expect(half.update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [ ] Appeler @deadline demain pour");
    const given = move(type(opened, "ven"), 0);
    expect(given.doc.toString()).toBe("- [ ] Appeler @deadline ven pour");
    // A shortcut gets its keyword.
    const short = make("- [ ] Appeler @demain");
    const shortOpened = short.update(openBlockField(short, tokensAt(short, 0)[0]!)!).state;
    expect([shortOpened.doc.toString(), shortOpened.field(openField)?.was]).toEqual(["- [ ] Appeler @deadline ", "demain"]);
  });

  it("goes from a task's line, left as it opened or half typed", () => {
    const s = make("- [[Rapport]] ");
    const opened = s.update(openChipField(s, 3, "priority", { word: "@priorité ", value: "basse" })).state;
    expect(opened.update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [[Rapport]] ");
    expect(type(opened, "h").update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [[Rapport]] ");
    // Given a value, it stays for the task to take; deleted, nothing to do.
    expect(type(opened, "haute").update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [[Rapport]] @priorité haute");
    expect(type(s, "@deadline ").update({ effects: closeFieldEffect.of(null) }).state.doc.toString()).toBe("- [[Rapport]] ");
  });
});

describe("a chip's field", () => {
  const task = { due: "2026-10-30T14:00", repeat: "FREQ=WEEKLY;BYDAY=MO" };

  it("says the task's value the way the @ reads it back, or nothing", () => {
    expect(chipFieldText(task, "due", "fr", TODAY)).toEqual({ word: "@deadline ", value: "30/10/2026 14h" });
    expect(chipFieldText(task, "repeat", "fr", TODAY)).toEqual({ word: "@répéter ", value: "chaque lundi" });
    expect(chipFieldText(task, "tag:Été", "fr", TODAY)).toEqual({ word: "@tag ", value: "Été" });
    expect(chipFieldText({ ...task, priority: "medium" }, "priority", "fr", TODAY)).toEqual({ word: "@priorité ", value: "moyenne" });
    expect(chipFieldText({ ...task, priority: "low" }, "priority", "en", TODAY)).toEqual({ word: "@priority ", value: "low" });
    expect(chipFieldText({ due: null, repeat: "FREQ=MONTHLY;BYMONTHDAY=3" }, "repeat", "fr", TODAY)).toBeNull();
  });

  it("opens at the line's end in the chip's place, waiting for a new value", () => {
    const s = make("- [[Rapport]]", 0);
    const opened = s.update(openChipField(s, 3, "due", { word: "@deadline ", value: "30/10/2026 14h" })).state;
    expect(opened.doc.toString()).toBe("- [[Rapport]] @deadline ");
    expect(opened.selection.main.empty && opened.selection.main.head).toBe(opened.doc.length);
    expect(opened.field(openField)).toEqual({ at: 14, replaces: "due", was: "30/10/2026 14h" });
    // Typing in it keeps it the chip's field.
    expect(type(opened, "dem").field(openField)).toMatchObject({ at: 14, replaces: "due" });
  });

  it("is also the one a field typed after the link opens, when the task has that value", () => {
    const chipValue = vi.fn((_s: EditorState, _line: string, key: ChipKey) => (key === "priority" ? { text: "basse" } : key === "repeat" ? { text: null } : null));
    const withTask = fieldConfig.of({ today: () => TODAY, lang: () => "fr", knownTags: () => [], chipValue });
    const s = EditorState.create({ doc: "- [[Rapport]] ", extensions: [withTask, openField] }).update({ selection: EditorSelection.cursor(14) }).state;
    const typed = type(s, "@priorité ");
    expect(typed.field(openField)).toEqual({ at: 14, replaces: "priority", was: "basse", auto: true });
    expect(chipValue).toHaveBeenLastCalledWith(expect.anything(), "- [[Rapport]] @priorité ", "priority");
    // A value the @ can't say: still in its place, nothing shown faint.
    expect(type(s, "@répéter ").field(openField)).toEqual({ at: 14, replaces: "repeat", auto: true });
    // None for what the task doesn't have, nor for tags (a task has several), nor while the keyword isn't known.
    expect(type(s, "@deadline ").field(openField)).toEqual({ at: 14 });
    expect(type(s, "@tag ").field(openField)).toEqual({ at: 14 });
    expect(type(s, "@pr").field(openField)).toEqual({ at: 14 });
    // Typed back to another keyword, it isn't that chip's any more.
    let back = typed;
    for (let i = 0; i < "priorité ".length; i++) back = back.update({ changes: { from: back.doc.length - 1, to: back.doc.length }, userEvent: "delete.backward" }).state;
    expect(type(back, "deadline ").field(openField)).toEqual({ at: 14 });
  });
});
