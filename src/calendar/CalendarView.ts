import { Calendar, type DayHeaderContentArg, type EventContentArg, type EventInput } from "@fullcalendar/core";
import frLocale from "@fullcalendar/core/locales/fr";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import timeGridPlugin from "@fullcalendar/timegrid";
import { ItemView, Platform, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { PRIORITY_MARK, type Priority } from "../constants";
import { t, type StringKey } from "../i18n";
import type { NewCalendar } from "../caldav/client";
import { CardModal, renderCalendarCard, renderEventCard, renderNewCalendarCard, renderTaskGroup, type EventCardActions, type EventCardInfo } from "./event-card";
import { closeDeadlines, type Occurrence } from "./expand";
import { NewEventModal, renderNewEventForm, type NewEventOptions } from "./modals";
import type { PartStat } from "./vevent";
import { localDate, type When } from "./when-fields";

export const CALENDAR_VIEW = "calendar-tasks-calendar";

export interface CalendarEntry {
  url: string;
  name: string;
  color: string;
  hidden: boolean;
  readOnly: boolean;
}

/** What the view needs from the plugin. */
export interface CalendarHost {
  occurrences(from: Date, to: Date): Occurrence[];
  calendars(): CalendarEntry[];
  toggleCalendar(url: string): void;
  /** Renames or recolors a calendar on the server; false (with a notice) when that failed. */
  updateCalendar(url: string, changes: { displayName?: string; color?: string }): Promise<boolean>;
  /** Creates a collection on the server; false (with a notice) when that failed. */
  createCalendar(spec: NewCalendar): Promise<boolean>;
  /** Asks, then deletes a collection and everything in it from the server. */
  deleteCalendar(url: string): void;
  /** Opens the event's note, or the task's for a deadline or time block. */
  open(occ: Occurrence): void;
  sync(): void;
  language(): string;
  /** Date to open on (default: today). */
  initialDate?(): string;
  /** Can this occurrence be dragged / resized? */
  editable(occ: Occurrence): boolean;
  /** Drag or resize; false puts the event back. */
  move(occ: Occurrence, start: Date, end: Date | null, allDay: boolean): Promise<boolean>;
  /** A range was selected: what creating an event there needs, or null (a notice says why). */
  newEvent(start: Date, end: Date, allDay: boolean): NewEventOptions | null;
  /** Every action on an occurrence (rename, delete, answer…), as a menu at the mouse. */
  menu(occ: Occurrence, evt: MouseEvent): void;
  /** The task a deadline or time block is for. */
  task(uid: string): { title: string; done: boolean } | null;
  toggleTask(uid: string): void;
  rsvp(occ: Occurrence, partstat: PartStat): void;
  /** Open tasks with no time block ahead, for the "To plan" panel. */
  /** Open tasks for the panel, with their number of time blocks this week or later. */
  planTasks(): { path: string; title: string; priority: Priority | null; due: { text: string; overdue: boolean } | null; blocks: number }[];
  /** The panel shows only tasks with no time block. */
  planUnplannedOnly(): boolean;
  setPlanUnplannedOnly(on: boolean): void;
  /** A task from the panel was dropped on the calendar: block time for it there. */
  plan(path: string, start: Date, allDay: boolean): void;
  /** Ask when to block time for a task. */
  pickSlot(path: string): void;
  newTask(): void;
  planPanelOpen(): boolean;
  setPlanPanelOpen(open: boolean): void;
  /** The view last shown ("timeGridWeek"…), kept across sessions. */
  savedView(): string | null;
  saveView(type: string): void;
}

const VIEWS: [string, StringKey][] = [
  ["dayGridMonth", "view.month"],
  ["timeGridWeek", "view.week"],
  ["timeGridDay", "view.day"],
  ["listWeek", "view.list"],
];

/** "14:00" from a local value. */
const hm = (value: string) => value.slice(11, 16);
/** "14:05" from a Date (FullCalendar works in the local zone). */
const clock = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Dragging and resizing move by 5 minutes, like Apple Calendar. */
const SNAP_MS = 5 * 60_000;
/** A deadline is a moment, drawn as a one-line marker this long; closer deadlines share one marker. */
const MARK_MS = 20 * 60_000;
/** An hour's height in the week and day views, in pixels (26 per half hour by default); pinch or Ctrl + wheel. */
const ZOOM = { min: 26, max: 312, base: 52, step: 1.4 };
const ZOOM_KEY = "calendar-tasks-zoom";

/** Half and quarter hours are written fainter than the hours. */
const minorLabels = (arg: { date: Date }) => (arg.date.getMinutes() ? ["ct-slot-minor"] : []);

/** Finer lines and more hours written as the hours get taller. */
function slotOptions(zoom: number): { slotDuration: string; slotLabelInterval: string } {
  return {
    slotDuration: zoom >= 104 ? "00:15:00" : "00:30:00",
    slotLabelInterval: zoom >= 208 ? "00:15:00" : zoom >= 104 ? "00:30:00" : "01:00:00",
  };
}

/**
 * The calendar (spec §7.1): FullCalendar for the grid and its interactions, fed from the local cache (works
 * offline, shows note-less events); everything around and inside it drawn by us in Obsidian's style: the toolbar,
 * the events, the day headers, and the popovers (new event beside the selection, an event's card on click).
 */
export class CalendarView extends ItemView {
  private calendar: Calendar | null = null;
  private toolbar: HTMLElement | null = null;
  private legend: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private draggable: Draggable | null = null;
  private popover: { el: HTMLElement; kind: PopoverKind; closed: () => void } | null = null;
  /** The "To plan" tasks, read once per refresh (the toolbar shows their count, the panel lists them). */
  private toPlan: ReturnType<CalendarHost["planTasks"]> = [];
  /** An occurrence to blink once it's drawn (`reveal`). */
  private revealing: string | null = null;
  /** Whether the last fetch grouped close deadlines (week and day views only). */
  private grouped = true;
  /** An hour's height (see ZOOM), and the one waiting for the next frame. */
  private zoom = ZOOM.base;
  private pendingZoom: { zoom: number; y: number | undefined } | null = null;
  /** The selection is being moved to the times typed in the new event form (not a new selection). */
  private reselecting = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CalendarHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CALENDAR_VIEW;
  }

  getDisplayText(): string {
    return t("view.calendar");
  }

  override getIcon(): string {
    return "calendar";
  }

  private views(): [string, StringKey][] {
    // A week of columns doesn't fit a phone.
    return Platform.isPhone ? VIEWS.filter(([type]) => type !== "timeGridWeek") : VIEWS;
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ct-calendar");
    this.toolbar = root.createDiv({ cls: "ct-cal-bar" });
    this.legend = root.createDiv({ cls: "ct-calendar-legend" });
    const body = root.createDiv({ cls: "ct-calendar-body" });
    const grid = body.createDiv({ cls: "ct-calendar-grid" });
    this.panel = body.createDiv({ cls: "ct-plan" });
    // Tasks dragged from the panel: FullCalendar reports the drop, the host blocks time there.
    this.draggable = new Draggable(this.panel, {
      itemSelector: ".ct-plan-item",
      eventData: (el) => ({ title: el.dataset.title ?? "", create: false, duration: "01:00" }),
    });
    const saved = this.host.savedView();
    const initialView = saved && this.views().some(([type]) => type === saved) ? saved : Platform.isPhone ? "listWeek" : "timeGridWeek";
    this.zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, Number(this.app.loadLocalStorage(ZOOM_KEY)) || ZOOM.base));
    root.style.setProperty("--ct-slot-h", `${this.slotHeight()}px`);
    this.calendar = new Calendar(grid, {
      plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
      headerToolbar: false,
      footerToolbar: false,
      editable: true,
      droppable: true,
      drop: (info) => {
        const path = info.draggedEl.dataset.path;
        if (path) this.host.plan(path, info.date, info.allDay);
      },
      selectable: true,
      selectMirror: true,
      // The selection stays while its form is open; clicking in the form (or a menu it opens) keeps it.
      unselectCancel: ".ct-popover, .menu",
      select: (info) => {
        if (this.reselecting) return;
        // A click (no drag) selects one 5-minute step: make it an hour from the half hour clicked.
        if (!info.allDay && info.end.getTime() - info.start.getTime() <= SNAP_MS) {
          const start = new Date(info.start);
          start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
          this.calendar?.select({ start, end: new Date(start.getTime() + 60 * 60_000), allDay: false });
          return;
        }
        const found = this.host.newEvent(info.start, info.end, info.allDay);
        const opts = found && { ...found, preview: (w: When) => this.reselect(w) };
        if (!opts) this.calendar?.unselect();
        else if (Platform.isPhone) new NewEventModal(this.app, opts, () => this.calendar?.unselect()).open();
        else this.newEventPopover(opts);
      },
      unselect: () => {
        if (this.popover?.kind === "new") this.closePopover();
      },
      eventDrop: (info) =>
        void this.host
          .move(info.event.extendedProps.occ as Occurrence, info.event.start!, info.event.end, info.event.allDay)
          .then((ok) => ok || info.revert()),
      eventResize: (info) =>
        void this.host
          .move(info.event.extendedProps.occ as Occurrence, info.event.start!, info.event.end, info.event.allDay)
          .then((ok) => ok || info.revert()),
      initialView,
      ...(this.host.initialDate ? { initialDate: this.host.initialDate() } : {}),
      ...(this.host.language().startsWith("fr") ? { locale: frLocale } : {}),
      firstDay: 1,
      height: "100%",
      nowIndicator: true,
      // As in Apple Calendar: a day's header (or number, in the month) opens that day, a week's number that week. Our
      // toolbar isn't FullCalendar's, so its own pick for "day" would be the agenda-like dayGridDay.
      navLinks: true,
      navLinkDayClick: "timeGridDay",
      navLinkWeekClick: "timeGridWeek",
      weekNumbers: true,
      weekNumberContent: (arg) => t("view.weekShort", { n: arg.num ?? "" }),
      scrollTime: "08:00:00",
      snapDuration: SNAP_MS,
      ...slotOptions(this.zoom),
      slotLabelClassNames: minorLabels,
      eventMinHeight: 20,
      allDayText: t("view.allDay"),
      dayMaxEvents: true,
      slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      events: (info, success) => success(this.inputs(info.start, info.end)),
      eventContent: (arg) => this.eventContent(arg),
      dayHeaderContent: (arg) => this.dayHeader(arg),
      datesSet: (arg) => {
        this.closePopover();
        this.host.saveView(arg.view.type);
        this.renderToolbar();
        // Switching between the agenda and the week (same dates) doesn't refetch: regroup the deadlines.
        if (arg.view.type.startsWith("timeGrid") !== this.grouped) this.calendar?.refetchEvents();
      },
      eventClick: (arg) => {
        arg.jsEvent.preventDefault();
        const occ = arg.event.extendedProps.occ as Occurrence | undefined;
        const group = arg.event.extendedProps.group as Occurrence[] | undefined;
        if (occ) this.showCard(occ, arg.el);
        else if (group) this.showGroup(group, arg.el);
      },
      eventDidMount: (arg) => {
        const color = arg.event.extendedProps.color as string | undefined;
        const group = arg.event.extendedProps.group as Occurrence[] | undefined;
        if (group) {
          if (color) arg.el.style.setProperty("--ct-ev-color", color);
          setTooltip(arg.el, [t("view.tasks", { n: group.length }), ...group.map((o) => `${hm(o.start)}  ${o.title}`)].join("\n"));
          return;
        }
        // The selection's mirror (and a task dragged from the panel) is drawn as an event without an occurrence.
        const occ = arg.event.extendedProps.occ as Occurrence | undefined;
        if (!occ) return;
        arg.el.dataset.occ = occ.id;
        if (this.revealing === occ.id) this.blink(arg.el);
        if (color) arg.el.style.setProperty("--ct-ev-color", color);
        // The agenda shows a deadline's moment, not the marker it's drawn as.
        if (occ.kind === "deadline" && !occ.allDay) arg.el.querySelector(".fc-list-event-time")?.setText(hm(occ.start));
        const relay = occ.invitation?.relay;
        const relayText = relay ? (relay.startsWith("failed") ? t("view.rsvpFailed", { reason: relay.slice(7) || "?" }) : relay === "pending" ? t("view.rsvpPending") : "") : "";
        const kind = occ.kind === "deadline" ? t("key.deadline") : occ.kind === "timeblock" ? t("key.block") : "";
        setTooltip(arg.el, [occ.title, kind, occ.location, relayText].filter(Boolean).join("\n"));
        arg.el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.host.menu(occ, e);
        });
      },
    });
    this.toPlan = this.host.planTasks();
    this.renderPanel(); // before rendering, so the grid is sized next to an open panel
    this.calendar.render();
    this.renderToolbar();
    this.renderLegend();
    this.registerEvent(this.app.workspace.on("resize", () => this.calendar?.updateSize()));
    // Zoom on the hours: Ctrl (⌘) + wheel, which is also what a trackpad pinch sends, or two fingers on a screen.
    this.registerDomEvent(
      grid,
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || !this.calendar?.view.type.startsWith("timeGrid")) return;
        e.preventDefault();
        // A pinch sends small steps that follow the fingers; a wheel notch (any screen density) counts as one step.
        this.zoomTo((this.pendingZoom?.zoom ?? this.zoom) * Math.exp(-Math.max(-20, Math.min(20, e.deltaY)) / 100), e.clientY);
      },
      { passive: false },
    );
    let pinch: { dist: number; zoom: number } | null = null;
    const spread = (e: TouchEvent) => Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);
    this.registerDomEvent(grid, "touchstart", (e) => {
      pinch = e.touches.length === 2 && this.calendar?.view.type.startsWith("timeGrid") ? { dist: spread(e), zoom: this.zoom } : null;
    });
    this.registerDomEvent(
      grid,
      "touchmove",
      (e) => {
        if (!pinch || e.touches.length !== 2 || !pinch.dist) return;
        e.preventDefault();
        this.zoomTo((pinch.zoom * spread(e)) / pinch.dist, (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2);
      },
      { passive: false },
    );
    this.registerDomEvent(grid, "touchend", (e) => {
      if (e.touches.length < 2) pinch = null;
    });
    // An event's card closes on a click elsewhere (the new event popover closes with its selection), and on Escape.
    this.registerDomEvent(document, "mousedown", (e) => {
      const target = e.target as HTMLElement | null;
      if (!this.popover || this.popover.kind === "new" || !target || this.popover.el.contains(target) || target.closest(".menu, .modal-container")) return;
      this.closePopover();
    });
    this.registerDomEvent(window, "keydown", (e) => {
      if (e.key !== "Escape" || !this.popover || document.querySelector(".menu, .modal-container")) return;
      e.preventDefault();
      this.closePopover();
    });
  }

  override async onClose(): Promise<void> {
    this.closePopover();
    this.draggable?.destroy();
    this.draggable = null;
    this.calendar?.destroy();
    this.calendar = null;
  }

  /** What the user is looking at, for Claude's context. */
  describe(): { start: string; end: string; view: string } | null {
    const v = this.calendar?.view;
    if (!v) return null;
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { start: day(v.activeStart), end: day(v.activeEnd), view: v.type };
  }

  /** Shows the period around a day ("YYYY-MM-DD"). */
  goTo(date: string): void {
    this.calendar?.gotoDate(date);
  }

  /**
   * Shows an occurrence (from its note's header) in its day's view, scrolled to it, and makes it blink so it's
   * found, to be moved there (the week's tab, top left, opens its week). Drawn already, it blinks now; else when
   * it's drawn.
   */
  reveal(id: string, start: string): void {
    const cal = this.calendar;
    if (!cal) return;
    const day = start.slice(0, 10);
    const d = cal.view.currentStart;
    const shown = cal.view.type === "timeGridDay" && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === day;
    this.revealing = id;
    if (!shown) cal.changeView("timeGridDay", day);
    if (start.length > 10) {
      const minutes = Math.max(0, Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16)) - 60);
      cal.scrollToTime({ hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    }
    const el = this.revealing ? this.contentEl.querySelector<HTMLElement>(`.fc-event[data-occ="${CSS.escape(id)}"]`) : null;
    if (el) this.blink(el);
  }

  private blink(el: HTMLElement): void {
    this.revealing = null;
    el.removeClass("ct-ev-reveal");
    void el.offsetWidth; // restarts the animation
    el.addClass("ct-ev-reveal");
    window.setTimeout(() => el.removeClass("ct-ev-reveal"), 2400);
  }

  /** Re-reads events and calendars (after a sync or a task change). An open card may show stale data: it closes. */
  refresh(): void {
    if (this.popover?.kind === "card") this.closePopover();
    this.calendar?.refetchEvents();
    this.toPlan = this.host.planTasks();
    this.renderToolbar();
    this.renderLegend();
    this.renderPanel();
  }

  /** Time passed: deadlines turn red once missed. Skipped while a popover is open (it would lose its anchor). */
  tick(): void {
    if (!this.popover) this.calendar?.refetchEvents();
  }

  /** A task note changed: only the "To plan" list and its count (the events come from the server data). */
  refreshTasks(): void {
    this.toPlan = this.host.planTasks();
    this.renderToolbar();
    this.renderPanel();
  }

  private inputs(from: Date, to: Date): EventInput[] {
    const colors = new Map(this.host.calendars().map((c) => [c.url, c.color]));
    const now = new Date();
    // Week and day: deadlines too close to stand apart become one marker ("3 tasks") instead of slivers side by side.
    const grouped = (this.grouped = this.calendar?.view.type.startsWith("timeGrid") ?? true);
    const out: EventInput[] = [];
    const marks: Occurrence[] = [];
    for (const o of this.host.occurrences(from, to)) {
      if (grouped && o.kind === "deadline" && !o.allDay) marks.push(o);
      else out.push(this.input(o, colors, now));
    }
    for (const group of closeDeadlines(marks, MARK_MS / 60_000)) {
      if (group.length === 1) {
        out.push(this.input(group[0]!, colors, now));
        continue;
      }
      const first = group[0]!;
      const open = group.filter((o) => !o.done);
      const classes = ["ct-ev", "ct-ev-deadline", "ct-ev-group"];
      if (open.some((o) => isPast(o, now))) classes.push("ct-ev-overdue");
      if (!open.length) classes.push("ct-ev-done");
      out.push({
        id: `group:${first.id}`,
        title: group.map((o) => o.title).join(", "),
        start: first.start,
        end: new Date(new Date(first.start).getTime() + MARK_MS),
        allDay: false,
        classNames: classes,
        editable: false,
        extendedProps: { group, color: colors.get(first.calendarUrl) ?? null },
      });
    }
    return out;
  }

  private input(o: Occurrence, colors: Map<string, string>, now: Date): EventInput {
    const classes = ["ct-ev", `ct-ev-${o.kind}`];
    if (o.kind === "deadline" && !o.done && isPast(o, now)) classes.push("ct-ev-overdue");
    if (o.invitation?.partstat === "NEEDS-ACTION") classes.push("ct-ev-pending");
    if (o.invitation?.partstat === "TENTATIVE") classes.push("ct-ev-tentative");
    if (this.isDone(o)) classes.push("ct-ev-done");
    if (o.invitation?.relay?.startsWith("failed")) classes.push("ct-ev-rsvp-failed");
    return {
      id: o.id,
      title: o.title,
      start: o.start,
      // A deadline is a moment: draw it as a one-line marker rather than FullCalendar's default hour.
      end: o.end ?? (o.allDay ? undefined : new Date(new Date(o.start).getTime() + MARK_MS)),
      allDay: o.allDay,
      classNames: classes,
      editable: this.host.editable(o),
      durationEditable: o.kind !== "deadline" && this.host.editable(o),
      extendedProps: { occ: o, color: colors.get(o.calendarUrl) ?? null },
    };
  }

  /** A deadline's task is done; a work session's task too (it's ticked like its task). */
  private isDone(o: Occurrence): boolean {
    if (o.kind === "deadline") return o.done;
    return o.kind === "timeblock" && !!o.taskUid && !!this.host.task(o.taskUid)?.done;
  }

  /**
   * A task's checkbox, ticked in place (it ticks the task). Pressing it neither drags the event nor opens its card.
   * The look changes at once; the calendar redraws from the server data after the push.
   */
  private checkbox(parent: HTMLElement, taskUid: string | null, done: boolean, live: boolean): void {
    const box = parent.createSpan({ cls: `ct-ev-check${done ? " is-checked" : ""}`, attr: { role: "checkbox", "aria-checked": String(done) } });
    setIcon(box, "check");
    if (!live || !taskUid) return;
    setTooltip(box, t("chip.toggle"));
    for (const type of ["mousedown", "touchstart", "pointerdown"]) box.addEventListener(type, (e) => e.stopPropagation());
    // Focusing the event would lay FullCalendar's focus overlay (`.fc-event:focus::before`) over the box: the
    // release would land on the event and open its card.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const checked = !box.hasClass("is-checked");
      box.toggleClass("is-checked", checked);
      box.setAttr("aria-checked", String(checked));
      box.closest(".fc-event")?.toggleClass("ct-ev-done", checked);
      this.host.toggleTask(taskUid);
    });
  }

  /**
   * An event drawn by us, in three shapes that say what it is: an event is a filled block (a dot in the month);
   * anything about a task has its checkbox: a work session is a dashed block, a deadline a one-line marker with
   * its time after a flag. Times come from FullCalendar's event, so a drag shows where it lands.
   */
  private eventContent(arg: EventContentArg): { domNodes: Node[] } | true {
    const group = arg.event.extendedProps.group as Occurrence[] | undefined;
    if (group) return { domNodes: [this.groupContent(group)] };
    const occ = arg.event.extendedProps.occ as Occurrence | undefined;
    if (!occ) return true; // the selection: FullCalendar's own
    const el = createDiv({ cls: "ct-ev-content" });
    const task = occ.kind !== "event";
    const start = arg.event.start ?? new Date(occ.start);
    const end = arg.event.end;
    const title = (parent: HTMLElement, check = task) => {
      const line = parent.createDiv({ cls: "ct-ev-title" });
      if (check) this.checkbox(line, occ.taskUid, arg.event.classNames.includes("ct-ev-done"), !arg.isMirror);
      else if (occ.invitation?.partstat === "NEEDS-ACTION") setIcon(line.createSpan({ cls: "ct-ev-icon" }), "mail");
      line.createSpan({ cls: "ct-ev-name", text: occ.title });
      if (occ.recurring && occ.kind !== "deadline") setIcon(line.createSpan({ cls: "ct-ev-icon ct-ev-repeat" }), "repeat");
      return line;
    };
    const due = (parent: HTMLElement) => {
      const at = parent.createSpan({ cls: "ct-ev-due" });
      setIcon(at.createSpan({ cls: "ct-ev-due-icon" }), "flag");
      at.appendText(clock(start));
    };
    const type = arg.view.type;
    if (type.startsWith("timeGrid") && !occ.allDay) {
      const line = title(el);
      if (occ.kind === "deadline") due(line);
      else {
        // A box too low for two lines shows the start on the title's line (styles.css, a container query).
        const time = el.createDiv({ cls: "ct-ev-time" });
        time.createSpan({ text: clock(start) });
        if (end && end.toDateString() === start.toDateString()) time.createSpan({ text: ` – ${clock(end)}` });
        if (occ.location) time.createSpan({ cls: "ct-ev-place", text: ` · ${occ.location}` });
      }
    } else if (type === "dayGridMonth" && (!occ.allDay || task)) {
      // Month: one aligned line each, a dot (event), a dashed ring (work session) or the checkbox (deadline).
      el.addClass("is-dot");
      if (occ.kind !== "deadline") el.createSpan({ cls: `ct-ev-dot${occ.kind === "timeblock" ? " is-ring" : ""}` });
      const line = title(el, occ.kind === "deadline");
      if (!occ.allDay) line.insertBefore(createSpan({ cls: "ct-ev-time", text: clock(start) }), line.querySelector(".ct-ev-name"));
    } else title(el);
    return { domNodes: [el] };
  }

  /** Deadlines too close to stand apart, in one marker: "3 tasks", their names, the first one's time. */
  private groupContent(group: Occurrence[]): HTMLElement {
    const el = createDiv({ cls: "ct-ev-content" });
    const line = el.createDiv({ cls: "ct-ev-title" });
    setIcon(line.createSpan({ cls: "ct-ev-icon ct-ev-stack" }), "list-checks");
    line.createSpan({ cls: "ct-ev-count", text: t("view.tasks", { n: group.length }) });
    const names = [...group.filter((o) => !o.done), ...group.filter((o) => o.done)].map((o) => o.title);
    line.createSpan({ cls: "ct-ev-name ct-ev-names", text: names.join(", ") });
    const at = line.createSpan({ cls: "ct-ev-due" });
    setIcon(at.createSpan({ cls: "ct-ev-due-icon" }), "flag");
    at.appendText(hm(group[0]!.start));
    return el;
  }

  /** Week and day views: the weekday small, the date large (today in the accent color). */
  private dayHeader(arg: DayHeaderContentArg): { domNodes: Node[] } | true {
    if (!arg.view.type.startsWith("timeGrid")) return true;
    const el = createDiv({ cls: `ct-dh${arg.isToday ? " is-today" : ""}` });
    el.createSpan({ cls: "ct-dh-weekday", text: new Intl.DateTimeFormat(this.host.language(), { weekday: "short" }).format(arg.date).replace(/\.$/, "") });
    el.createSpan({ cls: "ct-dh-date", text: String(arg.date.getDate()) });
    return { domNodes: [el] };
  }

  /** ‹ › Today, the period, the views, then New task / To plan / Sync. */
  private renderToolbar(): void {
    const bar = this.toolbar;
    const cal = this.calendar;
    if (!bar || !cal) return;
    bar.empty();
    const nav = bar.createDiv({ cls: "ct-cal-nav" });
    const arrow = (icon: string, label: StringKey, run: () => void) => {
      const b = nav.createEl("button", { cls: "clickable-icon ct-cal-arrow", attr: { "aria-label": t(label) } });
      setIcon(b, icon);
      b.addEventListener("click", run);
    };
    arrow("chevron-left", "view.prev", () => cal.prev());
    arrow("chevron-right", "view.next", () => cal.next());
    const view = cal.view;
    const now = Date.now();
    const today = nav.createEl("button", { cls: "ct-cal-today", text: t("chip.today") });
    today.disabled = now >= view.activeStart.getTime() && now < view.activeEnd.getTime();
    today.addEventListener("click", () => cal.today());
    bar.createDiv({ cls: "ct-cal-title", text: view.title });

    const right = bar.createDiv({ cls: "ct-cal-right" });
    const seg = right.createDiv({ cls: "ct-segmented" });
    for (const [type, label] of this.views()) {
      const b = seg.createEl("button", { text: t(label), cls: view.type === type ? "is-active" : "" });
      b.addEventListener("click", () => cal.changeView(type));
    }
    if (view.type.startsWith("timeGrid") && !Platform.isPhone) {
      const zoom = right.createDiv({ cls: "ct-cal-zoom" });
      const hint = t("view.zoomHint", { key: Platform.isMacOS ? "⌘" : "Ctrl" });
      for (const [icon, label, factor] of [["zoom-out", "view.zoomOut", 1 / ZOOM.step], ["zoom-in", "view.zoomIn", ZOOM.step]] as const) {
        const b = zoom.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `${t(label)} (${hint})` } });
        setIcon(b, icon);
        b.disabled = factor > 1 ? this.zoom >= ZOOM.max : this.zoom <= ZOOM.min;
        b.addEventListener("click", () => this.zoomTo(this.zoom * factor));
      }
    }
    const action = (icon: string, text: string, tooltip: string, run: () => void, active = false) => {
      const b = right.createEl("button", { cls: `ct-cal-action${active ? " is-active" : ""}` });
      setIcon(b.createSpan({ cls: "ct-chip-icon" }), icon);
      b.createSpan({ cls: "ct-cal-action-text", text });
      setTooltip(b, tooltip);
      b.addEventListener("click", run);
    };
    action("plus", t("command.newTask"), t("command.newTask"), () => this.host.newTask());
    const open = this.host.planPanelOpen();
    action("list-todo", t("view.tasksPanel"), t("view.tasksPanel.desc"), () => {
      this.host.setPlanPanelOpen(!open);
      this.renderToolbar();
      this.renderPanel();
      this.calendar?.updateSize();
    }, open);
    const sync = right.createEl("button", { cls: "clickable-icon ct-cal-sync", attr: { "aria-label": t("command.syncNow") } });
    setIcon(sync, "refresh-cw");
    sync.addEventListener("click", () => this.host.sync());
  }

  /**
   * The server's collections, all alike, as the server lists them: a dot in its color (hollow when hidden) and its
   * name. A click shows or hides it; the pencil (or a right-click) opens its card. "+" makes a new one.
   */
  private renderLegend(): void {
    const legend = this.legend;
    if (!legend) return;
    legend.empty();
    for (const c of this.host.calendars()) {
      const chip = legend.createEl("button", { cls: `ct-legend-item${c.hidden ? " is-hidden" : ""}` });
      chip.style.setProperty("--ct-dot", c.color);
      chip.createSpan({ cls: "ct-legend-mark" });
      chip.createSpan({ text: c.name });
      setTooltip(chip, c.hidden ? t("view.show") : t("view.hide"));
      chip.addEventListener("click", () => this.toggleCalendar(c.url));
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.editCalendar(c, chip);
      });
      const pencil = chip.createSpan({ cls: "ct-legend-edit", attr: { "aria-label": t("cal.edit") } });
      setIcon(pencil, "pencil");
      pencil.addEventListener("click", (e) => {
        e.stopPropagation();
        this.editCalendar(c, chip);
      });
    }
    const add = legend.createEl("button", { cls: "clickable-icon ct-legend-add", attr: { "aria-label": t("cal.new") } });
    setIcon(add, "plus");
    add.addEventListener("click", () => this.newCalendar(add));
    // What the shapes mean, the same in every view.
    const key = legend.createDiv({ cls: "ct-key" });
    for (const [shape, label] of [["event", "key.event"], ["block", "key.block"], ["deadline", "key.deadline"]] as const) {
      const item = key.createSpan({ cls: "ct-key-item" });
      const swatch = item.createSpan({ cls: `ct-key-swatch is-${shape}` });
      if (shape === "deadline") swatch.createSpan({ cls: "ct-key-check" });
      item.createSpan({ text: t(label) });
    }
  }

  /**
   * Every open task, to drag onto the calendar (or click to pick a slot), however many time blocks it already
   * has; "No time block" shows only those with none.
   */
  private renderPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.empty();
    const open = this.host.planPanelOpen();
    panel.toggleClass("is-open", open);
    this.contentEl.toggleClass("ct-plan-open", open);
    if (!open) return;
    const head = panel.createDiv({ cls: "ct-plan-head" });
    head.createDiv({ cls: "ct-plan-title", text: t("view.tasksPanel") });
    const only = this.host.planUnplannedOnly();
    const filter = head.createEl("button", { cls: `ct-plan-filter${only ? " is-active" : ""}`, attr: { "aria-pressed": String(only) } });
    setIcon(filter.createSpan({ cls: "ct-chip-icon" }), "filter");
    filter.appendText(t("view.unplannedOnly"));
    setTooltip(filter, t("view.unplannedOnly.desc"));
    filter.addEventListener("click", () => {
      this.host.setPlanUnplannedOnly(!only);
      this.renderPanel();
    });
    panel.createDiv({ cls: "ct-plan-hint", text: t("view.tasksPanel.desc") });
    const tasks = only ? this.toPlan.filter((x) => !x.blocks) : this.toPlan;
    if (!tasks.length) panel.createDiv({ cls: "ct-plan-empty", text: t(only && this.toPlan.length ? "view.allPlanned" : "view.noOpenTasks") });
    for (const task of tasks) {
      const item = panel.createDiv({ cls: "ct-plan-item" });
      item.dataset.path = task.path;
      item.dataset.title = task.title;
      setIcon(item.createSpan({ cls: "ct-plan-grip" }), "grip-vertical");
      const text = item.createDiv({ cls: "ct-plan-text" });
      text.createDiv({ cls: "ct-plan-item-title", text: task.title });
      if (task.priority) {
        const mark = text.createSpan({ cls: `ct-chip ct-chip-priority is-${task.priority}`, text: PRIORITY_MARK[task.priority] });
        setTooltip(mark, t("priority.named", { level: t(`priority.${task.priority}`).toLowerCase() }));
      }
      if (task.due) {
        const due = text.createSpan({ cls: `ct-chip ct-chip-due${task.due.overdue ? " is-overdue" : ""}` });
        setIcon(due.createSpan({ cls: "ct-chip-icon" }), "flag");
        due.appendText(task.due.text);
      }
      if (task.blocks) {
        const planned = text.createSpan({ cls: "ct-chip ct-plan-blocks" });
        setIcon(planned.createSpan({ cls: "ct-chip-icon" }), "clock");
        planned.appendText(String(task.blocks));
        setTooltip(planned, task.blocks === 1 ? t("view.blockPlanned") : t("view.blocksPlanned", { n: task.blocks }));
      }
      item.addEventListener("click", () => this.host.pickSlot(task.path));
    }
  }

  private toggleCalendar(url: string): void {
    this.host.toggleCalendar(url);
    this.refresh();
  }

  /** A calendar's name, color and visibility: beside its chip on a computer, in a modal on a phone. */
  private editCalendar(c: CalendarEntry, chip: HTMLElement): void {
    const actions = {
      rename: (name: string) => this.host.updateCalendar(c.url, { displayName: name }),
      recolor: (color: string) => this.host.updateCalendar(c.url, { color }),
      toggle: () => this.toggleCalendar(c.url),
      remove: () => {
        this.closePopover();
        this.host.deleteCalendar(c.url);
      },
    };
    if (Platform.isPhone) {
      new CardModal(this.app, (box, close) => renderCalendarCard(box, c, { ...actions, close })).open();
      return;
    }
    let commit = () => {};
    const pop = this.openPopover("calendar", chip.getBoundingClientRect(), () => commit());
    commit = renderCalendarCard(pop, c, { ...actions, close: () => this.closePopover() });
  }

  /** The times typed in the new event form, drawn as the selection (its form stays open). */
  private reselect(w: When): void {
    if (w.end === null) return;
    this.reselecting = true;
    try {
      this.calendar?.select({ start: localDate(w.start), end: localDate(w.end), allDay: w.allDay });
    } finally {
      this.reselecting = false;
    }
  }

  // —— zoom ——

  private slotHeight(): number {
    return (this.zoom * Number(slotOptions(this.zoom).slotDuration.slice(3, 5))) / 60;
  }

  /** Zooms at the next frame (a pinch sends many steps); `y`: the point that stays put, else the middle. */
  private zoomTo(zoom: number, y?: number): void {
    const first = !this.pendingZoom;
    this.pendingZoom = { zoom: Math.min(ZOOM.max, Math.max(ZOOM.min, zoom)), y };
    if (!first) return;
    window.requestAnimationFrame(() => {
      const p = this.pendingZoom;
      this.pendingZoom = null;
      if (p) this.setZoom(p.zoom, p.y);
    });
  }

  private setZoom(zoom: number, y: number | undefined): void {
    const cal = this.calendar;
    if (!cal || Math.abs(zoom - this.zoom) < 0.5) return;
    const scroller = () => this.contentEl.querySelector(".fc-timegrid-body")?.closest<HTMLElement>(".fc-scroller") ?? null;
    const before = scroller();
    const rect = before?.getBoundingClientRect();
    const offset = rect ? (y ?? rect.top + rect.height / 2) - rect.top : 0;
    const at = before ? (before.scrollTop + offset) / before.scrollHeight : 0;
    const lines = slotOptions(this.zoom);
    this.zoom = zoom;
    this.contentEl.style.setProperty("--ct-slot-h", `${this.slotHeight()}px`);
    const next = slotOptions(zoom);
    if (next.slotDuration !== lines.slotDuration) cal.setOption("slotDuration", next.slotDuration);
    if (next.slotLabelInterval !== lines.slotLabelInterval) cal.setOption("slotLabelInterval", next.slotLabelInterval);
    // FullCalendar measures the hour lines when it renders, and resizing doesn't render: a new option does.
    cal.setOption("slotLabelClassNames", (arg: { date: Date }) => minorLabels(arg));
    const after = scroller();
    if (after) after.scrollTop = at * after.scrollHeight - offset;
    this.app.saveLocalStorage(ZOOM_KEY, Math.round(zoom));
    this.renderToolbar();
  }

  /** A new collection: under the "+" on a computer, in a modal on a phone. */
  private newCalendar(button: HTMLElement): void {
    const taken = this.host.calendars().map((c) => c.color);
    const create = (spec: NewCalendar) => this.host.createCalendar(spec);
    if (Platform.isPhone) {
      new CardModal(this.app, (box, close) => {
        const input = renderNewCalendarCard(box, taken, { create, close });
        window.setTimeout(() => input.focus(), 0);
      }).open();
      return;
    }
    const pop = this.openPopover("calendar", button.getBoundingClientRect(), () => undefined);
    const input = renderNewCalendarCard(pop, taken, { create, close: () => this.closePopover() });
    window.setTimeout(() => input.focus(), 0);
  }

  // —— popovers ——

  private openPopover(kind: PopoverKind, anchor: DOMRect | null, closed: () => void): HTMLElement {
    this.closePopover();
    const el = this.contentEl.createDiv({ cls: `ct-popover ct-popover-${kind}` });
    this.popover = { el, kind, closed };
    window.setTimeout(() => this.place(el, anchor), 0);
    return el;
  }

  /** Beside the anchor (right if there's room, else left), kept inside the view; a calendar's card goes under its chip. */
  private place(pop: HTMLElement, anchor: DOMRect | null): void {
    const view = this.contentEl.getBoundingClientRect();
    const [w, h, gap] = [pop.offsetWidth, pop.offsetHeight, 8];
    let left = view.left + (view.width - w) / 2;
    let top = view.top + (view.height - h) / 3;
    if (anchor && this.popover?.el === pop && this.popover.kind === "calendar") {
      left = anchor.left;
      top = anchor.bottom + gap / 2;
    } else if (anchor) {
      left = anchor.right + gap + w <= view.right ? anchor.right + gap : anchor.left - gap - w;
      top = anchor.top;
    }
    left = Math.max(view.left + gap, Math.min(left, view.right - w - gap));
    top = Math.max(view.top + gap, Math.min(top, view.bottom - h - gap));
    pop.style.left = `${left - view.left}px`;
    pop.style.top = `${top - view.top}px`;
    pop.addClass("is-placed");
  }

  private closePopover(): void {
    const p = this.popover;
    if (!p) return;
    this.popover = null;
    p.el.remove();
    p.closed();
  }

  /** The new event form beside the selected range (which stays drawn behind it). */
  private newEventPopover(opts: NewEventOptions): void {
    const anchor = this.contentEl.querySelector(".fc-event-mirror, .fc-highlight")?.getBoundingClientRect() ?? null;
    const pop = this.openPopover("new", anchor, () => this.calendar?.unselect());
    const head = pop.createDiv({ cls: "ct-popover-head" });
    head.createDiv({ cls: "ct-popover-title", text: t("modal.newEvent") });
    const x = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("modal.cancel") } });
    setIcon(x, "x");
    x.addEventListener("click", () => this.closePopover());
    const input = renderNewEventForm(pop, opts, () => this.closePopover());
    window.setTimeout(() => input.focus(), 0);
  }

  /** An event's card: beside it on a computer, in a modal on a phone. */
  private showCard(occ: Occurrence, el: HTMLElement): void {
    const calendar = this.host.calendars().find((c) => c.url === occ.calendarUrl) ?? null;
    const info: EventCardInfo = {
      occ,
      calendar: calendar && { name: calendar.name, color: calendar.color },
      task: occ.taskUid ? this.host.task(occ.taskUid) : null,
      lang: this.host.language(),
      editable: this.host.editable(occ),
    };
    const actions: Omit<EventCardActions, "close"> = {
      open: () => {
        this.closePopover();
        this.host.open(occ);
      },
      toggleTask: () => occ.taskUid && this.host.toggleTask(occ.taskUid),
      rsvp: (ps) => this.host.rsvp(occ, ps),
      more: (e) => this.host.menu(occ, e),
      move: (w) => {
        this.closePopover();
        void this.host.move(occ, localDate(w.start), w.end === null ? null : localDate(w.end), w.allDay);
      },
    };
    if (Platform.isPhone) {
      const card = (box: HTMLElement, close: () => void) =>
        renderEventCard(box, info, {
          ...actions,
          open: () => {
            close();
            actions.open();
          },
          move: (w) => {
            close();
            actions.move(w);
          },
          close,
        });
      new CardModal(this.app, card).open();
      return;
    }
    el.addClass("is-active");
    const pop = this.openPopover("card", el.getBoundingClientRect(), () => el.removeClass("is-active"));
    renderEventCard(pop, info, { ...actions, close: () => this.closePopover() });
  }

  /** Close deadlines drawn as one marker: their list, each with its checkbox and a link to its note. */
  private showGroup(group: Occurrence[], el: HTMLElement): void {
    const color = this.host.calendars().find((c) => c.url === group[0]!.calendarUrl)?.color ?? null;
    const info = { occs: group, color, lang: this.host.language(), task: (uid: string) => this.host.task(uid) };
    const actions = {
      toggleTask: (uid: string) => this.host.toggleTask(uid),
      open: (occ: Occurrence) => {
        this.closePopover();
        this.host.open(occ);
      },
    };
    if (Platform.isPhone) {
      const card = (box: HTMLElement, close: () => void) =>
        renderTaskGroup(box, info, {
          ...actions,
          open: (occ) => {
            close();
            this.host.open(occ);
          },
          close,
        });
      new CardModal(this.app, card).open();
      return;
    }
    el.addClass("is-active");
    const pop = this.openPopover("card", el.getBoundingClientRect(), () => el.removeClass("is-active"));
    renderTaskGroup(pop, info, { ...actions, close: () => this.closePopover() });
  }
}

/** "new": the form beside a selection (closes with it); "card": an event's card; "calendar": a calendar's card. */
type PopoverKind = "new" | "card" | "calendar";

/** A deadline already behind us (a whole day counts until it ends). */
function isPast(o: Occurrence, now: Date): boolean {
  if (!o.allDay) return new Date(o.start).getTime() < now.getTime();
  const [y, m, d] = o.start.split("-").map(Number);
  return new Date(y!, m! - 1, d! + 1).getTime() <= now.getTime();
}
