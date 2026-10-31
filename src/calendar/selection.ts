import type { Calendar, DateSelectArg } from "@fullcalendar/core";
import { Platform } from "obsidian";

/** Dragging and resizing move by 5 minutes, like Apple Calendar. */
export const SNAP_MS = 5 * 60_000;
/** The event a new event's time is drawn as until it's filled in (`CalendarView.openDraft`; `tools/fullcalendar-patch.mjs` knows it). */
export const DRAFT_ID = "ct-draft";

/**
 * Whether a selection is a click, which takes an hour: what's selected is what shows when it's let go, and a click
 * reports one step it never drew (`stillPressed` in tools/fullcalendar-patch.mjs). A press held long enough to show
 * stays those 5 minutes (2026-10-31, asked). A finger has to hold to select at all, so holding says nothing there.
 */
export function isClick(calendar: Calendar, info: DateSelectArg): boolean {
  if (info.allDay || info.end.getTime() - info.start.getTime() > SNAP_MS) return false;
  return Platform.isMobile || !calendar.getCurrentData().dateSelection;
}
