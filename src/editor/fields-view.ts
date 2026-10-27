import { EditorSelection, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, setIcon } from "obsidian";
import { PRIORITY_MARK } from "../constants";
import { language, t } from "../i18n";
import { localZone } from "../ical/time";
import { dueLabel } from "./chips";
import { blockLabel } from "./date-suggest";
import {
  backspaceBlock,
  chipSelection,
  closeFieldEffect,
  deleteBlock,
  fieldExtent,
  openField,
  openFieldEffect,
  padTyping,
  tokensAt,
  type ChipActions,
  type ChipKey,
} from "./fields-state";
import { featureName, repeatLabel, type Feature, type LineToken } from "./when";

/** Draws the fields of `fields-state.ts`: the one being typed, and a block (a chip) for each other `@`. */

export interface FieldViewDeps {
  /** The chips Backspace can take off the task linked at the start of this line, in their order on screen. */
  chipKeys(lineText: string, sourcePath: string): ChipKey[];
  removeChip(lineText: string, sourcePath: string, key: ChipKey): void;
}

const lang = (): "fr" | "en" => (language().startsWith("fr") ? "fr" : "en");
const hm = (value: string) => value.slice(11, 16);

/** What a block shows: the class of the chip it looks like, its icon, its text. */
function blockLook(token: LineToken): { cls: string; icon: string | null; text: string } {
  const w = token.when;
  if (w.clear?.includes("due")) return { cls: "", icon: "circle-slash", text: t("suggest.noDeadline") };
  if (w.clear?.includes("repeat")) return { cls: "", icon: "circle-slash", text: t("suggest.noRepeat") };
  if (w.clear?.includes("priority")) return { cls: "", icon: "circle-slash", text: t("suggest.noPriority") };
  if (token.feature === "priority" && w.priority) return { cls: `ct-chip-priority is-${w.priority}`, icon: null, text: PRIORITY_MARK[w.priority] };
  if (token.feature === "tag") return { cls: "ct-chip-tags", icon: null, text: `#${w.tags?.[0] ?? ""}` };
  if (token.feature === "block") return { cls: "ct-chip-session", icon: "clock", text: w.blocks[0] ? blockLabel(w.blocks[0]) : "" };
  if (token.feature === "repeat") {
    const rule = (w.repeat && repeatLabel(w.repeat, lang())) ?? t("suggest.customRepeat");
    return { cls: "ct-chip-repeat", icon: "repeat", text: token.timed && w.due ? `${rule} ${hm(w.due)}` : rule };
  }
  const due = dueLabel(w.due ?? "", false, { now: new Date(), tz: localZone(), lang: language(), words: { today: t("chip.today"), tomorrow: t("chip.tomorrow") } });
  return { cls: `ct-chip-due${due.overdue ? " is-overdue" : ""}`, icon: "flag", text: due.text };
}

/** Opens the field of the `@` a block stands for, its value selected: typing replaces it. */
function editBlock(view: EditorView, el: HTMLElement): void {
  const pos = view.posAtDOM(el);
  const token = tokensAt(view.state, pos).find((x) => x.start === pos);
  if (!token) return;
  const from = view.state.doc.sliceString(token.valueStart, token.valueStart + 1) === " " ? token.valueStart + 1 : token.valueStart;
  view.dispatch({ selection: EditorSelection.range(from, token.end), effects: openFieldEffect.of({ at: token.start }) });
  view.focus();
}

class BlockWidget extends WidgetType {
  constructor(
    private readonly look: { cls: string; icon: string | null; text: string },
    private readonly selected: boolean,
  ) {
    super();
  }
  override eq(other: BlockWidget): boolean {
    return other.look.cls === this.look.cls && other.look.text === this.look.text && other.selected === this.selected;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = createSpan({ cls: `ct-chip ct-field-block ${this.look.cls}${this.selected ? " is-selected" : ""}` });
    if (this.look.icon) setIcon(el.createSpan({ cls: "ct-chip-icon" }), this.look.icon);
    el.appendText(this.look.text);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      editBlock(view, el);
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** The start of the field being typed: its keyword shown as a label ("🚩 Deadline", "#" for a tag). */
class LabelWidget extends WidgetType {
  constructor(private readonly feature: Feature) {
    super();
  }
  override eq(other: LabelWidget): boolean {
    return other.feature === this.feature;
  }
  toDOM(): HTMLElement {
    const el = createSpan({ cls: `ct-field-label is-${this.feature}` });
    if (this.feature === "tag") el.setText("#");
    else {
      const { name, icon } = featureName(this.feature, lang());
      setIcon(el.createSpan({ cls: "ct-chip-icon" }), icon);
      el.appendText(name);
    }
    return el;
  }
}

function build(view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } {
  const { state } = view;
  const open = state.field(openField, false);
  const sel = state.selection.main;
  const marks: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (seen.has(line.from) || !line.text.includes("@")) continue;
      seen.add(line.from);
      for (const token of tokensAt(state, line.from)) {
        if (token.start === open?.at || !token.complete) continue;
        const selected = sel.from === token.start && sel.to === token.end;
        const block = Decoration.replace({ widget: new BlockWidget(blockLook(token), selected) }).range(token.start, token.end);
        marks.push(block);
        atomic.push(block);
      }
      if (!open || open.at < line.from || open.at > line.to) continue;
      const ext = fieldExtent(state, open.at);
      if (!ext) continue;
      marks.push(Decoration.mark({ class: "ct-field", inclusiveEnd: true }).range(ext.from, Math.max(ext.to, ext.from + 1)));
      const token = ext.token;
      if (token?.feature && token.valueStart > token.start + 1) {
        const end = state.doc.sliceString(token.valueStart, token.valueStart + 1) === " " ? token.valueStart + 1 : token.valueStart;
        const label = Decoration.replace({ widget: new LabelWidget(token.feature) }).range(token.start, end);
        marks.push(label);
        atomic.push(label);
      }
    }
  }
  return { decorations: Decoration.set(marks, true), atomic: Decoration.set(atomic, true) };
}

const fieldsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;
    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomic: this.atomic } = build(view));
    }
    update(u: ViewUpdate): void {
      const fieldMoved = u.startState.field(openField, false) !== u.state.field(openField, false);
      if (u.docChanged || u.selectionSet || u.viewportChanged || fieldMoved) ({ decorations: this.decorations, atomic: this.atomic } = build(u.view));
    }
  },
  { decorations: (v) => v.decorations },
);

/** Backspace and Delete on blocks, and on the chips of a task already made. */
function chipActions(view: EditorView, deps: FieldViewDeps): ChipActions | undefined {
  const file = view.state.field(editorInfoField, false)?.file;
  if (!file) return undefined;
  return { keys: (text) => deps.chipKeys(text, file.path), remove: (text, key) => deps.removeChip(text, file.path, key) };
}

export function fieldsExtension(deps: FieldViewDeps): Extension {
  return [
    openField,
    chipSelection,
    fieldsPlugin,
    EditorView.atomicRanges.of((view) => view.plugin(fieldsPlugin)?.atomic ?? Decoration.none),
    Prec.highest(
      keymap.of([
        { key: "Backspace", run: (view) => backspaceBlock(view, chipActions(view, deps)) },
        { key: "Delete", run: (view) => deleteBlock(view) },
        {
          key: "Escape",
          run: (view) => {
            if (view.state.field(openField, false)) view.dispatch({ effects: closeFieldEffect.of(null) });
            return false; // the assistant's list closes too
          },
        },
      ]),
    ),
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !tr.isUserEvent("input.type")) return tr;
      const changes: { from: number; to: number; text: string }[] = [];
      tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, text: inserted.toString() }));
      if (changes.length !== 1) return tr;
      const { from, to, text } = changes[0]!;
      const padded = padTyping(tr.startState, from, to, text);
      if (padded === text) return tr;
      const after = padded.endsWith(" ") && !text.endsWith(" ") ? 1 : 0;
      return { changes: { from, to, insert: padded }, selection: EditorSelection.cursor(from + padded.length - after), userEvent: "input.type" };
    }),
  ];
}
