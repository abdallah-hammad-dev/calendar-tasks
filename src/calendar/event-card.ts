import { Modal, setIcon, setTooltip, type App } from "obsidian";
import { t } from "../i18n";
import { CALENDAR_COLORS } from "./calendars";
import type { Occurrence } from "./expand";
import type { Meeting } from "./meeting";
import type { NewCalendar } from "../caldav/client";
import type { PartStat } from "./vevent";
import { localDate, localValue, renderWhenFields, shiftDays, type When } from "./when-fields";

export interface EventCardInfo {
  occ: Occurrence;
  calendar: { name: string; color: string } | null;
  /** The task a deadline or time block is for. */
  task: { title: string; done: boolean } | null;
  lang: string;
  /** Its times can be changed (not an invitation, not a read-only calendar). */
  editable: boolean;
  /** An event's note exists already: "Open the note", else "Create the note" (made on first open). */
  hasNote: boolean;
  /** Its last change made here: on the server, waiting to be pushed, or waiting while the server can't be reached. */
  sync: SyncState;
  /** What its pencil opens: the event's form, or its task's (a deadline, a work session); null: no pencil. */
  edit: "event" | "task" | null;
}

export type SyncState = "synced" | "queued" | "offline";

/** "Rejoindre Teams", or "Rejoindre la réunion" for a service we don't know. */
export function joinText(m: Meeting): string {
  return m.provider ? t("card.join", { provider: m.provider }) : t("card.joinMeeting");
}

/** Where a meeting link goes, for its tooltip: the host ("teams.microsoft.com"), not the long link. */
export function meetingHost(m: Meeting): string {
  return new URL(m.url).host;
}

/**
 * The line under the answer buttons (spec §7.1): nothing before an answer; after one, where it stands — still
 * here, on the server, then (when a backend relays it, X-CALTASKS-RSVP-STATE) on its way to the organizer, sent or failed.
 */
export function answerStatus(
  invitation: Occurrence["invitation"],
  sync: SyncState,
): { icon: string; text: string; failed?: boolean } | null {
  if (!invitation || invitation.partstat === "NEEDS-ACTION") return null;
  if (sync === "offline") return { icon: "cloud-off", text: t("card.answerOffline") };
  if (sync === "queued") return { icon: "clock", text: t("card.answerSending") };
  const relay = invitation.relay;
  if (relay?.startsWith("failed")) return { icon: "triangle-alert", text: t("view.rsvpFailed", { reason: relay.slice(7) || "?" }), failed: true };
  if (relay === "pending") return { icon: "clock", text: t("view.rsvpPending") };
  if (relay === "confirmed") return { icon: "check-check", text: t("card.answerRelayed") };
  return { icon: "check", text: t("card.answerSaved") };
}

/** The button that opens an occurrence's note: the task's, or the event's, which may not exist yet. */
export function openLabel(occ: Pick<Occurrence, "kind">, hasNote: boolean): { text: string; icon: string } {
  if (occ.kind !== "event") return { text: t("menu.openTask"), icon: "file-text" };
  return hasNote ? { text: t("menu.open"), icon: "file-text" } : { text: t("menu.createNote"), icon: "file-plus" };
}

export interface EventCardActions {
  /** The event's note, or the task's. */
  open(): void;
  toggleTask(): void;
  rsvp(partstat: PartStat): void;
  /** The form: the event's, or its task's (`EventCardInfo.edit`). */
  edit(): void;
  /** Every other action (delete…), in the context menu. */
  more(evt: MouseEvent): void;
  /** New times typed in the card (a deadline has no end). */
  move(when: When): void;
  close(): void;
}

/** A local value ("2026-10-20" or "2026-10-20T14:00") as a Date to format in UTC (no zone shifts). */
function utc(value: string): Date {
  const n = (a: number, b: number) => Number(value.slice(a, b));
  return new Date(Date.UTC(n(0, 4), n(5, 7) - 1, n(8, 10), value.length > 10 ? n(11, 13) : 0, value.length > 10 ? n(14, 16) : 0));
}

/** "mardi 20 octobre · 14:00 – 15:30", "lundi 19 – mercredi 21 octobre · Toute la journée", "mardi 20 octobre · 18:00". */
export function whenText(occ: Pick<Occurrence, "start" | "end" | "allDay">, lang: string): string {
  const day = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const start = utc(occ.start);
  if (occ.allDay) {
    const last = occ.end ? new Date(utc(occ.end).getTime() - 86_400_000) : start;
    const days = last.getTime() > start.getTime() ? day.formatRange(start, last) : day.format(start);
    return `${days} · ${t("card.allDay")}`;
  }
  if (!occ.end) return `${day.format(start)} · ${time.format(start)}`;
  const end = utc(occ.end);
  return occ.end.slice(0, 10) === occ.start.slice(0, 10)
    ? `${day.format(start)} · ${time.format(start)} – ${time.format(end)}`
    : `${day.format(start)} ${time.format(start)} – ${day.format(end)} ${time.format(end)}`;
}

/**
 * What a click on an event shows (spec §7.1): when, where, which calendar, the task it's for (a deadline can be
 * ticked here), the answer to an invitation, and a button to open its note. Its pencil opens the event's form (or
 * its task's); other actions are in "…".
 */
export function renderEventCard(el: HTMLElement, info: EventCardInfo, actions: EventCardActions): void {
  const { occ } = info;
  el.addClass("ct-card");
  if (info.calendar) el.style.setProperty("--ct-ev-color", info.calendar.color);

  const head = el.createDiv({ cls: "ct-card-head" });
  head.createDiv({ cls: "ct-card-swatch" });
  const title = head.createDiv({ cls: "ct-card-title", text: occ.title });
  if (occ.kind === "deadline" && info.task?.done) title.addClass("is-done");
  const tools = head.createDiv({ cls: "ct-card-tools" });
  const tool = (icon: string, label: string, run: (e: MouseEvent) => void) => {
    const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", run);
  };
  if (info.edit) tool("pencil", info.edit === "task" ? t("card.editTask") : t("card.edit"), () => actions.edit());
  tool("more-horizontal", t("card.more"), (e) => actions.more(e));
  tool("x", t("modal.cancel"), () => actions.close());

  const rows = el.createDiv({ cls: "ct-card-rows" });
  const row = (icon: string, text: string) => {
    const r = rows.createDiv({ cls: "ct-card-row" });
    setIcon(r.createSpan({ cls: "ct-card-icon" }), icon);
    r.createSpan({ cls: "ct-card-text", text });
    return r;
  };
  const when = row(occ.kind === "deadline" ? "flag" : "clock", `${occ.kind === "deadline" ? `${t("card.deadline")} · ` : ""}${whenText(occ, info.lang)}`);
  if (info.editable) {
    when.addClass("is-editable");
    setIcon(when.createSpan({ cls: "ct-card-edit" }), "pencil");
    setTooltip(when, t("card.editTime"));
    when.addEventListener("click", () => editWhen(when, occ, actions));
  }
  if (occ.recurring) row("repeat", t("card.repeats"));
  if (occ.meeting) {
    const url = occ.meeting.url;
    const r = row("video", joinText(occ.meeting));
    r.addClass("is-link");
    setTooltip(r, meetingHost(occ.meeting));
    r.addEventListener("click", () => window.open(url));
  }
  if (occ.location) row("map-pin", occ.location);
  if (info.calendar) row("calendar", info.calendar.name);
  if (occ.kind === "timeblock" && info.task) {
    const r = row("check-square", `${t("card.blockFor")} ${info.task.title}`);
    r.addClass("is-link");
    r.addEventListener("click", () => actions.open());
  }
  if (occ.kind === "deadline" && info.task) {
    const r = rows.createEl("label", { cls: "ct-card-row ct-card-check" });
    const box = r.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
    box.checked = info.task.done;
    box.addEventListener("change", () => {
      title.toggleClass("is-done", box.checked);
      actions.toggleTask();
    });
    r.createSpan({ cls: "ct-card-text", text: t("card.done") });
  }
  if (occ.invitation) {
    const r = rows.createDiv({ cls: "ct-card-row ct-card-rsvp" });
    setIcon(r.createSpan({ cls: "ct-card-icon" }), "mail");
    const body = r.createDiv({ cls: "ct-card-rsvp-body" });
    const seg = body.createDiv({ cls: "ct-segmented" });
    const status = body.createDiv({ cls: "ct-card-status" });
    const showStatus = (s: ReturnType<typeof answerStatus>) => {
      status.empty();
      status.toggle(!!s);
      status.toggleClass("is-failed", !!s?.failed);
      if (!s) return;
      setIcon(status.createSpan({ cls: "ct-card-icon" }), s.icon);
      status.createSpan({ text: s.text });
    };
    showStatus(answerStatus(occ.invitation, info.sync));
    const answers: [PartStat, string][] = [
      ["ACCEPTED", t("menu.accept")],
      ["TENTATIVE", t("menu.maybe")],
      ["DECLINED", t("menu.decline")],
    ];
    const buttons = answers.map(([ps, label]) => {
      const b = seg.createEl("button", { text: label, cls: occ.invitation?.partstat === ps ? "is-active" : "" });
      b.addEventListener("click", () => {
        for (const x of buttons) x.removeClass("is-active");
        b.addClass("is-active");
        // On its way until the calendar draws the card again from the cache (right after, and once it's pushed).
        showStatus(answerStatus({ partstat: ps }, "queued"));
        actions.rsvp(ps);
      });
      return b;
    });
  }

  const foot = el.createDiv({ cls: "ct-card-foot" });
  const label = openLabel(occ, info.hasNote);
  const open = foot.createEl("button", { cls: "mod-cta ct-card-open" });
  setIcon(open.createSpan({ cls: "ct-card-open-icon" }), label.icon);
  open.createSpan({ text: label.text });
  open.addEventListener("click", () => actions.open());
}

/** The card's time line becomes start and end fields, to the minute: Save (or Enter) moves the event there. */
function editWhen(line: HTMLElement, occ: Occurrence, actions: EventCardActions): void {
  const end = occ.end ?? (occ.allDay ? shiftDays(occ.start, 1) : localValue(new Date(localDate(occ.start).getTime() + 3_600_000), false));
  let value: When | null = { start: occ.start, end: occ.kind === "deadline" ? null : end, allDay: occ.allDay };
  const box = createDiv({ cls: "ct-card-when" });
  // While the time changes, Save is the one main button: the card's own goes until then.
  const foot = line.closest(".ct-card")?.querySelector<HTMLElement>(".ct-card-foot");
  foot?.hide();
  line.replaceWith(box);
  const save = () => value && actions.move(value);
  const first = renderWhenFields(box, value, (w) => {
    value = w;
    ok.disabled = !w;
  });
  const buttons = box.createDiv({ cls: "ct-card-when-buttons" });
  buttons.createEl("button", { text: t("modal.cancel") }).addEventListener("click", () => {
    box.replaceWith(line);
    foot?.show();
  });
  const ok = buttons.createEl("button", { cls: "mod-cta", text: t("modal.save") });
  ok.addEventListener("click", save);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
  first.focus();
}

export interface TaskGroupInfo {
  /** Deadlines of one day, close in time, sorted. */
  occs: Occurrence[];
  color: string | null;
  lang: string;
  task(uid: string): { title: string; done: boolean } | null;
}

/** Deadlines too close to be drawn apart: "3 tasks", the day, then each with its checkbox, title and time. */
export function renderTaskGroup(
  el: HTMLElement,
  info: TaskGroupInfo,
  actions: { toggleTask(uid: string): void; open(occ: Occurrence): void; close(): void },
): void {
  el.addClass("ct-card");
  if (info.color) el.style.setProperty("--ct-ev-color", info.color);
  const head = el.createDiv({ cls: "ct-card-head" });
  head.createDiv({ cls: "ct-card-swatch" });
  head.createDiv({ cls: "ct-card-title", text: t("view.tasks", { n: info.occs.length }) });
  const x = head.createDiv({ cls: "ct-card-tools" }).createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("modal.cancel") } });
  setIcon(x, "x");
  x.addEventListener("click", () => actions.close());

  const rows = el.createDiv({ cls: "ct-card-rows" });
  const day = rows.createDiv({ cls: "ct-card-row" });
  setIcon(day.createSpan({ cls: "ct-card-icon" }), "flag");
  const first = info.occs[0]!;
  day.createSpan({ cls: "ct-card-text", text: `${t("card.deadline")} · ${whenText({ ...first, allDay: true, end: null }, info.lang).split(" · ")[0]}` });
  const list = el.createDiv({ cls: "ct-card-tasks" });
  for (const occ of info.occs) {
    const done = (occ.taskUid ? info.task(occ.taskUid)?.done : undefined) ?? occ.done;
    const r = list.createDiv({ cls: "ct-card-task" });
    const box = r.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
    box.checked = done;
    const name = r.createSpan({ cls: `ct-card-task-name${done ? " is-done" : ""}`, text: occ.title });
    box.addEventListener("change", () => {
      name.toggleClass("is-done", box.checked);
      if (occ.taskUid) actions.toggleTask(occ.taskUid);
    });
    name.addEventListener("click", () => actions.open(occ));
    r.createSpan({ cls: "ct-card-task-time", text: occ.start.slice(11, 16) });
  }
}

export interface CalendarCardInfo {
  name: string;
  color: string;
  readOnly: boolean;
  hidden: boolean;
}

/** The palette, the current color ringed. `pick` gets the color clicked, and `ring` to ring another one back. */
function palette(rows: HTMLElement, color: string, pick: (color: string, ring: (color: string) => void) => void): void {
  const row = rows.createDiv({ cls: "ct-card-row ct-cal-colors" });
  setIcon(row.createSpan({ cls: "ct-card-icon" }), "palette");
  const same = (a: string, b: string) => a.slice(0, 7).toLowerCase() === b.slice(0, 7).toLowerCase();
  const buttons = CALENDAR_COLORS.map((c) => {
    const b = row.createEl("button", { cls: "ct-cal-color", attr: { "aria-label": `${t("cal.color")} ${c}` } });
    b.style.setProperty("--ct-swatch", c);
    b.addEventListener("click", () => {
      ring(c);
      pick(c, ring);
    });
    return [c, b] as const;
  });
  const ring = (c: string) => {
    for (const [x, b] of buttons) b.toggleClass("is-active", same(x, c));
  };
  ring(color);
}

/**
 * A calendar's card: its name (editable), what it holds, its color, whether it's shown, and Delete. Name and color
 * are written on the server, so every device shows the same. Returns the function that saves a name still being
 * typed (call it when the card closes).
 */
export function renderCalendarCard(
  el: HTMLElement,
  info: CalendarCardInfo,
  actions: {
    rename(name: string): Promise<boolean>;
    recolor(color: string): Promise<boolean>;
    toggle(): void;
    /** Asks, then deletes it from the server. */
    remove(): void;
    close(): void;
  },
): () => void {
  el.addClass("ct-card");
  el.addClass("ct-cal-card");
  let { name, color } = info;
  const paint = (c: string) => el.style.setProperty("--ct-ev-color", c.slice(0, 7));
  paint(color);

  const head = el.createDiv({ cls: "ct-card-head" });
  head.createDiv({ cls: "ct-card-swatch" });
  let input: HTMLInputElement | null = null;
  if (info.readOnly) head.createDiv({ cls: "ct-card-title", text: name });
  else {
    input = head.createEl("input", { cls: "ct-cal-name", type: "text", attr: { placeholder: t("cal.name") } });
    input.value = name;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    input.addEventListener("change", () => commit());
  }
  const x = head.createDiv({ cls: "ct-card-tools" }).createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("modal.cancel") } });
  setIcon(x, "x");
  x.addEventListener("click", () => actions.close());

  const rows = el.createDiv({ cls: "ct-card-rows" });

  if (!info.readOnly) {
    palette(rows, color, (c, ring) => {
      const before = color;
      color = c;
      paint(c);
      void actions.recolor(c).then((ok) => {
        if (ok) return;
        color = before;
        paint(before);
        ring(before);
      });
    });
  }

  const shown = rows.createDiv({ cls: "ct-card-row ct-cal-shown" });
  setIcon(shown.createSpan({ cls: "ct-card-icon" }), "eye");
  shown.createSpan({ cls: "ct-card-text", text: t("cal.shown") });
  const toggle = shown.createDiv({ cls: `checkbox-container${info.hidden ? "" : " is-enabled"}` });
  toggle.createEl("input", { type: "checkbox" });
  shown.addEventListener("click", (e) => {
    e.preventDefault();
    toggle.toggleClass("is-enabled", !toggle.hasClass("is-enabled"));
    actions.toggle();
  });

  if (info.readOnly) el.createDiv({ cls: "ct-cal-note", text: t("cal.readOnly") });
  if (!info.readOnly) {
    const remove = el.createDiv({ cls: "ct-card-foot" }).createEl("button", { cls: "mod-warning", text: t("cal.delete") });
    remove.addEventListener("click", () => actions.remove());
  }

  function commit(): void {
    const typed = input?.value.trim() ?? "";
    if (!typed || typed === name) return;
    const before = name;
    name = typed;
    void actions.rename(typed).then((ok) => {
      if (ok) return;
      name = before;
      if (input) input.value = before;
    });
  }
  if (input) {
    const box = input;
    window.setTimeout(() => box.select(), 0);
  }
  return commit;
}

/**
 * A new collection on the server: its name and its color (one not used yet). It holds events and tasks, like a
 * context ("Pro", "École"). Create closes it once the server made it.
 */
export function renderNewCalendarCard(
  el: HTMLElement,
  taken: string[],
  actions: { create(spec: NewCalendar): Promise<boolean>; close(): void },
): HTMLInputElement {
  el.addClass("ct-card");
  el.addClass("ct-cal-card");
  const used = new Set(taken.map((c) => c.slice(0, 7).toLowerCase()));
  let color = CALENDAR_COLORS.find((c) => !used.has(c.toLowerCase())) ?? CALENDAR_COLORS[0]!;
  const paint = (c: string) => el.style.setProperty("--ct-ev-color", c);
  paint(color);

  const head = el.createDiv({ cls: "ct-card-head" });
  head.createDiv({ cls: "ct-card-swatch" });
  const input = head.createEl("input", { cls: "ct-cal-name", type: "text", attr: { placeholder: t("cal.newName") } });
  const x = head.createDiv({ cls: "ct-card-tools" }).createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("modal.cancel") } });
  setIcon(x, "x");
  x.addEventListener("click", () => actions.close());

  const rows = el.createDiv({ cls: "ct-card-rows" });
  palette(rows, color, (c) => {
    color = c;
    paint(c);
  });

  const foot = el.createDiv({ cls: "ct-card-foot" });
  foot.createEl("button", { text: t("modal.cancel") }).addEventListener("click", () => actions.close());
  const create = foot.createEl("button", { cls: "mod-cta", text: t("modal.create") });
  const ready = () => (create.disabled = !input.value.trim());
  ready();
  const submit = () => {
    const name = input.value.trim();
    if (!name || create.hasClass("is-busy")) return;
    create.addClass("is-busy");
    void actions.create({ displayName: name, color, components: ["VEVENT", "VTODO"] }).then((ok) => {
      create.removeClass("is-busy");
      if (ok) actions.close();
    });
  };
  input.addEventListener("input", ready);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) submit();
  });
  create.addEventListener("click", submit);
  return input;
}

/**
 * A card in a modal (phones: no room for a popover). `render` gets the box and how to close it; what it returns
 * runs when the modal closes.
 */
export class CardModal extends Modal {
  private done: (() => void) | null = null;

  constructor(
    app: App,
    private readonly render: (el: HTMLElement, close: () => void) => void | (() => void),
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("ct-card-modal");
    this.done = this.render(this.contentEl, () => this.close()) ?? null;
  }

  override onClose(): void {
    this.done?.();
    this.contentEl.empty();
  }
}
