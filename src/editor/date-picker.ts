import { Modal, Platform, setIcon, type App } from "obsidian";
import { localZone, parseLocal, wallClock } from "../ical/time";
import { language, t } from "../i18n";
import { addDays, weekdayOf, type Ymd } from "./date-token";
import { dateText, dayBlock, dayValue, readFields, type Block, type FieldsError, type Hm } from "./when";

const key = (d: Ymd) => d.year * 10_000 + d.month * 100 + d.day;
const ymd = (d: Ymd): Ymd => ({ year: d.year, month: d.month, day: d.day });
const minutes = (h: Hm) => h.hour * 60 + h.minute;
const same = (a: Hm | null, b: Hm | null) => (a && b ? minutes(a) === minutes(b) : a === b);
/** "14h", "9h30": how the grammar writes a time. */
export const hm = (h: Hm) => `${h.hour}h${h.minute ? String(h.minute).padStart(2, "0") : ""}`;
const clock = (h: Hm) => `${String(h.hour).padStart(2, "0")}:${String(h.minute).padStart(2, "0")}`;
const at = (hour: number): Hm => ({ hour, minute: 0 });
const hourLater = (h: Hm): Hm => ({ hour: (h.hour + 1) % 24, minute: h.minute });

/** What's wrong in day / time fields, said under them. */
export function fieldsProblem(error: FieldsError): string {
  if (error === "day") return t("picker.dayInvalid");
  if (error === "time" || error === "end") return t("picker.timeInvalid");
  if (error === "noDay") return t("picker.dayMissing");
  if (error === "noStart") return t("picker.startMissing");
  return t("picker.endBefore");
}

/** Marks the field `error` is about: the day, the start (or the time), the end. */
export function markFields(fields: (HTMLInputElement | null | undefined)[], error: FieldsError | null): void {
  const [day, start, end] = fields;
  day?.toggleClass("mod-warning", error === "day" || error === "noDay");
  start?.toggleClass("mod-warning", error === "time" || error === "noStart");
  end?.toggleClass("mod-warning", error === "end" || error === "endBefore");
}

const QUICK_TIMES: Hm[] = [9, 12, 14, 18].map(at);
const QUICK_RANGES: [Hm, Hm][] = [
  [at(9), at(12)],
  [at(14), at(16)],
  [at(14), at(18)],
  [at(18), at(20)],
];

export type DatePick =
  /** A deadline: a day, with a time or not ("2026-10-23", "2026-10-23T14:00"); `remove` takes the one it has off. */
  | { mode: "due"; value?: string | null; pick: (value: string) => void; remove?: { label: string; run: () => void } }
  /** A time block: a day, from / to or the whole day. */
  | { mode: "slot"; value?: Block | null; pick: (block: Block) => void };

/**
 * A month calendar in Obsidian's colors (the system date picker looks foreign and opens in a corner of the
 * window), and a field for each thing: the day, then the time (deadline) or from / to (time block), each read on
 * its own; no time is the whole day. A day clicked fills the day, a quick time the hours. Enter, OK or a
 * double-click picks; arrows move the day (outside the fields), Page Up/Down the month.
 */
export class DatePickerModal extends Modal {
  private shown: { year: number; month: number };
  private day: Ymd | null;
  private time: Hm | null = null;
  private end: Hm | null = null;
  private dayInput: HTMLInputElement | null = null;
  private timeInputs: HTMLInputElement[] = [];
  private grid: HTMLElement | null = null;
  private heading: HTMLElement | null = null;
  private quick: { el: HTMLElement; time: Hm; end: Hm | null }[] = [];
  private summary: HTMLElement | null = null;
  private problem: string | null = null;
  private readonly today = ymd(wallClock(new Date(), localZone()));

  constructor(
    app: App,
    private readonly opts: DatePick,
  ) {
    super(app);
    const start = parseLocal((opts.mode === "due" ? opts.value : opts.value?.start) ?? "");
    this.day = start ? ymd(start.wall) : this.today;
    if (start && !start.allDay) {
      this.time = start.wall;
      const end = opts.mode === "slot" && opts.value ? parseLocal(opts.value.end) : null;
      this.end = end && !end.allDay ? end.wall : null;
    }
    this.shown = { year: this.day.year, month: this.day.month };
  }

  override onOpen(): void {
    const slot = this.opts.mode === "slot";
    this.modalEl.addClass("ct-date-picker");
    const head = this.contentEl.createDiv({ cls: "ct-dp-head" });
    const prev = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "‹" } });
    setIcon(prev, "chevron-left");
    this.heading = head.createDiv({ cls: "ct-dp-title" });
    const next = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "›" } });
    setIcon(next, "chevron-right");
    prev.addEventListener("click", () => this.moveMonth(-1));
    next.addEventListener("click", () => this.moveMonth(1));
    this.grid = this.contentEl.createDiv({ cls: "ct-dp-grid" });

    const when = this.contentEl.createDiv({ cls: "ct-dp-when" });
    const fields = when.createDiv({ cls: "ct-dp-fields" });
    const input = (parent: HTMLElement, placeholder: string, value: string) => {
      const el = parent.createEl("input", { type: "text", attr: { placeholder } });
      el.spellcheck = false;
      el.value = value;
      el.addEventListener("input", () => this.read());
      return el;
    };
    fields.createSpan({ cls: "ct-dp-label", text: t("picker.day") });
    this.dayInput = input(fields, t("picker.dayHint"), this.day ? dateText(dayValue(this.day, null)) : "");
    if (slot) {
      fields.createSpan({ cls: "ct-dp-label", text: t("picker.from") });
      const row = fields.createDiv({ cls: "ct-dp-range" });
      const from = input(row, t("picker.timeHint"), this.time ? hm(this.time) : "");
      row.createSpan({ cls: "ct-dp-label", text: t("picker.to") });
      const to = input(row, t("picker.endHint"), this.end ? hm(this.end) : "");
      this.timeInputs = [from, to];
    } else {
      fields.createSpan({ cls: "ct-dp-label", text: t("picker.time") });
      this.timeInputs = [input(fields, t("picker.timeHint"), this.time ? hm(this.time) : "")];
    }

    const chips = when.createDiv({ cls: "ct-dp-quick" });
    const choices: [Hm, Hm | null][] = slot ? QUICK_RANGES : QUICK_TIMES.map((q) => [q, null]);
    this.quick = choices.map(([time, end]) => {
      const el = chips.createEl("button", { cls: "ct-dp-quick-time", text: end ? `${hm(time)}–${hm(end)}` : hm(time) });
      el.addEventListener("click", () => {
        this.timeInputs[0]!.value = hm(time);
        if (end) this.timeInputs[1]!.value = hm(end);
        this.read();
      });
      return { el, time, end };
    });
    this.summary = when.createDiv({ cls: "ct-dp-summary" });

    const foot = this.contentEl.createDiv({ cls: "ct-dp-foot" });
    foot.createEl("button", { text: t("chip.today") }).addEventListener("click", () => this.setDay(this.today));
    const end = foot.createDiv({ cls: "ct-dp-foot-end" });
    const remove = this.opts.mode === "due" ? this.opts.remove : undefined;
    if (remove)
      end.createEl("button", { text: remove.label }).addEventListener("click", () => {
        this.close();
        remove.run();
      });
    end.createEl("button", { cls: "mod-cta", text: t("picker.ok") }).addEventListener("click", () => this.choose());

    // Keys move the day, except while typing.
    const typing = () => document.activeElement instanceof HTMLInputElement && this.contentEl.contains(document.activeElement);
    const move = (days: number) => () => {
      if (typing()) return true;
      this.setDay(addDays(this.day ?? this.today, days));
      return false;
    };
    this.scope.register([], "ArrowLeft", move(-1));
    this.scope.register([], "ArrowRight", move(1));
    this.scope.register([], "ArrowUp", move(-7));
    this.scope.register([], "ArrowDown", move(7));
    this.scope.register([], "PageUp", () => (this.moveMonth(-1), false));
    this.scope.register([], "PageDown", () => (this.moveMonth(1), false));
    this.scope.register([], "Enter", () => (this.choose(), false));
    this.read();
    // On a phone or a tablet the keyboard would cover the month, which is what the picker is opened for.
    if (Platform.isMobile) return;
    this.dayInput.focus();
    this.dayInput.select();
  }

  /** Reads the fields (`readFields`; here a day is needed); what's wrong is marked, said below, and blocks OK. */
  private read(): void {
    const fields = [this.dayInput, ...this.timeInputs];
    const [day, time, end] = fields.map((i) => i?.value ?? "");
    const r = readFields({ day: day ?? "", time: time ?? "", end }, this.today);
    this.day = r.day;
    this.time = r.start;
    this.end = r.end;
    const error = r.error ?? (r.day ? null : "noDay");
    markFields(fields, error);
    this.problem = error ? fieldsProblem(error) : null;
    if (this.day) this.shown = { year: this.day.year, month: this.day.month };
    this.render();
  }

  private setDay(day: Ymd): void {
    if (this.dayInput) this.dayInput.value = dateText(dayValue(day, null));
    this.read();
  }

  private moveMonth(n: number): void {
    const d = new Date(Date.UTC(this.shown.year, this.shown.month - 1 + n, 1));
    this.shown = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    this.render();
  }

  private choose(): void {
    if (this.problem || !this.day) {
      [this.dayInput, ...this.timeInputs].find((i) => i?.hasClass("mod-warning"))?.focus();
      return;
    }
    this.close();
    const o = this.opts;
    if (o.mode === "due") o.pick(dayValue(this.day, this.time));
    else o.pick(dayBlock(this.day, this.time, this.end));
  }

  private render(): void {
    const grid = this.grid;
    if (!grid || !this.heading) return;
    const lang = language();
    this.heading.setText(
      new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(this.shown.year, this.shown.month - 1, 1)),
      ),
    );
    grid.empty();
    // Monday first: 5 January 2026 was a Monday.
    for (let k = 0; k < 7; k++) {
      const name = new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5 + k)));
      grid.createDiv({ cls: "ct-dp-weekday", text: name.replace(/\.$/, "") });
    }
    const month = { ...this.shown, day: 1 };
    const start = addDays(month, -((weekdayOf(month) + 6) % 7));
    for (let k = 0; k < 42; k++) {
      const day = addDays(start, k);
      const cls = ["ct-dp-day"];
      if (day.month !== this.shown.month) cls.push("is-other-month");
      if (key(day) === key(this.today)) cls.push("is-today");
      if (this.day && key(day) === key(this.day)) cls.push("is-selected");
      const b = grid.createEl("button", { cls: cls.join(" "), text: String(day.day) });
      b.addEventListener("click", () => this.setDay(day));
      b.addEventListener("dblclick", () => this.choose());
    }

    for (const q of this.quick) q.el.toggleClass("is-active", same(this.time, q.time) && (!q.end || same(this.end, q.end)));
    if (!this.summary) return;
    this.summary.toggleClass("mod-warning", !!this.problem);
    if (this.problem || !this.day) {
      this.summary.setText(this.problem ?? "");
      return;
    }
    const d = this.day;
    let when = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(d.year, d.month - 1, d.day)),
    );
    // A block without an end lasts an hour.
    if (this.time) when += this.opts.mode === "slot" ? ` ${clock(this.time)}–${clock(this.end ?? hourLater(this.time))}` : ` ${clock(this.time)}`;
    else if (this.opts.mode === "slot") when += `, ${t("picker.allDay").toLowerCase()}`;
    this.summary.setText(`→ ${when}`);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
