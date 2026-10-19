/**
 * Frontmatter property names. Fixed on purpose (spec §2.5): the generated `.base` file and Claude's skill rely on
 * them, so they are not settings. A fork that wants other names changes them here.
 */
export const PROP = {
  type: "type",
  done: "done",
  /** The deadline: synced as `DUE`, the date Apple Reminders shows. */
  due: "due",
  /** How the task repeats: "every monday", "every 2 weeks"… (or a raw RRULE); synced as `RRULE`. */
  repeat: "repeat",
  /** high / medium / low (none: no property); synced as `PRIORITY` 1 / 5 / 9, the three levels Reminders shows. */
  priority: "priority",
  project: "project",
  parent: "parent",
  uid: "caldav_uid",
  /** The collection (CalDAV calendar) holding the task, by name: changing it moves the task there. */
  collection: "collection",
  start: "start",
  end: "end",
  recurrenceId: "recurrence_id",
} as const;

/** A task's priority, most urgent first. */
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** How a priority is drawn, as on the iPhone. */
export const PRIORITY_MARK: Record<Priority, string> = { high: "!!!", medium: "!!", low: "!" };

/** Values of the `type` property. */
export const NOTE_TYPE = { task: "task", event: "event" } as const;

/**
 * Action of the `obsidian://calendar-tasks?uid=…` links written into events and reminders. Apple Calendar shows it
 * as the label of the link card (spec §4.5).
 */
export const PROTOCOL_ACTION = "calendar-tasks";
