import { Calendar, type EventContentArg, type EventInput } from "@fullcalendar/core";
import frLocale from "@fullcalendar/core/locales/fr";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { Occurrence } from "./expand";

/** What the preview needs: the calendar's occurrences (visible collections) and their colors. */
export interface PreviewSource {
  occurrences(from: Date, to: Date): Occurrence[];
  color(calendarUrl: string): string | null;
  language(): string;
}

/** Something being placed: the deadline, a time block to add (`block:<i>`), or the one being typed (`typed`). */
export interface Placed {
  id: string;
  kind: "deadline" | "timeblock";
  /** Local values: "2026-10-20T14:35", or a day. */
  start: string;
  end: string | null;
  title: string;
}

/** A deadline is a moment, drawn as a one-line marker this long (as in the calendar). */
const MARK_MS = 20 * 60_000;
const SNAP_MS = 5 * 60_000;
const clock = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * A day of the calendar beside a form (spec §5.3): the day of what's being placed, with what's already there, so a
 * deadline or a time block is set knowing what's around it. Dragging over free time picks a slot; what's being
 * placed moves and stretches by 5 minutes. Drawn like the calendar (same shapes and colors), read-only otherwise.
 */
export class DayPreview {
  private readonly calendar: Calendar;
  private readonly label: HTMLElement;
  private placed: Placed[] = [];

  constructor(
    parent: HTMLElement,
    private readonly source: PreviewSource,
    private readonly on: {
      /** A range dragged over free time. */
      pick(start: Date, end: Date, allDay: boolean): void;
      /** Something being placed was moved or stretched. */
      move(id: string, start: Date, end: Date | null, allDay: boolean): void;
    },
  ) {
    const root = parent.createDiv({ cls: "ct-calendar ct-day-preview" });
    const head = root.createDiv({ cls: "ct-day-preview-head" });
    const arrow = (icon: string, label: string, days: number) => {
      const b = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", () => this.calendar.incrementDate({ days }));
    };
    arrow("chevron-left", t("view.prev"), -1);
    this.label = head.createDiv({ cls: "ct-day-preview-day" });
    arrow("chevron-right", t("view.next"), 1);
    const grid = root.createDiv({ cls: "ct-day-preview-grid" });
    this.calendar = new Calendar(grid, {
      plugins: [timeGridPlugin, interactionPlugin],
      initialView: "timeGridDay",
      headerToolbar: false,
      footerToolbar: false,
      dayHeaders: false,
      height: "100%",
      ...(source.language().startsWith("fr") ? { locale: frLocale } : {}),
      allDayText: "",
      nowIndicator: true,
      scrollTime: "08:00:00",
      snapDuration: SNAP_MS,
      eventMinHeight: 18,
      // Side by side, never over one another: what's being placed stays readable next to what's there.
      slotEventOverlap: false,
      slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
      selectable: true,
      selectMirror: true,
      select: (info) => {
        this.calendar.unselect();
        // A click (no drag) is one 5-minute step: make it an hour from there.
        const end = !info.allDay && info.end.getTime() - info.start.getTime() <= SNAP_MS ? new Date(info.start.getTime() + 3_600_000) : info.end;
        this.on.pick(info.start, end, info.allDay);
      },
      eventDrop: (info) => this.on.move(info.event.id, info.event.start!, info.event.end, info.event.allDay),
      eventResize: (info) => this.on.move(info.event.id, info.event.start!, info.event.end, info.event.allDay),
      events: (info, ok) => ok(this.inputs(info.start, info.end)),
      eventContent: (arg) => this.content(arg),
      eventDidMount: (arg) => {
        const color = arg.event.extendedProps.color as string | null | undefined;
        if (color) arg.el.style.setProperty("--ct-ev-color", color);
      },
      datesSet: (arg) => {
        this.label.setText(new Intl.DateTimeFormat(source.language(), { weekday: "long", day: "numeric", month: "long" }).format(arg.start));
      },
    });
    this.calendar.render();
    // The modal is still opening (and sized) when this runs.
    window.setTimeout(() => this.calendar.updateSize(), 250);
  }

  /** Shows `placed`, on `day` ("2026-10-20") when given, scrolled to `time` ("14:35") when given. */
  show(placed: Placed[], day?: string | null, time?: string | null): void {
    this.placed = placed;
    if (day && day !== this.currentDay()) this.calendar.gotoDate(day);
    this.calendar.refetchEvents();
    if (time) {
      const [h, m] = time.split(":").map(Number);
      const minutes = Math.max(0, h! * 60 + m! - 90);
      this.calendar.scrollToTime({ hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    }
  }

  destroy(): void {
    this.calendar.destroy();
  }

  private currentDay(): string {
    const d = this.calendar.view.currentStart;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  private inputs(from: Date, to: Date): EventInput[] {
    const out: EventInput[] = this.source.occurrences(from, to).map((o) => ({
      id: `occ:${o.id}`,
      title: o.title,
      start: o.start,
      end: o.end ?? (o.allDay ? undefined : new Date(new Date(o.start).getTime() + MARK_MS)),
      allDay: o.allDay,
      editable: false,
      classNames: ["ct-ev", `ct-ev-${o.kind}`, ...(o.kind === "deadline" && o.done ? ["ct-ev-done"] : [])],
      extendedProps: { kind: o.kind, color: this.source.color(o.calendarUrl) },
    }));
    for (const p of this.placed) {
      const allDay = p.start.length === 10;
      out.push({
        id: p.id,
        title: p.title,
        start: p.start,
        end: p.kind === "deadline" ? (allDay ? undefined : new Date(new Date(p.start).getTime() + MARK_MS)) : (p.end ?? undefined),
        allDay,
        editable: true,
        durationEditable: p.kind !== "deadline",
        classNames: ["ct-ev", `ct-ev-${p.kind}`, "ct-ev-placed"],
        extendedProps: { kind: p.kind, color: null },
      });
    }
    return out;
  }

  /** The calendar's shapes, without the live checkbox: a block, a dashed session, a deadline marker. */
  private content(arg: EventContentArg): { domNodes: Node[] } | true {
    const kind = arg.event.extendedProps.kind as Occurrence["kind"] | undefined;
    if (!kind) return true; // the selection
    const el = createDiv({ cls: "ct-ev-content" });
    const line = el.createDiv({ cls: "ct-ev-title" });
    if (kind !== "event") setIcon(line.createSpan({ cls: `ct-ev-check${arg.event.classNames.includes("ct-ev-done") ? " is-checked" : ""}` }), "check");
    line.createSpan({ cls: "ct-ev-name", text: arg.event.title });
    const start = arg.event.start;
    if (!start || arg.event.allDay) return { domNodes: [el] };
    if (kind === "deadline") {
      const due = line.createSpan({ cls: "ct-ev-due" });
      setIcon(due.createSpan({ cls: "ct-ev-due-icon" }), "flag");
      due.appendText(clock(start));
    } else {
      const time = el.createDiv({ cls: "ct-ev-time" });
      time.createSpan({ text: clock(start) });
      if (arg.event.end) time.createSpan({ text: ` – ${clock(arg.event.end)}` });
    }
    return { domNodes: [el] };
  }
}
