import { EditorSelection, EditorState, Facet, Prec, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, setIcon } from "obsidian";
import { PRIORITY_MARK } from "../constants";
import { language, t } from "../i18n";
import { localZone } from "../ical/time";
import { dueLabel } from "./chips";
import { blockLabel } from "./date-suggest";
import {
  backspaceBlock,
  chipGap,
  chipSelection,
  closeFieldEffect,
  deleteBlock,
  fieldExtent,
  moveAmongChips,
  openBlockField,
  openField,
  padTyping,
  restoreField,
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
  /** Shows the assistant's list for the field at the cursor, which code opened (it isn't typing). */
  openList(view: EditorView): void;
}

const listOpener = Facet.define<(view: EditorView) => void, ((view: EditorView) => void) | null>({ combine: (v) => v[0] ?? null });

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

/** Opens the field of the `@` a block stands for, with the assistant's list, as a chip's (2026-10-27, asked). */
function editBlock(view: EditorView, el: HTMLElement): void {
  const pos = view.posAtDOM(el);
  const token = tokensAt(view.state, pos).find((x) => x.start === pos);
  const spec = token && openBlockField(view.state, token);
  if (!spec) return;
  view.dispatch(spec);
  view.focus();
  view.state.facet(listOpener)?.(view);
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

/** A chip's value, faint where its field's new one is typed (`OpenField.was`). */
class PlaceholderWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  override eq(other: PlaceholderWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    return createSpan({ cls: "ct-field-placeholder", text: this.text });
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
      const token = ext.token;
      const labelled = !!token?.feature && token.valueStart > token.start + 1;
      const labelEnd = !token || !labelled ? ext.from + 1 : state.doc.sliceString(token.valueStart, token.valueStart + 1) === " " ? token.valueStart + 1 : token.valueStart;
      // The space after a value is the line's, not the field's (2026-10-27, the user: the purple went on past
      // "moyenne"); with no value yet the field reaches the cursor, which types in it.
      const end = Math.max(labelEnd, ext.from + state.doc.sliceString(ext.from, ext.to).trimEnd().length);
      marks.push(Decoration.mark({ class: "ct-field", inclusiveEnd: true }).range(ext.from, Math.max(end, ext.from + 1)));
      if (token?.feature && labelled) {
        const label = Decoration.replace({ widget: new LabelWidget(token.feature) }).range(token.start, labelEnd);
        marks.push(label);
        atomic.push(label);
        if (open.was && ext.to <= labelEnd) marks.push(Decoration.widget({ widget: new PlaceholderWidget(open.was), side: 1 }).range(labelEnd));
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
    listOpener.of((view) => deps.openList(view)),
    openField,
    chipSelection,
    chipGap,
    fieldsPlugin,
    EditorView.atomicRanges.of((view) => view.plugin(fieldsPlugin)?.atomic ?? Decoration.none),
    Prec.highest(
      keymap.of([
        { key: "Backspace", run: (view) => backspaceBlock(view, chipActions(view, deps)) },
        { key: "Delete", run: (view) => deleteBlock(view, chipActions(view, deps)) },
        { key: "ArrowLeft", run: (view) => moveAmongChips(view, chipActions(view, deps), -1) },
        { key: "ArrowRight", run: (view) => moveAmongChips(view, chipActions(view, deps), 1) },
        {
          key: "Escape",
          run: (view) => {
            if (view.state.field(openField, false)) view.dispatch({ effects: closeFieldEffect.of(null) });
            return false; // the assistant's list closes too
          },
        },
      ]),
    ),
    // A field closing without a new value: what it stood for comes back, in the same transaction.
    EditorState.transactionFilter.of((tr) => {
      const back = restoreField(tr);
      return back ? [tr, back] : tr;
    }),
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
