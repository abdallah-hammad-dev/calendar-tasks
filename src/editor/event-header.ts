import { setIcon, setTooltip } from "obsidian";
import type { PartStat } from "../calendar/vevent";

/** What the header of an event note shows (spec §4.3). */
export interface EventHeaderModel {
  /** "mardi 13 octobre · 07:00 – 10:30". */
  when: string;
  calendar: { name: string; color: string } | null;
  repeats: boolean;
  location: string | null;
  /** My answer, when I'm invited (null: not answered yet). */
  invitation: { partstat: PartStat | null } | null;
  /** Not in the calendar (deleted, or not synced yet): only what the note says. */
  gone: boolean;
}

export interface EventHeaderActions {
  /** The calendar on this event (it blinks), to move it there. */
  reveal(): void;
  rsvp(partstat: PartStat): void;
  properties: { shown: boolean; toggle(): void };
}

export interface EventHeaderLabels {
  reveal: string;
  repeats: string;
  gone: string;
  answers: Record<PartStat, string>;
  showProperties: string;
  hideProperties: string;
}

/**
 * The bar above an event note, like a task note's (spec §5.4): when (a click shows it in the calendar, where it's
 * moved), repetition, place, collection, the answer to an invitation; the raw properties hidden.
 */
export function renderEventHeader(model: EventHeaderModel, actions: EventHeaderActions, labels: EventHeaderLabels): HTMLElement {
  const header = createDiv({ cls: "ct-task-header ct-event-header" });
  if (model.calendar) header.style.setProperty("--ct-ev-color", model.calendar.color);
  const inner = header.createDiv({ cls: "ct-task-header-inner" });

  const item = (icon: string, text: string, cls = "is-static") => {
    const el = inner.createEl(cls === "is-static" ? "span" : "button", { cls: `ct-task-header-item ${cls}` });
    setIcon(el.createSpan({ cls: "ct-chip-icon" }), icon);
    el.createSpan({ text });
    return el;
  };
  const when = item("clock", model.when, "is-due ct-event-when");
  setTooltip(when, labels.reveal);
  when.addEventListener("click", () => actions.reveal());
  if (model.gone) item("calendar-off", labels.gone, "is-static is-gone");
  if (model.repeats) item("repeat", labels.repeats);
  if (model.location) item("map-pin", model.location);
  if (model.calendar) {
    const el = inner.createSpan({ cls: "ct-task-header-item is-static" });
    el.createSpan({ cls: "ct-event-dot" });
    el.createSpan({ text: model.calendar.name });
  }
  if (model.invitation) {
    const seg = inner.createDiv({ cls: "ct-segmented ct-event-rsvp" });
    const buttons = (Object.keys(labels.answers) as PartStat[]).map((ps) => {
      const b = seg.createEl("button", { text: labels.answers[ps], cls: model.invitation?.partstat === ps ? "is-active" : "" });
      b.addEventListener("click", () => {
        for (const x of buttons) x.removeClass("is-active");
        b.addClass("is-active");
        actions.rsvp(ps);
      });
      return b;
    });
  }

  const tools = inner.createDiv({ cls: "ct-task-header-tools" });
  const tool = (icon: string, tooltip: string, onClick: () => void, active = false) => {
    const el = tools.createEl("button", { cls: `clickable-icon${active ? " is-active" : ""}` });
    setIcon(el, icon);
    setTooltip(el, tooltip);
    el.addEventListener("click", onClick);
  };
  tool("calendar-search", labels.reveal, () => actions.reveal());
  const shown = actions.properties.shown;
  tool("list", shown ? labels.hideProperties : labels.showProperties, () => actions.properties.toggle(), shown);
  return header;
}
