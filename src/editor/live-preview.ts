import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { cursorTaskLine, leftTaskLines } from "./left-lines";
import type { ChipModel } from "./chips";

export interface TaskLinkDeps {
  /** The chip model for a link, or null if it doesn't point to a task note. */
  model(linkpath: string, sourcePath: string): ChipModel | null;
  toggle(path: string): void;
  checkbox: (model: ChipModel) => HTMLElement;
  chips: (model: ChipModel) => HTMLElement;
  /** Called when the cursor leaves a line, or the editor its line (for auto-conversion). */
  lineLeft(view: EditorView, lineFrom: number, text: string, sourcePath: string): void;
}

const LINK = /(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;

const refresh = StateEffect.define<null>();
const liveViews = new Set<EditorView>();

/** Redraws the task decorations in every open editor (after a task note changed). */
export function refreshTaskDecorations(): void {
  for (const view of liveViews) view.dispatch({ effects: refresh.of(null) });
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
    private readonly make: (m: ChipModel) => HTMLElement,
  ) {
    super();
  }
  override eq(other: ChipsWidget): boolean {
    return JSON.stringify(other.model) === JSON.stringify(this.model);
  }
  toDOM(): HTMLElement {
    return this.make(this.model);
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
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(LINK)) {
      if (m[1]) continue; // embeds
      const start = from + m.index;
      const end = start + m[0].length;
      if (inCode(view.state, start)) continue;
      const model = deps.model(m[2]!.trim(), file.path);
      if (!model) continue;
      builder.add(start, start, Decoration.widget({ widget: new CheckboxWidget(model, deps.checkbox), side: -1 }));
      if (model.done) builder.add(start, end, Decoration.mark({ class: "ct-task-done" }));
      builder.add(end, end, Decoration.widget({ widget: new ChipsWidget(model, deps.chips), side: 1 }));
    }
  }
  return builder.finish();
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
        if (u.docChanged || u.viewportChanged || refreshed) this.decorations = build(u.view, deps);
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
    if (u.focusChanged && !u.view.hasFocus && focusStayedInObsidian(u.view)) {
      const line = cursorTaskLine(u.state);
      if (line) deps.lineLeft(u.view, line.from, line.text, file.path);
      return;
    }
    const pasted = u.transactions.some((tr) => tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop"));
    if (!u.selectionSet && !pasted) return;
    for (const line of leftTaskLines(u.startState, u.state, u.changes, u.selectionSet, pasted)) {
      deps.lineLeft(u.view, line.from, line.text, file.path);
    }
  });

  return [decorations, leave];
}
