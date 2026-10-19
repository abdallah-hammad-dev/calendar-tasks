import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { formRow } from "../ui/form-row";
import { menuSelect } from "../ui/menu-select";
import { renderWhenFields, type When } from "./when-fields";

export interface NewEventChoice {
  title: string;
  when: When;
  calendarUrl: string;
  taskUid: string | null;
}

/** What creating an event needs: when (the range selected), the calendars, the tasks it can be a work session for. */
export interface NewEventOptions {
  when: When;
  /** The times were changed in the form: show them on the calendar. */
  preview?: (when: When) => void;
  calendars: Record<string, string>;
  calendarUrl: string;
  tasks: { uid: string; title: string }[];
  submit: (choice: NewEventChoice) => void;
}

/**
 * The new event form: a title, when (to the minute), a calendar, or a task to block time for (spec §4.4). In the
 * calendar's popover next to the selected range, or in a modal (phones). `close` is called before `submit`.
 * Returns the title field.
 */
export function renderNewEventForm(el: HTMLElement, opts: NewEventOptions, close: () => void): HTMLInputElement {
  const choice: NewEventChoice = { title: "", when: opts.when, calendarUrl: opts.calendarUrl, taskUid: null };
  let valid = true;
  let create: HTMLButtonElement | null = null;
  const submit = () => {
    if (!valid) return;
    const task = opts.tasks.find((x) => x.uid === choice.taskUid);
    const title = choice.title.trim() || task?.title || "";
    if (!title) {
      input.focus();
      return;
    }
    close();
    opts.submit({ ...choice, title });
  };
  // Its placeholder names it (an aria-label would show as a tooltip over the next field).
  const input = el.createEl("input", { cls: "ct-task-title-input", type: "text", attr: { placeholder: t("modal.eventTitle") } });
  let fromTask = "";
  input.addEventListener("input", () => (choice.title = input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submit();
  });
  // One grid for every line: icon, name, field, in columns that line up.
  const grid = el.createDiv({ cls: "ct-form-grid" });
  renderWhenFields(grid, opts.when, (w) => {
    valid = !!w;
    if (create) create.disabled = !w;
    if (!w) return;
    choice.when = w;
    opts.preview?.(w);
  });
  menuSelect(formRow(grid, "calendar", t("modal.calendar")), {
    options: Object.entries(opts.calendars).map(([value, label]) => ({ value, label, icon: "calendar" })),
    value: choice.calendarUrl,
    onChange: (v) => (choice.calendarUrl = v),
  });
  if (opts.tasks.length) {
    menuSelect(formRow(grid, "check-square", t("modal.forTask")), {
      options: [{ value: "", label: t("modal.none") }, ...opts.tasks.map((x) => ({ value: x.uid, label: x.title, icon: "check-square" }))],
      value: "",
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
      b.setButtonText(t("modal.create")).setCta().onClick(submit);
      create = b.buttonEl;
    });
  return input;
}

/** The new event form in a modal (phones, where there's no room for a popover). `closed`: however it closes. */
export class NewEventModal extends Modal {
  constructor(
    app: App,
    private readonly opts: NewEventOptions,
    private readonly closed: () => void = () => undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("modal.newEvent"));
    this.modalEl.addClass("ct-task-modal");
    const input = renderNewEventForm(this.contentEl, this.opts, () => this.close());
    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
    this.closed();
  }
}

/** A question before something that can't be undone: what will happen, then Cancel and the action, in red. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: { title: string; lines: string[]; action: string; run: () => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.opts.title);
    for (const line of this.opts.lines) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("modal.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.opts.action)
          .setWarning()
          .onClick(() => {
            this.close();
            this.opts.run();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** One line of text (renaming an event). */
export class TextModal extends Modal {
  constructor(
    app: App,
    private readonly opts: { title: string; value: string; submit: (value: string) => void },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.opts.title);
    let value = this.opts.value;
    const done = () => {
      if (!value.trim()) return;
      this.close();
      this.opts.submit(value.trim());
    };
    new Setting(this.contentEl).addText((c) => {
      c.setValue(value).onChange((v) => (value = v));
      c.inputEl.style.width = "100%";
      c.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done();
      });
      window.setTimeout(() => c.inputEl.select(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("modal.cancel")).onClick(() => this.close()))
      .addButton((b) => b.setButtonText(t("modal.save")).setCta().onClick(done));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
