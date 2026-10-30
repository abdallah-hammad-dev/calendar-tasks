import { AbstractInputSuggest, Modal, Platform, Setting, SuggestModal, setIcon, type App } from "obsidian";
import type { Priority } from "../constants";
import { formatLocalDate, localZone, parseLocal, wallClock } from "../ical/time";
import { language, t } from "../i18n";
import { DatePickerModal, fieldsProblem, hm, markFields } from "../editor/date-picker";
import { blockLabel, shortDay } from "../editor/date-suggest";
import type { EditFocus } from "../editor/render";
import { DayPreview, type Placed, type PreviewSource } from "../calendar/day-preview";
import { localValue } from "../calendar/when-fields";
import { dateText, dayBlock, dayValue, firstDay, readFields, repeatLabel, suggestAt, type Block } from "../editor/when";
import { menuSelect, named } from "../ui/menu-select";
import { formSheet } from "../ui/sheet";
import { sameTag, tagsOf } from "./tags";

const lang = (): "fr" | "en" => (language().startsWith("fr") ? "fr" : "en");
const today = () => wallClock(new Date(), localZone());


export interface NewTask {
  title: string;
  due: string | null;
  /** RRULE. */
  repeat: string | null;
  priority: Priority | null;
  /** Without "#". */
  tags: string[];
  /** The collection it goes in, by name. */
  collection: string | null;
  /** Time to block for it (events linked to the task). */
  blocks: Block[];
}

/** A task the form changes: what it holds now. */
export interface TaskDraft {
  title: string;
  due: string | null;
  repeat: string | null;
  priority: Priority | null;
  tags: string[];
  collection: string | null;
  /** Time blocks it already has: a label, and where it starts (to show its day; null for "…"). */
  planned: { label: string; start: string | null }[];
}

const REPEATS = [
  "FREQ=DAILY",
  "FREQ=WEEKLY",
  "FREQ=WEEKLY;INTERVAL=2",
  "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  "FREQ=MONTHLY",
  "FREQ=YEARLY",
];

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const repeatOption = (rule: string) => ({ value: rule, label: capital(repeatLabel(rule, lang()) ?? rule) });

/**
 * The task form (spec §5.3): a title, an optional deadline, time blocks, a repetition, a priority, tags, the
 * collection.
 * New, or `edit` to change a task already made (clicking its chips): its values filled in. With a `preview`, a day
 * of the calendar beside it shows where the deadline and the time blocks land among the rest, and places them.
 */
export class TaskModal extends Modal {
  private task: NewTask;
  private valid = { due: true, block: true };
  private typedSlot: () => Block | null = () => null;
  /** Where the fields go (beside the day preview when there is one). */
  private form!: HTMLElement;
  private preview: DayPreview | null = null;
  /** Day and time of the deadline; day, from and to of the time block being typed. */
  private dueFields: HTMLInputElement[] = [];
  private slotFields: HTMLInputElement[] = [];
  private redrawSlots: () => void = () => undefined;
  /** Puts a time block in the list (dragged on the preview). */
  private addBlock: (block: Block) => void = () => undefined;
  /** What the preview shows the day of: `due`, `typed`, `block:<i>`, `planned:<i>`. */
  private shown: string | null = null;

  constructor(
    app: App,
    private readonly opts: {
      /** The vault's tags (without "#"), most used first: what the tags field suggests. */
      knownTags: string[];
      /** Collections a task can go in (names), and the one to start with. */
      collections: string[];
      collection: string | null;
      submit: (task: NewTask) => void;
      edit?: TaskDraft;
      /** The field to start in. */
      focus?: EditFocus;
      /** The calendar, for the day preview (none without a server). */
      preview?: PreviewSource;
    },
  ) {
    super(app);
    const e = opts.edit;
    this.task = {
      title: e?.title ?? "",
      due: e?.due ?? null,
      repeat: e?.repeat ?? null,
      priority: e?.priority ?? null,
      tags: e?.tags ?? [],
      collection: opts.collection,
      blocks: [],
    };
  }

  override onOpen(): void {
    const edit = this.opts.edit;
    this.modalEl.addClass("ct-task-modal");
    this.setTitle(t(edit ? "modal.editTask" : "modal.newTask"));
    // A phone has no room beside the form, and under it the day was out of sight below the buttons (2026-10-30).
    const preview = Platform.isPhone ? undefined : this.opts.preview;
    if (preview) {
      this.modalEl.addClass("has-preview");
      this.contentEl.addClass("ct-task-split");
      this.form = this.contentEl.createDiv({ cls: "ct-task-form" });
    } else this.form = this.contentEl;
    this.form.addClass("ct-task-fields");
    let start: HTMLElement | null = null;
    const startAt = (focus: EditFocus, el: HTMLElement) => {
      if ((this.opts.focus ?? null) === focus) start = el;
    };
    const title = this.form.createEl("input", {
      cls: "ct-task-title-input",
      type: "text",
      attr: { placeholder: t("modal.titlePlaceholder") },
    });
    title.value = this.task.title;
    title.addEventListener("input", () => {
      this.task.title = title.value;
      this.refreshPreview();
    });
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) this.submit();
    });
    startAt(null, title);
    startAt("due", this.deadline());
    this.slots(edit?.planned ?? []);

    const repeat = named(new Setting(this.form), "repeat", t("modal.repeat"));
    const options = [{ value: "", label: t("modal.repeat.never") }, ...REPEATS.map(repeatOption)];
    if (this.task.repeat && !REPEATS.includes(this.task.repeat)) options.push(repeatOption(this.task.repeat));
    const repeatSelect = menuSelect(repeat.controlEl, {
      options,
      value: this.task.repeat ?? "",
      onChange: (v) => (this.task.repeat = v || null),
      extra: {
        label: t("modal.repeat.custom"),
        icon: "pencil",
        run: () =>
          new RepeatPickerModal(this.app, {
            placeholder: t("picker.repeat"),
            pick: (rule) => {
              this.task.repeat = rule;
              repeatSelect.setValue(rule, repeatOption(rule).label);
            },
          }).open(),
      },
    });
    startAt("repeat", repeatSelect.el);

    // Low to high, as on the iPhone.
    const priority = named(new Setting(this.form), "chevrons-up", t("modal.priority"));
    const prioritySelect = menuSelect(priority.controlEl, {
      options: [
        { value: "", label: t("modal.none") },
        ...(["low", "medium", "high"] as const).map((p) => ({ value: p, label: t(`priority.${p}`) })),
      ],
      value: this.task.priority ?? "",
      onChange: (v) => (this.task.priority = v === "high" || v === "medium" || v === "low" ? v : null),
    });
    startAt("priority", prioritySelect.el);

    // Typed as tags ("#famille #urgent", "#" or not), the vault's tags suggested for the one being typed.
    const tags = named(new Setting(this.form), "tag", t("modal.tags"));
    const tagsInput = tags.controlEl.createEl("input", { cls: "ct-task-tags-input", type: "text" });
    tagsInput.value = this.task.tags.map((tag) => `#${tag}`).join(" ");
    const readTags = () => (this.task.tags = tagsOf(tagsInput.value));
    tagsInput.addEventListener("input", readTags);
    new TagSuggest(this.app, tagsInput, this.opts.knownTags, readTags);
    tagsInput.addClass("ct-sheet-top"); // its suggestions show under it, above a phone's keyboard
    startAt("tags", tagsInput);

    if (this.opts.collections.length > 1) {
      const collection = named(new Setting(this.form), "calendar", t("modal.calendar"));
      menuSelect(collection.controlEl, {
        options: this.opts.collections.map((name) => ({ value: name, label: name, icon: "calendar" })),
        value: this.task.collection ?? "",
        onChange: (v) => (this.task.collection = v || null),
      });
    }
    new Setting(this.form)
      .setClass("ct-modal-buttons")
      .addButton((b) => b.setButtonText(t("modal.cancel")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t(edit ? "modal.save" : "modal.create")).setCta().onClick(() => this.submit()));
    if (preview) {
      this.preview = new DayPreview(this.contentEl.createDiv({ cls: "ct-task-preview" }), preview, {
        // Dragged over free time: a time block in the list, like typed then added.
        pick: (start, end, allDay) => this.addBlock({ start: localValue(start, allDay), end: localValue(end, allDay) }),
        move: (id, start, end, allDay) => this.moved(id, start, end, allDay),
      });
      this.refreshPreview(this.task.due ? "due" : undefined);
    }
    formSheet(this);
    window.setTimeout(() => start?.focus(), 0);
  }

  /** What's being placed, on the day of `focus` (what was just typed, moved or clicked), scrolled to its time. */
  private refreshPreview(focus?: string): void {
    const placed = this.placed();
    const at = placed.find((p) => p.id === focus);
    if (at) this.shown = at.id;
    this.showOn(placed, at?.start ?? null);
  }

  private placed(): Placed[] {
    const title = this.task.title.trim() || t("modal.newTask");
    const placed: Placed[] = [];
    if (this.task.due) placed.push({ id: "due", kind: "deadline", start: this.task.due, end: null, title });
    this.task.blocks.forEach((b, i) => placed.push({ id: `block:${i}`, kind: "timeblock", start: b.start, end: b.end, title }));
    const typed = this.typedSlot();
    if (typed) placed.push({ id: "typed", kind: "timeblock", start: typed.start, end: typed.end, title });
    return placed;
  }

  /** The day of `start` ("2026-10-20T14:35", or a day; null: the day shown), and the slot rows saying which. */
  private showOn(placed: Placed[], start: string | null): void {
    if (!this.preview) return;
    this.preview.show(placed, start?.slice(0, 10), start && start.length > 10 ? start.slice(11, 16) : null);
    for (const row of Array.from(this.form.querySelectorAll<HTMLElement>(".ct-slot[data-id]"))) row.toggleClass("is-shown", row.dataset.id === this.shown);
  }

  /** Moved or stretched in the preview: the fields (or the block in the list) take the new times. */
  private moved(id: string, start: Date, end: Date | null, allDay: boolean): void {
    const value = (d: Date) => localValue(d, allDay);
    if (id === "due") return this.setDue(value(start));
    const block: Block = { start: value(start), end: value(end ?? new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000))) };
    if (id === "typed") return this.setTyped(block);
    const i = Number(id.slice("block:".length));
    const old = this.task.blocks[i];
    if (!old) return;
    this.task.blocks[i] = old.repeat ? { ...block, repeat: old.repeat } : block;
    this.redrawSlots();
    this.refreshPreview(id);
  }

  /** Puts a deadline in its fields as if typed: the reading and the hint follow. */
  private setDue(value: string): void {
    const [day, time] = this.dueFields;
    const p = parseLocal(value);
    if (!day || !time || !p) return;
    day.value = dateText(value.slice(0, 10));
    time.value = p.allDay ? "" : hm(p.wall);
    day.dispatchEvent(new Event("input"));
  }

  /** Puts a time block in the fields being typed (day, from, to), as if typed. */
  private setTyped(block: Block): void {
    const [day, from, to] = this.slotFields;
    const s = parseLocal(block.start);
    const e = parseLocal(block.end);
    if (!day || !from || !to || !s) return;
    day.value = dateText(block.start.slice(0, 10));
    from.value = s.allDay ? "" : hm(s.wall);
    to.value = s.allDay || !e || e.allDay ? "" : hm(e.wall);
    day.dispatchEvent(new Event("input"));
  }

  /** A small field among `setting`'s controls, holding one thing (a day, a time), named inside while empty. */
  private small(setting: Setting, cls: string, name: string, value: string): HTMLInputElement {
    let el!: HTMLInputElement;
    setting.addText((c) => {
      el = c.inputEl;
      el.addClass(cls);
      el.spellcheck = false;
      c.setPlaceholder(name);
      c.setValue(value);
    });
    return el;
  }

  /**
   * The deadline: a day and a time, each in its field (no time: the day itself), saying below what it reads; the
   * calendar button fills both from a month view. Returns the day field.
   */
  private deadline(): HTMLInputElement {
    const setting = named(new Setting(this.form), "flag", t("modal.deadline"));
    const hint = setting.descEl;
    const due = this.task.due ? parseLocal(this.task.due) : null;
    const day = this.small(setting, "ct-when-day", t("picker.day"), this.task.due ? dateText(this.task.due.slice(0, 10)) : "");
    const time = this.small(setting, "ct-when-time", t("picker.time"), due && !due.allDay ? hm(due.wall) : "");
    this.dueFields = [day, time];
    const update = () => {
      const r = readFields({ day: day.value, time: time.value }, today());
      markFields(this.dueFields, r.error);
      this.task.due = !r.error && r.day ? dayValue(r.day, r.start) : null;
      hint.setText(r.error ? fieldsProblem(r.error) : this.task.due ? `→ ${shortDay(this.task.due, false)}` : "");
      hint.toggleClass("mod-warning", !!r.error);
      this.valid.due = !r.error;
      this.refreshPreview("due");
    };
    for (const el of this.dueFields) {
      el.addEventListener("input", update);
      // Clicking in a field shows the day of what it holds.
      el.addEventListener("focus", () => this.refreshPreview("due"));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) this.submit();
      });
    }
    if (this.task.due) update();
    setting.addExtraButton((b) =>
      b
        .setIcon("calendar")
        .setTooltip(t("modal.pickDate"))
        .onClick(() => new DatePickerModal(this.app, { mode: "due", value: this.task.due, pick: (value) => this.setDue(value) }).open()),
    );
    return day;
  }

  /**
   * Time blocks: those this form adds (tinted like in the preview, ✕ takes one off), then those already planned.
   * One goes in the list dragged on the preview, from the calendar button, or typed in its fields (a day, from, to;
   * no hours: the whole day), then Enter or +. Nothing reaches the calendar before the form is saved.
   */
  private slots(planned: TaskDraft["planned"]): void {
    const setting = named(new Setting(this.form), "clock", t("modal.blocks"));
    const hint = setting.descEl;
    const day = this.small(setting, "ct-when-day", t("picker.day"), "");
    const from = this.small(setting, "ct-when-time", t("picker.start"), "");
    setting.controlEl.createSpan({ cls: "ct-when-sep", text: "–" });
    const to = this.small(setting, "ct-when-time", t("picker.end"), "");
    this.slotFields = [day, from, to];
    const list = this.form.createDiv({ cls: "ct-slot-list" });
    const show = () => {
      list.empty();
      // A click on a slot shows its day beside.
      const showable = (row: HTMLElement, id: string, start: string | null) => {
        if (!start || !this.preview) return;
        row.dataset.id = id;
        row.addClass("is-showable");
        row.toggleClass("is-shown", this.shown === id);
        row.addEventListener("click", () => {
          this.shown = id;
          this.showOn(this.placed(), start);
        });
      };
      this.task.blocks.forEach((b, i) => {
        const row = list.createDiv({ cls: "ct-slot is-new" });
        showable(row, `block:${i}`, b.start);
        setIcon(row.createSpan({ cls: "ct-chip-icon" }), "clock");
        row.createSpan({ cls: "ct-slot-when", text: blockLabel(b) });
        const x = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("modal.remove") } });
        setIcon(x, "x");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.task.blocks.splice(i, 1);
          show();
          this.refreshPreview();
        });
      });
      planned.forEach(({ label, start }, i) => {
        const row = list.createDiv({ cls: "ct-slot is-planned" });
        showable(row, `planned:${i}`, start);
        setIcon(row.createSpan({ cls: "ct-chip-icon" }), "calendar-check");
        row.createSpan({ cls: "ct-slot-when", text: label });
      });
      list.toggleClass("is-empty", !list.childElementCount);
    };
    const read = () => readFields({ day: day.value, time: from.value, end: to.value }, today());
    const typed = () => {
      const r = read();
      return !r.error && r.day ? dayBlock(r.day, r.start, r.end) : null;
    };
    const update = () => {
      const r = read();
      const block = typed();
      markFields(this.slotFields, r.error);
      hint.setText(r.error ? fieldsProblem(r.error) : block ? t("modal.slotTyped", { when: blockLabel(block) }) : "");
      hint.toggleClass("mod-warning", !!r.error);
      this.valid.block = !r.error;
      this.refreshPreview("typed");
    };
    this.addBlock = (block: Block) => {
      this.task.blocks.push(block);
      show();
      this.refreshPreview(`block:${this.task.blocks.length - 1}`);
    };
    // Typed, then added: the fields empty for the next one.
    const add = (block: Block) => {
      for (const el of this.slotFields) el.value = "";
      update();
      this.addBlock(block);
    };
    for (const el of this.slotFields) {
      el.addEventListener("input", update);
      el.addEventListener("focus", () => this.refreshPreview("typed"));
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        const block = typed();
        if (block) add(block);
        else if (!this.slotFields.some((f) => f.value.trim())) this.submit();
      });
    }
    setting.addExtraButton((b) =>
      b
        .setIcon("plus")
        .setTooltip(t("modal.addBlock"))
        .onClick(() => {
          const block = typed();
          if (block) add(block);
          else day.focus();
        }),
    );
    setting.addExtraButton((b) =>
      b
        .setIcon("calendar")
        .setTooltip(t("modal.pickSlot"))
        .onClick(() => new DatePickerModal(this.app, { mode: "slot", value: typed(), pick: add }).open()),
    );
    // A slot typed but not added yet still counts when the form is saved.
    this.typedSlot = typed;
    this.redrawSlots = show;
    show();
  }

  private submit(): void {
    const title = this.task.title.trim();
    if (!title || !this.valid.due || !this.valid.block) return;
    this.close();
    // A repetition needs a date to start from: its first day from today.
    const due = this.task.due ?? (this.task.repeat ? formatLocalDate(firstDay(this.task.repeat, today())) : null);
    const typed = this.typedSlot();
    this.opts.submit({ ...this.task, title, due, blocks: typed ? [...this.task.blocks, typed] : this.task.blocks });
  }

  override onClose(): void {
    this.preview?.destroy();
    this.preview = null;
    this.contentEl.empty();
  }
}

/** Picks a repetition by typing it: "chaque lundi et jeudi", "tous les 3 jours", "toutes les 2 semaines"… */
export class RepeatPickerModal extends SuggestModal<{ label: string; rule: string }> {
  constructor(
    app: App,
    private readonly opts: { placeholder: string; pick: (rule: string) => void },
  ) {
    super(app);
    this.setPlaceholder(opts.placeholder);
  }

  getSuggestions(query: string): { label: string; rule: string }[] {
    const typed = `repeter ${query}`;
    const res = suggestAt(typed, today(), lang());
    if (!res) return [];
    const seen = new Set<string>();
    const out: { label: string; rule: string }[] = [];
    for (const i of res.items) {
      const rule = i.kind !== "more" ? i.when?.repeat : null;
      if (!rule || seen.has(rule)) continue;
      seen.add(rule);
      out.push({ label: (i.kind === "accept" ? typed : typed.slice(0, res.from) + i.text).replace(/^repeter\s*/, "").trim(), rule });
    }
    return out;
  }

  renderSuggestion(item: { label: string; rule: string }, el: HTMLElement): void {
    el.addClass("ct-date-suggestion");
    el.createSpan({ cls: "ct-date-suggestion-label", text: item.label });
    el.createSpan({ cls: "ct-date-suggestion-day", text: repeatLabel(item.rule, lang()) ?? item.rule });
  }

  onChooseSuggestion(item: { label: string; rule: string }): void {
    this.opts.pick(item.rule);
  }
}

/** Suggests the vault's tags for the word being typed in a tags field; picking one completes it (then `picked`). */
class TagSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly known: string[],
    private readonly picked: () => void,
  ) {
    super(app, input);
  }

  protected override getSuggestions(query: string): string[] {
    const word = /#?([^\s,#]*)$/.exec(query)?.[1]?.toLowerCase() ?? "";
    const typed = tagsOf(query.slice(0, query.length - word.length));
    return this.known.filter((tag) => tag.toLowerCase().includes(word) && !typed.some((x) => sameTag(x, tag))).slice(0, 20);
  }

  override renderSuggestion(tag: string, el: HTMLElement): void {
    el.setText(`#${tag}`);
  }

  override selectSuggestion(tag: string): void {
    const value = this.input.value.replace(/#?[^\s,#]*$/, "");
    this.setValue(`${value}#${tag} `);
    // Not an `input` event: it would open the suggestions again.
    this.picked();
    this.close();
  }
}
