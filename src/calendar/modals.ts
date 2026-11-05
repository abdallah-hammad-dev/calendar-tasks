import { Modal, Platform, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { withUntil } from "../editor/when";
import { formRow } from "../ui/form-row";
import { menuSelect } from "../ui/menu-select";
import { readUntil, repeatOption, repeatOptions, splitRule, untilText } from "../ui/repeat";
import { formSheet } from "../ui/sheet";
import { typedLink } from "./meeting";
import { renderWhenFields, type When } from "./when-fields";

export interface EventChoice {
  title: string;
  when: When;
  /** The place, as typed ("" for none). */
  location: string;
  /** The video meeting's link, read from what was typed or pasted ("" for none). */
  meeting: string;
  calendarUrl: string;
  taskUid: string | null;
  /** How it comes back, ours (UNTIL: its last day); null: it doesn't. As it was unless the form changed it. */
  repeat: string | null;
}

/**
 * What the event form needs: when (the range selected, or the event's times), the collections, the tasks it can be
 * a work session for.
 */
export interface EventFormOptions {
  when: When;
  /** The times were changed in the form: show them on the calendar. */
  preview?: (when: When) => void;
  /** Gives the form what to call when its times are changed from outside (on the calendar). */
  follow?: (show: (when: When) => void) => void;
  calendars: Record<string, string>;
  calendarUrl: string;
  tasks: { uid: string; title: string }[];
  /** "Custom…" in the repetition's menu: a repetition typed (a picker), given to `pick`. */
  pickRepeat?: (pick: (rule: string) => void) => void;
  /**
   * Changing an event: what it holds now, and Save instead of Create. `series`: one occurrence of a series, which
   * stays in the series' collection (the series is one item), so the form doesn't offer another. `repeat`: the
   * series' rule, which the form changes for the whole series.
   */
  edit?: { title: string; location: string; meeting: string; taskUid: string | null; series: boolean; repeat: string | null };
  submit: (choice: EventChoice) => void;
}

/**
 * The event form, new or to change one (spec §7.1): a title, when (to the minute), the place, its video meeting's
 * link, a collection, or a
 * task to block time for (spec §4.4). In the calendar's popover next to the selected range or the event, or in a
 * modal (phones). `close` is called before `submit`. Returns the title field.
 */
export function renderEventForm(el: HTMLElement, opts: EventFormOptions, close: () => void): HTMLInputElement {
  const edit = opts.edit;
  const choice: EventChoice = {
    title: edit?.title ?? "",
    when: opts.when,
    location: edit?.location ?? "",
    meeting: edit?.meeting ?? "",
    calendarUrl: opts.calendarUrl,
    taskUid: edit?.taskUid ?? null,
    repeat: edit?.repeat ?? null,
  };
  // Its times, its last day and its meeting's link, each readable.
  const ok = { when: true, until: true, meeting: true };
  let valid = true;
  let create: HTMLButtonElement | null = null;
  const check = () => {
    valid = ok.when && ok.until && ok.meeting;
    if (create) create.disabled = !valid;
  };
  const submit = () => {
    if (!valid) return;
    const task = opts.tasks.find((x) => x.uid === choice.taskUid);
    const title = choice.title.trim() || task?.title || "";
    if (!title) {
      input.focus();
      return;
    }
    close();
    opts.submit({ ...choice, title, location: choice.location.trim() });
  };
  const enter = (field: HTMLInputElement) =>
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) submit();
    });
  // Its placeholder names it (an aria-label would show as a tooltip over the next field).
  const input = el.createEl("input", { cls: "ct-task-title-input", type: "text", attr: { placeholder: t("modal.eventTitle") } });
  input.value = choice.title;
  // The title its task gave it: picking another task renames it, a title of its own stays.
  let fromTask = opts.tasks.find((x) => x.uid === choice.taskUid)?.title === choice.title ? choice.title : "";
  input.addEventListener("input", () => (choice.title = input.value));
  enter(input);
  // One grid for every line: icon, name, field, in columns that line up.
  const grid = el.createDiv({ cls: "ct-form-grid" });
  let checkUntil = () => undefined as void;
  const when = renderWhenFields(grid, opts.when, (w) => {
    ok.when = !!w;
    if (w) choice.when = w;
    checkUntil();
    if (w) opts.preview?.(w);
  });
  opts.follow?.((w) => {
    ok.when = true;
    choice.when = w;
    when.set(w);
    checkUntil();
  });
  checkUntil = repeatRows(grid, choice, opts, (good) => {
    ok.until = good;
    check();
  });
  const place = formRow(grid, "map-pin", t("modal.place")).createEl("input", { cls: "ct-form-text", type: "text" });
  place.value = choice.location;
  place.spellcheck = false;
  place.addEventListener("input", () => (choice.location = place.value));
  enter(place);
  // The link alone, typed or pasted with its invitation's text: shown alone once the field is left.
  const link = formRow(grid, "video", t("modal.meeting")).createEl("input", {
    cls: "ct-form-text ct-form-link",
    type: "text",
    attr: { inputmode: "url", autocapitalize: "off", autocorrect: "off", placeholder: t("modal.meetingHint") },
  });
  link.value = choice.meeting;
  link.spellcheck = false;
  const readLink = () => {
    const url = typedLink(link.value);
    ok.meeting = url !== null;
    if (url !== null) choice.meeting = url;
    link.toggleClass("is-invalid", url === null);
    link.title = url === null ? t("modal.meetingInvalid") : "";
    check();
    return url;
  };
  link.addEventListener("input", readLink);
  link.addEventListener("change", () => {
    const url = readLink();
    if (url && url !== link.value.trim()) link.value = url;
  });
  enter(link);
  if (!edit?.series) {
    menuSelect(formRow(grid, "calendar", t("modal.calendar")), {
      options: Object.entries(opts.calendars).map(([value, label]) => ({ value, label, icon: "calendar" })),
      value: choice.calendarUrl,
      onChange: (v) => (choice.calendarUrl = v),
    });
  }
  if (opts.tasks.length) {
    menuSelect(formRow(grid, "check-square", t("modal.forTask")), {
      options: [{ value: "", label: t("modal.none") }, ...opts.tasks.map((x) => ({ value: x.uid, label: x.title, icon: "check-square" }))],
      value: choice.taskUid ?? "",
      onChange: (v) => {
        choice.taskUid = v || null;
        // The task names the event, unless a title of its own was typed.
        if (input.value.trim() && input.value !== fromTask) return;
        fromTask = opts.tasks.find((x) => x.uid === v)?.title ?? "";
        input.value = choice.title = fromTask;
      },
    });
  }
  new Setting(el)
    .setClass("ct-modal-buttons")
    .addButton((b) => b.setButtonText(t("modal.cancel")).onClick(close))
    .addButton((b) => {
      b.setButtonText(edit ? t("modal.save") : t("modal.create")).setCta().onClick(submit);
      create = b.buttonEl;
    });
  return input;
}

/**
 * How the event comes back, then its last day ("Until", a day field shown only while it repeats), in the form's
 * grid: `choice.repeat` is written again only when one of them changes. `valid` hears whether the day reads (and
 * isn't before the start). Returns what checks the day again (the start moved).
 */
function repeatRows(grid: HTMLElement, choice: EventChoice, opts: EventFormOptions, valid: (ok: boolean) => void): () => void {
  let { pattern, until } = splitRule(choice.repeat);
  const compose = () => (choice.repeat = pattern ? withUntil(pattern, until) : null);
  const menu = formRow(grid, "repeat", t("modal.repeat"));
  const field = formRow(grid, "calendar-x", t("modal.until"));
  // The row is three cells of the grid: its icon, its name, its field.
  const row = [field.previousElementSibling, field.previousElementSibling?.previousElementSibling, field].filter((x): x is HTMLElement => !!x);
  const input = field.createEl("input", { cls: "ct-when-day", type: "text", attr: { placeholder: t("picker.day") } });
  input.spellcheck = false;
  input.value = untilText(until);
  const read = (changed: boolean) => {
    const r = pattern ? readUntil(input.value, choice.when.start) : { until: null, error: null };
    input.toggleClass("is-invalid", !!r.error);
    input.title = r.error ?? "";
    if (changed && !r.error) {
      until = r.until;
      compose();
    }
    valid(!r.error);
  };
  const show = () => {
    for (const el of row) el.toggle(!!pattern);
    read(false);
  };
  input.addEventListener("input", () => read(true));
  const pick = opts.pickRepeat;
  const select = menuSelect(menu, {
    options: repeatOptions(pattern),
    value: pattern ?? "",
    onChange: (v) => {
      pattern = v || null;
      compose();
      show();
    },
    extra: pick && {
      label: t("modal.repeat.custom"),
      icon: "pencil",
      run: () =>
        pick((rule) => {
          const typed = splitRule(rule);
          pattern = typed.pattern;
          if (typed.until) input.value = untilText((until = typed.until));
          select.setValue(typed.pattern!, repeatOption(typed.pattern!).label);
          compose();
          show();
        }),
    },
  });
  show();
  return () => read(false);
}

/** The event form in a modal (phones, where there's no room for a popover). `closed`: however it closes. */
export class EventModal extends Modal {
  constructor(
    app: App,
    private readonly opts: EventFormOptions,
    private readonly closed: () => void = () => undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.opts.edit ? t("modal.editEvent") : t("modal.newEvent"));
    this.modalEl.addClass("ct-task-modal");
    const input = renderEventForm(this.contentEl, this.opts, () => this.close());
    formSheet(this);
    // On a phone an event opened to change it shows without the keyboard, which would cover its times.
    if (this.opts.edit && Platform.isMobile) return;
    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.closed();
  }
}

/**
 * A question before something that can't be undone: what will happen, then Cancel and the action, in red. Drawn as
 * Obsidian's own (its "Delete file?"): `mod-confirmation` on the container and `modal-button-container`, which on a
 * phone make it a sheet at the bottom, buttons across, the action over Cancel and no ✕ (2026-11-04: as a plain modal
 * it had Obsidian's ✕ beside Cancel on the user's iPhone, in the middle of the screen).
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: { title: string; lines: string[]; action: string; run: () => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.containerEl.addClass("mod-confirmation");
    this.setTitle(this.opts.title);
    for (const line of this.opts.lines) this.contentEl.createEl("p", { text: line });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { cls: "mod-cancel", text: t("modal.cancel") }).addEventListener("click", () => this.close());
    buttons.createEl("button", { cls: "mod-warning", text: this.opts.action }).addEventListener("click", () => {
      this.close();
      this.opts.run();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
