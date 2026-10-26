import {
  EditorSuggest,
  setIcon,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type TFile,
} from "obsidian";
import { formatLocalDate, localZone, parseLocal, wallClock } from "../ical/time";
import { language, t } from "../i18n";
import { DatePickerModal } from "./date-picker";
import { addDays } from "./date-token";
import { linkLineEdit, parseLinkLine, parseTaskLine, typedAt } from "./convert";
import { dateText, repeatLabel, slotText, suggestAt, type AtItem, type Block, type Feature, type When, type WhenToken } from "./when";

type Item = AtItem | { kind: "pick"; text: string; label: string };

const lang = (): "fr" | "en" => (language().startsWith("fr") ? "fr" : "en");
const today = () => wallClock(new Date(), localZone());
const fields = (task: EditedTask) => ({ due: !!task.due, repeat: !!task.repeat });

/** "ven. 23 oct. 14:00", or "aujourd'hui", "demain 9:00" when `relative`. */
export function shortDay(value: string, relative = true): string {
  const p = parseLocal(value);
  if (!p) return value;
  const now = today();
  const tomorrow = wallClock(new Date(Date.now() + 86_400_000), localZone());
  const date = formatLocalDate(p.wall);
  const day =
    relative && date === formatLocalDate(now)
      ? t("chip.today").toLowerCase()
      : relative && date === formatLocalDate(tomorrow)
        ? t("chip.tomorrow").toLowerCase()
        : new Intl.DateTimeFormat(lang(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
            new Date(Date.UTC(p.wall.year, p.wall.month - 1, p.wall.day)),
          );
  return p.allDay ? day : `${day} ${String(p.wall.hour).padStart(2, "0")}:${String(p.wall.minute).padStart(2, "0")}`;
}

/** What a reading of `@…` means, as small icon + text parts: deadline, time blocks, repetition, tags. */
export function renderWhen(el: HTMLElement, when: When): void {
  const part = (icon: string, text: string) => {
    const span = el.createSpan({ cls: "ct-when-part" });
    setIcon(span.createSpan({ cls: "ct-chip-icon" }), icon);
    span.appendText(text);
  };
  if (when.clear?.includes("due")) part("circle-slash", t("suggest.noDeadline"));
  else if (when.clear?.includes("repeat")) part("circle-slash", t("suggest.noRepeat"));
  if (when.due) part("flag", shortDay(when.due, false));
  for (const b of when.blocks) part("clock", blockLabel(b));
  if (when.repeat) part("repeat", repeatLabel(when.repeat, lang()) ?? t("suggest.customRepeat"));
  for (const tag of when.tags ?? []) part("tag", `#${tag}`);
}

/** A time block, or "chaque mardi 14:00–16:00" for one that comes back. */
export function blockLabel(b: Block): string {
  if (!b.repeat) return slotLabel(b.start, b.end);
  const rule = repeatLabel(b.repeat, lang()) ?? t("suggest.customRepeat");
  const s = parseLocal(b.start);
  const e = parseLocal(b.end);
  if (!s || !e || s.allDay) return rule;
  const hm = (w: { hour: number; minute: number }) => `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  return `${rule} ${hm(s.wall)}–${hm(e.wall)}`;
}

/** "mar. 20 oct. 14:00–16:00", "mar. 20 oct.", "lun. 19 oct. → mer. 21 oct.". */
export function slotLabel(start: string, end: string): string {
  const s = parseLocal(start);
  const e = parseLocal(end);
  if (s?.allDay && e) {
    const last = formatLocalDate(addDays(e.wall, -1));
    return last === start ? shortDay(start, false) : `${shortDay(start, false)} → ${shortDay(last, false)}`;
  }
  if (!s || !e) return shortDay(start, false);
  const hm = (w: { hour: number; minute: number }) => `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  return `${shortDay(start, false)}–${hm(e.wall)}`;
}

/** A task the `@` assistant changes: one linked at the start of the line (`- [[Task]] @…`). */
export interface EditedTask {
  path: string;
  due: string | null;
  repeat: string | null;
}

export interface DateSuggestDeps {
  /** The task note a link points to, from a note. */
  task(linkpath: string, sourcePath: string): EditedTask | null;
  /** Applies a line's `@` tokens and `#tags` to that task. */
  edit(path: string, found: WhenToken | null, tags: string[]): void;
  /** The vault's tags, most used first (offered after `@tag`). */
  knownTags(): string[];
}

/**
 * The `@` assistant (spec §5.2): in a `- [ ]` line, `@` first offers what to add (deadline, time block, repeat,
 * the task alone), then values for it, read as they're typed. The ✓ item takes the text as it is and ends
 * the line; "something else" starts another `@`. After the link of a task already made (`- [[Task]] @…`), the
 * same `@` changes that task, and ✓ applies it.
 */
export class DateSuggest extends EditorSuggest<Item> {
  private from = 0;
  /** What the value being typed is for: the calendar asks for a time (deadline) or from / to (time block). */
  private feature: Feature | undefined;
  /** The task being changed, when the `@` follows its link. */
  private editing: EditedTask | null = null;

  constructor(
    app: App,
    private readonly deps: DateSuggestDeps,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const at = typedAt(line, cursor.ch);
    if (at === null) return null;
    let editing: EditedTask | null = null;
    if (!parseTaskLine(line)) {
      const link = parseLinkLine(line);
      editing = link && link.end <= at && file ? this.deps.task(link.linkpath, file.path) : null;
      if (!editing) return null;
    }
    const typed = line.slice(at + 1, cursor.ch);
    if (!suggestAt(typed, today(), lang(), editing ? fields(editing) : undefined, this.deps.knownTags())) return null;
    this.editing = editing;
    return { start: { line: cursor.line, ch: at }, end: cursor, query: typed };
  }

  getSuggestions(context: EditorSuggestContext): Item[] {
    const res = suggestAt(context.query, today(), lang(), this.editing ? fields(this.editing) : undefined, this.deps.knownTags());
    if (!res) return [];
    this.from = res.from;
    this.feature = res.feature;
    const items: Item[] = [...res.items];
    if (res.wantsDay) items.push({ kind: "pick", text: "", label: t("suggest.pickDate") });
    return items;
  }

  renderSuggestion(item: Item, el: HTMLElement): void {
    el.addClass("ct-date-suggestion");
    const label = el.createSpan({ cls: "ct-date-suggestion-label" });
    const right = el.createSpan({ cls: "ct-date-suggestion-day" });
    const icon = item.kind === "pick" ? "calendar-search" : item.icon;
    if (icon) setIcon(label.createSpan({ cls: "ct-chip-icon" }), icon);
    label.appendText(item.label);
    if (item.kind !== "pick" && item.when) renderWhen(right, item.when);
    else if (item.kind !== "pick" && item.hint) right.setText(item.hint);
  }

  selectSuggestion(item: Item, evt: MouseEvent | KeyboardEvent): void {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end, file } = ctx;
    const tailFrom = { line: start.line, ch: start.ch + 1 + this.from };
    if (item.kind === "accept") {
      let to = end;
      if (item.text !== ctx.query) {
        // An item standing for words ("Ne plus répéter" → "répéter jamais"): they go in first.
        editor.replaceRange(item.text, { line: start.line, ch: start.ch + 1 }, end);
        to = { line: start.line, ch: start.ch + 1 + item.text.length };
      }
      if (this.editing) this.finishEdit(editor, to.line, this.editing);
      else this.finishLine(editor, to);
      return;
    }
    if (item.kind === "pick") {
      this.pickDay(editor, tailFrom, end, file);
      return;
    }
    if (item.kind === "more") {
      const typed = editor.getRange(start, end);
      const text = typed.endsWith(" ") ? "@" : " @";
      editor.replaceRange(text, end);
      editor.setCursor({ line: end.line, ch: end.ch + text.length });
      this.reopen(editor, file);
      return;
    }
    if (!item.text) return; // a keyword's own hint: nothing to insert yet
    const text = item.text.endsWith(" ") ? item.text : `${item.text} `;
    editor.replaceRange(text, tailFrom, end);
    editor.setCursor({ line: tailFrom.line, ch: tailFrom.ch + text.length });
    this.reopen(editor, file);
    void evt;
  }

  /** Ends the line the way Enter would (a new `- [ ]` below), so the task converts at once. */
  private finishLine(editor: Editor, end: EditorPosition): void {
    const line = editor.getLine(end.line);
    if (line.slice(end.ch).trim()) {
      this.close(); // more text after: it converts when the cursor leaves the line
      return;
    }
    const prefix = /^(\s*[-*+] )/.exec(line)?.[1] ?? "- ";
    // One transaction, so the editor sees the cursor leave the task line (that's what converts it).
    editor.transaction({
      changes: [{ from: { line: end.line, ch: line.trimEnd().length }, to: { line: end.line, ch: line.length }, text: `\n${prefix}[ ] ` }],
      selection: { from: { line: end.line + 1, ch: prefix.length + 4 } },
    });
  }

  /** Changes the task linked on the line with its `@` tokens and `#tags`, and takes them off the line. */
  private finishEdit(editor: Editor, n: number, task: EditedTask): void {
    this.close();
    const line = editor.getLine(n);
    const res = linkLineEdit(line, today());
    if (!res) return;
    editor.replaceRange(res.rest, { line: n, ch: 0 }, { line: n, ch: line.length });
    editor.setCursor({ line: n, ch: res.rest.length });
    this.deps.edit(task.path, res.found, res.tags);
  }

  /**
   * A calendar to pick the day and the time (deadline) or the hours (time block); it goes in as `15/10/2027 14h`
   * or `15/10/2027 14h-16h` and the assistant carries on.
   */
  private pickDay(editor: Editor, from: EditorPosition, to: EditorPosition, file: TFile | null): void {
    this.close();
    const put = (value: string) => {
      const text = `${value} `;
      editor.replaceRange(text, from, to);
      editor.setCursor({ line: from.line, ch: from.ch + text.length });
      editor.focus();
      this.reopen(editor, file);
    };
    const picker =
      this.feature === "block"
        ? new DatePickerModal(this.app, { mode: "slot", pick: (block) => put(slotText(block)) })
        : new DatePickerModal(this.app, { mode: "due", pick: (value) => put(dateText(value)) });
    picker.open();
  }

  /** Inserting by code doesn't count as typing: ask for the list again so the next step shows up. */
  private reopen(editor: Editor, file: TFile | null): void {
    window.setTimeout(() => {
      const self = this as unknown as { trigger?: (e: Editor, f: TFile | null, open: boolean) => void };
      self.trigger?.(editor, file, true);
    }, 0);
  }
}
