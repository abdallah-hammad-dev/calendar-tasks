import { syntaxTree } from "@codemirror/language";
import { StateEffect, Transaction, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { parseLinkLine } from "./convert";
import {
  chipSelection,
  clearRemovedEffect,
  closeFieldEffect,
  fieldConfig,
  fieldExtent,
  fieldLine,
  openField,
  removedChips,
  removedOn,
  tokensAt,
  type ChipKey,
  type FieldConfig,
} from "./fields-state";
import { fieldsExtension, type FieldViewDeps } from "./fields-view";
import { cursorTaskLine, leftTaskLines } from "./left-lines";
import type { ChipModel } from "./chips";
import type { ChipMarks } from "./render";

export interface TaskLinkDeps extends FieldViewDeps {
  /** The chip model for a link, or null if it doesn't point to a task note. */
  model(linkpath: string, sourcePath: string): ChipModel | null;
  toggle(path: string): void;
  checkbox: (model: ChipModel) => HTMLElement;
  chips: (model: ChipModel, marks?: ChipMarks) => HTMLElement;
  /**
   * Called when the cursor leaves a line, or the editor its line (for auto-conversion). `replaces`: the chip whose
   * field was open on it (the value typed takes its place).
   */
  lineLeft(view: EditorView, lineFrom: number, text: string, sourcePath: string, replaces?: ChipKey): void;
  /** A field closed after the link of a task already made, the cursor still on the line: its `@` goes to the task now. */
  fieldClosed(view: EditorView, lineFrom: number, text: string, sourcePath: string, replaces?: ChipKey): void;
  /** Today, the language, the vault's tags: what the fields read with. */
  fields: FieldConfig;
}

const LINK = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;

const refresh = StateEffect.define<null>();
const liveViews = new Set<EditorView>();

/** Redraws the task decorations in every open editor (after a task note changed). */
export function refreshTaskDecorations(): void {
  for (const view of liveViews) view.dispatch({ effects: [refresh.of(null), clearRemovedEffect.of(null)] });
}

class CheckboxWidget extends WidgetType {
  constructor(
    private readonly model: ChipModel,
    private readonly make: (m: ChipModel) => HTMLElement,
  ) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.model.path === this.model.path && other.model.done === this.model.done;
  }
  toDOM(): HTMLElement {
    return this.make(this.model);
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class ChipsWidget extends WidgetType {
  constructor(
    private readonly model: ChipModel,
    private readonly marks: ChipMarks,
    private readonly make: (m: ChipModel, marks: ChipMarks) => HTMLElement,
  ) {
    super();
  }
  override eq(other: ChipsWidget): boolean {
    return JSON.stringify([other.model, other.marks]) === JSON.stringify([this.model, this.marks]);
  }
  toDOM(): HTMLElement {
    return this.make(this.model, this.marks);
  }
}

/** Code spans and blocks are left alone. */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (/code/i.test(node.name)) return true;
  }
  return false;
}

function build(view: EditorView, deps: TaskLinkDeps): DecorationSet {
  const file = view.state.field(editorInfoField, false)?.file;
  if (!file) return Decoration.none;
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const picked = state.field(chipSelection, false);
  const open = state.field(openField, false);
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    for (const m of text.matchAll(LINK)) {
      if (m[1]) continue; // embeds
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(state, start)) continue;
      const model = deps.model(m[2]!.trim(), file.path);
      if (!model) continue;
      out.push(Decoration.widget({ widget: new CheckboxWidget(model, deps.checkbox), side: -1 }).range(start));
      if (model.done) out.push(Decoration.mark({ class: "ct-task-done" }).range(start, end));
      const line = state.doc.lineAt(start);
      const ownLine = parseLinkLine(line.text)?.end === end - line.from;
      const marks: ChipMarks = { selected: picked?.line === line.from ? picked.key : null, hidden: removedOn(state, line.from) };
      const chips = (m: ChipMarks) => new ChipsWidget(model, m, deps.chips);
      // On the task's own line the chips take the space after the link: the line's end is after them, a place of
      // its own, like after text (2026-10-27, the user: the cursor showed before the chips, then jumped as
      // Obsidian showed the link's brackets for a cursor against it). Elsewhere they sit right after the link.
      const at = (w: ChipsWidget) =>
        ownLine && state.doc.sliceString(end, end + 1) === " "
          ? Decoration.replace({ widget: w }).range(end, end + 1)
          : Decoration.widget({ widget: w, side: -1 }).range(end);
      const ext = ownLine && open?.replaces && open.at > line.from && open.at <= line.to ? fieldExtent(state, open.at) : null;
      if (ext && open?.replaces) {
        // A field opened from a chip, in its place: the chips before it, the field, the rest.
        const hidden = [...marks.hidden, open.replaces];
        out.push(at(chips({ ...marks, hidden, part: { at: open.replaces, side: "before" } })));
        out.push(Decoration.widget({ widget: chips({ ...marks, hidden, part: { at: open.replaces, side: "after" } }), side: 1 }).range(Math.max(ext.to, ext.from + 1)));
      } else out.push(at(chips(marks)));
    }
  }
  return Decoration.set(out, true);
}

/**
 * A click past the end of a task's line written before its chips had a space of their own (`- [[Task]]`): the space
 * goes in, and the cursor after it (not against the link: see `build`).
 */
function clickPastChips(view: EditorView, e: MouseEvent, deps: TaskLinkDeps): boolean {
  const file = view.state.field(editorInfoField, false)?.file;
  if (!file || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos === null) return false;
  const line = view.state.doc.lineAt(pos);
  const link = parseLinkLine(line.text);
  if (!link || pos !== line.to || link.end !== line.text.length || !deps.model(link.linkpath, file.path)) return false;
  const node = view.domAtPos(line.from).node;
  const chipsEl = (node instanceof HTMLElement ? node : node.parentElement)?.closest(".cm-line")?.querySelector(".ct-task-chips");
  if (!chipsEl || e.clientX < chipsEl.getBoundingClientRect().right) return false;
  view.dispatch({
    changes: { from: line.to, insert: " " },
    selection: { anchor: line.to + 1 },
    annotations: Transaction.addToHistory.of(false),
  });
  view.focus();
  return true;
}

/**
 * The editor lost focus to something else in Obsidian (another note, a sidebar, the note's header): its cursor's
 * line is left too. Not when the whole window lost it (alt-tab with a line half written), nor for a modal or a
 * menu (the date picker, the command palette), after which the cursor comes back. CodeMirror reports a blur 10 ms
 * after it, so the focus is already where it went.
 */
function focusStayedInObsidian(view: EditorView): boolean {
  const doc = view.dom.ownerDocument;
  return doc.hasFocus() && !doc.activeElement?.closest(".modal-container, .menu");
}

/**
 * The field that was at `at` is gone, deleted (not cut by the assistant once applied), or left with its keyword
 * alone and nothing after it.
 */
function erased(u: ViewUpdate, at: number, lineEnd: number): boolean {
  const token = tokensAt(u.state, at).find((t) => t.start === at);
  if (token) return !token.complete && !u.state.sliceDoc(token.end, lineEnd).trim();
  return u.transactions.some((tr) => tr.isUserEvent("delete"));
}

/**
 * Live Preview / source mode: checkboxes and chips around links to task notes, and the "cursor left a line"
 * signal for auto-conversion (also when the editor loses focus, see `focusStayedInObsidian`). Rebuilt on edits,
 * scrolling, and `refreshTaskDecorations()` (task changes).
 */
export function taskEditorExtension(deps: TaskLinkDeps): Extension {
  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(private readonly view: EditorView) {
        this.decorations = build(view, deps);
        liveViews.add(view);
      }
      update(u: ViewUpdate): void {
        const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
        const open = u.state.field(openField, false);
        const marked =
          u.startState.field(chipSelection, false) !== u.state.field(chipSelection, false) ||
          u.startState.field(removedChips, false) !== u.state.field(removedChips, false) ||
          u.startState.field(openField, false)?.replaces !== open?.replaces ||
          (u.selectionSet && !!open?.replaces); // the field reaches as far as the cursor while the assistant reads
        if (u.docChanged || u.viewportChanged || refreshed || marked) this.decorations = build(u.view, deps);
      }
      destroy(): void {
        liveViews.delete(this.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const leave = EditorView.updateListener.of((u) => {
    const file = u.state.field(editorInfoField, false)?.file;
    if (!file) return;
    const was = u.startState.field(openField, false);
    const field = u.state.field(openField, false);
    if (u.focusChanged && !u.view.hasFocus && focusStayedInObsidian(u.view)) {
      // Can't dispatch from inside an update: the field closes just after (the line is applied already).
      if (field) queueMicrotask(() => u.view.dispatch({ effects: closeFieldEffect.of(null) }));
      const line = cursorTaskLine(u.state);
      if (line) deps.lineLeft(u.view, line.from, line.text, file.path, field?.replaces);
      return;
    }
    // A field closed after a task's link: it goes to the task now (on a `- [ ]` line it waits for the line).
    let closed: { from: number; replaces?: ChipKey } | null = null;
    if (was && !field) {
      const at = Math.min(u.changes.mapPos(was.at, 1), u.state.doc.length);
      if (fieldLine(u.state, at)?.link) {
        const line = u.state.doc.lineAt(at);
        if (was.replaces && erased(u, at, line.to)) {
          // The field of a chip, emptied: its value goes, as two Backspaces on the chip would.
          deps.removeChip(line.text, file.path, was.replaces);
          closed = { from: line.from };
        } else closed = { from: line.from, replaces: was.replaces };
      }
    }
    const pasted = u.transactions.some((tr) => tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop"));
    const left = u.selectionSet || pasted ? leftTaskLines(u.startState, u.state, u.changes, u.selectionSet, pasted) : [];
    for (const line of left) deps.lineLeft(u.view, line.from, line.text, file.path, line.from === closed?.from ? closed.replaces : undefined);
    if (closed && !left.some((line) => line.from === closed.from)) {
      const line = u.state.doc.lineAt(closed.from);
      deps.fieldClosed(u.view, line.from, line.text, file.path, closed.replaces);
    }
  });

  return [
    fieldConfig.of(deps.fields),
    fieldsExtension(deps),
    removedChips,
    decorations,
    leave,
    EditorView.domEventHandlers({ mousedown: (e, view) => clickPastChips(view, e, deps) }),
  ];
}
