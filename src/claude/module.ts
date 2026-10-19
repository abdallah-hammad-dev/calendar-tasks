import * as z from "zod/mini";
import type { Occurrence } from "../calendar/expand";
import { NOTE_TYPE, PRIORITIES, PROP, type Priority } from "../constants";
import { repeatToNote } from "../editor/when";
import { fromWall, parseLocal } from "../ical/time";
import type { TaskInfo } from "../tasks/task-index";
import { PRIORITY_RANK_FORMULA } from "../tasks/base-file";
import { freeSlots } from "./free-slots";
import type { ToolResultLike, WorkspaceModule } from "./workspace-api";

/** What the module needs from the plugin. Everything throws `Error` with a message Claude can act on. */
export interface CalendarServices {
  connected(): boolean;
  tz(): string;
  folders(): { tasks: string; events: string; projectTag: string; taskBase: string; eventNoteExample: string };
  calendars(): { url: string; name: string; readOnly: boolean; components: string[] }[];
  occurrences(from: Date, to: Date): Occurrence[];
  tasks(): TaskInfo[];
  syncState(uid: string | null): "local" | "pending" | "synced";
  createEvent(e: { calendar?: string; title: string; start: string; end: string; location?: string; taskUid?: string }): Promise<{ uid: string }>;
  updateEvent(uid: string, recurrenceId: string | null, changes: { title?: string; start?: string; end?: string }): Promise<void>;
  deleteEvent(uid: string, recurrenceId: string | null): Promise<void>;
  rsvp(uid: string, answer: "ACCEPTED" | "TENTATIVE" | "DECLINED"): Promise<void>;
  createTask(t: { title: string; due?: string; repeat?: string; priority?: Priority; project?: string; parent?: string; body?: string }): Promise<string>;
  setTaskDone(task: string, done: boolean): Promise<string>;
  /** Sets (a value) or clears (null) a task's deadline, repetition and priority; undefined leaves it. */
  setTaskDates(task: string, dates: { due?: string | null; repeat?: string | null; priority?: Priority | null }): Promise<string>;
  /** Path of the note of an event occurrence or a task, created if needed. */
  noteFor(uid: string, recurrenceId: string | null): Promise<string>;
  /** Path of a task note from a path, a note name or a UID. */
  findTask(ref: string): TaskInfo | null;
  /** Context for the active view. */
  calendarViewRange(): { start: string; end: string; view: string } | null;
  noteInfo(path: string): Record<string, unknown> | null;
}

/** zod/mini keeps the bundle small; descriptions go through zod's registry, shared with the host's zod copy. */
const describe = <T extends z.ZodMiniType>(schema: T, description: string): T => {
  (schema as z.ZodMiniType).register(z.globalRegistry, { description });
  return schema;
};
const LOCAL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const local = (what: string) =>
  describe(
    z.string().check(z.regex(LOCAL, "Use YYYY-MM-DD or YYYY-MM-DDTHH:mm (local time)")),
    `${what}, local time: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm"`,
  );
const text = (min = 1) => z.string().check(z.minLength(min));
const int = (min: number, max: number) => z.int().check(z.gte(min), z.lte(max));
const time = (what: string) => describe(z.optional(z.string().check(z.regex(/^\d{2}:\d{2}$/))), what);

const fail = (message: string): ToolResultLike => ({ isError: true, content: [{ type: "text", text: message }] });

async function guard(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function dateOf(value: string, tz: string): Date {
  const p = parseLocal(value);
  if (!p) throw new Error(`"${value}" is not a local date or date-time`);
  return fromWall(p.wall, tz);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function describeOcc(o: Occurrence, calendars: Map<string, string>) {
  return {
    kind: o.kind,
    title: o.title,
    start: o.start,
    end: o.end,
    allDay: o.allDay,
    calendar: calendars.get(o.calendarUrl) ?? o.calendarUrl,
    uid: o.uid,
    ...(o.recurrenceId ? { recurrenceId: o.recurrenceId } : {}),
    ...(o.location ? { location: o.location } : {}),
    ...(o.kind === "deadline" ? { done: o.done } : {}),
    ...(o.taskUid && o.kind === "timeblock" ? { taskUid: o.taskUid } : {}),
    ...(o.invitation ? { invitation: o.invitation.partstat.toLowerCase() } : {}),
  };
}

function describeTask(t: TaskInfo, s: CalendarServices) {
  return {
    path: t.path,
    title: t.basename,
    done: t.done,
    due: t.due,
    ...(t.repeat ? { repeat: repeatToNote(t.repeat) } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    project: t.projectPath?.split("/").pop()?.replace(/\.md$/, "") ?? null,
    parent: t.parentPath,
    uid: t.uid,
    sync: s.syncState(t.uid),
  };
}

export function skillMarkdown(f: { tasks: string; events: string; projectTag: string; taskBase: string; eventNoteExample: string }): string {
  return `---
name: calendar-tasks
description: How the user's calendar and tasks work in this vault (CalDAV-synced task notes, event notes, projects, views of tasks). Use before creating, scheduling or completing tasks or events, or making a view (Bases) of them.
---

# Calendar & Tasks

The vault's calendar and tasks are synced with a CalDAV server (and the user's iPhone) by the Calendar & Tasks
extension. Use the \`calendar_*\` tools; never edit \`caldav_uid\`, \`due\`, \`done\`, \`start\` or \`end\` by hand.

- **A task is a note** in \`${f.tasks}/\` with frontmatter \`type: ${NOTE_TYPE.task}\`, \`${PROP.done}\` (checkbox),
  optional \`${PROP.due}\` (the deadline: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", local time), optional
  \`${PROP.project}: "[[Note]]"\`, \`${PROP.parent}: "[[Parent task]]"\` and \`${PROP.repeat}\` ("every monday", "every 2 weeks",
  "every weekday"…; synced to the phone; ticking a repeating task moves it to its next date instead of closing it) and
  \`${PROP.priority}\` (high / medium / low, or none; the phone's !!! / !! / !), and \`${PROP.collection}\` (the name of
  the calendar collection it's in, e.g. "Général", "Pro"; writing another name moves it there). Its body is free content and is never synced. Small steps inside a task are
  plain \`- [ ]\` lines; a step with its own deadline is a child task (\`calendar_create_task\` with \`parent\`).
- **A project is any note tagged \`#${f.projectTag}\`.** A task belongs to at most one project.
- **Mention a task anywhere** with a plain link line \`- [[Task title]]\`: the extension draws the checkbox from
  \`${PROP.done}\`. Don't write \`- [ ] [[Task]]\`.
- **Deadline ≠ work session.** \`${PROP.due}\` is the deadline, the date synced to the phone (optional; set it with
  \`calendar_set_task_dates\`). Time to work on a task is never a task field: it's a separate event linked to it
  (\`calendar_schedule_task\`), shown in every calendar.
- **Event notes** (\`${f.events}/${f.eventNoteExample}.md\`, \`type: ${NOTE_TYPE.event}\`, \`${PROP.start}\` / \`${PROP.end}\`) are created on demand with
  \`calendar_note\`; one per occurrence for recurring events. Write meeting notes in them.
- Times are always local ("YYYY-MM-DDTHH:mm"), in the user's time zone.
- Invitations: answer with \`calendar_rsvp\`. Events copied from other accounts (school, Google) can't be edited,
  only answered.
- Changes reach the phone at its next sync; tell the user if something is pending.

## Views of tasks

Views are Obsidian Bases (\`.base\` files, https://obsidian.md/help/bases/syntax); the default one is
\`${f.taskBase}\` (don't overwrite it: make a new file, or add a view to it if asked). Every task note has
\`${PROP.type} == "${NOTE_TYPE.task}"\`; filter on that first. Properties to filter, sort, group and show:

| Property | Type | Values |
|---|---|---|
| \`${PROP.done}\` | checkbox | true / false (open tasks: \`${PROP.done} != true\`) |
| \`${PROP.due}\` | date or date-time | "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"; may be missing |
| \`${PROP.priority}\` | text | high / medium / low, or missing; as text it sorts wrong: sort on \`formula.urgency\` (below) |
| \`${PROP.repeat}\` | text | "every monday"… |
| \`${PROP.project}\` | link | "[[Project note]]"; group by it for a per-project view |
| \`${PROP.parent}\` | link | the parent task of a sub-task |
| \`${PROP.collection}\` | text | the collection's name |
| \`file.name\` | | the task's title |

To sort by priority, define (1 = most urgent, 4 = none) and sort on \`formula.urgency\`:

\`\`\`yaml
formulas:
  urgency: '${PRIORITY_RANK_FORMULA}'
\`\`\`

Time blocks are not task properties (they're calendar events), so a view can't show them; \`calendar_list\` can.
\`${PROP.uid}\` is internal: never show or filter on it.
`;
}

export function createCalendarModule(s: CalendarServices): WorkspaceModule {
  return {
    id: "calendar",
    name: "Calendar & Tasks",
    description: "Claude reads and changes the CalDAV calendar and task notes of the Calendar & Tasks extension.",
    platforms: ["desktop"],
    onload(ctx) {
      const calendarNames = () => new Map(s.calendars().map((c) => [c.url, c.name]));

      ctx.registerTool({
        name: "calendar_list",
        title: "List calendar events and deadlines",
        description:
          "Events (recurrences expanded), task deadlines and work sessions between two local dates/times, from the local copy " +
          "of the user's CalDAV calendars. Invitations show the user's answer (needs-action, accepted, tentative).",
        inputSchema: { from: local("Start"), to: local("End (exclusive)") },
        annotations: { readOnlyHint: true },
        handler: async ({ from, to }) =>
          guard(async () => {
            const tz = s.tz();
            const names = calendarNames();
            const occ = s.occurrences(dateOf(from, tz), dateOf(to, tz)).sort((a, b) => a.start.localeCompare(b.start));
            return { timeZone: tz, connected: s.connected(), items: occ.map((o) => describeOcc(o, names)) };
          }),
      });

      ctx.registerTool({
        name: "calendar_free_slots",
        title: "Find free time",
        description: "Free slots of at least `minutes` between two local dates, within working hours, around timed events.",
        inputSchema: {
          from: local("Start"),
          to: local("End (exclusive)"),
          minutes: int(5, 1440),
          dayStart: time('Working day start, default "09:00"'),
          dayEnd: time('Working day end, default "18:00"'),
        },
        annotations: { readOnlyHint: true },
        handler: async ({ from, to, minutes, dayStart, dayEnd }) =>
          guard(async () => {
            const tz = s.tz();
            const busy = s
              .occurrences(dateOf(from, tz), dateOf(to, tz))
              .filter((o) => !o.allDay && o.kind !== "deadline" && o.end && o.invitation?.partstat !== "NEEDS-ACTION")
              .map((o) => ({ start: o.start, end: o.end! }));
            const at = (v: string) => (v.length === 10 ? `${v}T00:00` : v);
            return { slots: freeSlots(busy, { from: at(from), to: at(to), minutes, dayStart: dayStart ?? "09:00", dayEnd: dayEnd ?? "18:00", tz }) };
          }),
      });

      ctx.registerTool({
        name: "calendar_create_event",
        title: "Create an event",
        description:
          "Creates an event on the CalDAV server (synced to the user's phone). `calendar`: name or URL (default: the last one used). " +
          "For time spent on a task, prefer calendar_schedule_task.",
        inputSchema: {
          title: text(),
          start: local("Start"),
          end: local("End (exclusive; for all-day events the day after the last day)"),
          calendar: z.optional(z.string()),
          location: z.optional(z.string()),
        },
        handler: async (a) => guard(async () => ({ created: await s.createEvent(a) })),
      });

      ctx.registerTool({
        name: "calendar_update_event",
        title: "Move or rename an event",
        description:
          "Changes an event's title or times. For one occurrence of a recurring event pass its recurrenceId (from calendar_list); " +
          "without it the whole event changes. Invitations and events copied from other accounts can't be edited.",
        inputSchema: {
          uid: z.string(),
          recurrenceId: z.optional(z.string()),
          title: z.optional(text()),
          start: z.optional(local("New start")),
          end: z.optional(local("New end")),
        },
        handler: async ({ uid, recurrenceId, ...changes }) =>
          guard(async () => {
            await s.updateEvent(uid, recurrenceId ?? null, changes);
            return "updated";
          }),
      });

      ctx.registerTool({
        name: "calendar_delete_event",
        title: "Delete an event",
        description: "Deletes an event, or only one occurrence of a recurring event (pass its recurrenceId). Ask the user first.",
        inputSchema: { uid: z.string(), recurrenceId: z.optional(z.string()) },
        annotations: { destructiveHint: true },
        handler: async ({ uid, recurrenceId }) =>
          guard(async () => {
            await s.deleteEvent(uid, recurrenceId ?? null);
            return "deleted";
          }),
      });

      ctx.registerTool({
        name: "calendar_rsvp",
        title: "Answer an invitation",
        description: "Accepts, tentatively accepts or declines an invitation. The server/backend relays the answer to the organizer.",
        inputSchema: { uid: z.string(), answer: z.enum(["accepted", "tentative", "declined"]) },
        handler: async ({ uid, answer }) =>
          guard(async () => {
            await s.rsvp(uid, answer.toUpperCase() as "ACCEPTED" | "TENTATIVE" | "DECLINED");
            return `answered ${answer}`;
          }),
      });

      ctx.registerTool({
        name: "calendar_list_tasks",
        title: "List tasks",
        description:
          "Task notes with their deadline (due), repetition, state, project and sync state. Filters are optional.",
        inputSchema: {
          status: describe(z.optional(z.enum(["open", "done", "all"])), "Default: open"),
          project: describe(z.optional(z.string()), "Project note name"),
          dueBefore: z.optional(local("Only tasks due before")),
        },
        annotations: { readOnlyHint: true },
        handler: async ({ status, project, dueBefore }) =>
          guard(async () => {
            const st = status ?? "open";
            const list = s
              .tasks()
              .filter((t) => st === "all" || t.done === (st === "done"))
              .filter((t) => !project || t.projectPath?.split("/").pop()?.replace(/\.md$/, "") === project)
              .filter((t) => !dueBefore || (t.due !== null && t.due < dueBefore))
              .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
            return { tasks: list.map((t) => describeTask(t, s)) };
          }),
      });

      ctx.registerTool({
        name: "calendar_create_task",
        title: "Create a task",
        description:
          "Creates a task note (synced as a reminder on the phone). `due`: deadline; to block time for it, use " +
          "calendar_schedule_task afterwards. `project`: project note name; `parent`: parent task (path, name or uid) " +
          "for a sub-task with its own deadline. Returns the note path; to mention it in a note, add a line `- [[<title>]]`.",
        inputSchema: {
          title: text(),
          due: z.optional(local("Deadline")),
          repeat: describe(z.optional(z.string()), 'How it repeats: "every day", "every monday", "every 2 weeks", "every weekday"…'),
          priority: describe(z.optional(z.enum(PRIORITIES)), "Leave out for none"),
          project: z.optional(z.string()),
          parent: z.optional(z.string()),
          body: describe(z.optional(z.string()), "Markdown content of the task note"),
        },
        handler: async (a) => guard(async () => ({ path: await s.createTask(a) })),
      });

      ctx.registerTool({
        name: "calendar_complete_task",
        title: "Tick or untick a task",
        description: "Marks a task done (or not done again). `task`: note path, note name or uid.",
        inputSchema: { task: z.string(), done: describe(z.optional(z.boolean()), "Default: true") },
        handler: async ({ task, done }) => guard(async () => ({ path: await s.setTaskDone(task, done ?? true) })),
      });

      ctx.registerTool({
        name: "calendar_set_task_dates",
        title: "Change a task's dates",
        description:
          "Sets or clears a task's deadline (`due`, synced to the phone), repetition " +
          '(`repeat`: "every monday", "every 2 weeks"…) and priority (`priority`: high, medium, low). ' +
          "Pass a date to set it, null to clear it, or leave it out to keep it. `task`: note path, note name or uid.",
        inputSchema: {
          task: z.string(),
          due: z.optional(z.nullable(local("Deadline"))),
          repeat: z.optional(z.nullable(z.string())),
          priority: z.optional(z.nullable(z.enum(PRIORITIES))),
        },
        handler: async ({ task, due, repeat, priority }) => guard(async () => ({ path: await s.setTaskDates(task, { due, repeat, priority }) })),
      });

      ctx.registerTool({
        name: "calendar_schedule_task",
        title: "Block time for a task",
        description:
          "Creates a work session for a task: an event linked to it (clicking it opens the task note). Use calendar_free_slots first " +
          "to pick a time. This doesn't change the task's deadline.",
        inputSchema: {
          task: describe(z.string(), "Note path, name or uid"),
          start: local("Start"),
          minutes: int(5, 720),
          calendar: z.optional(z.string()),
        },
        handler: async ({ task, start, minutes, calendar }) =>
          guard(async () => {
            const t = s.findTask(task);
            if (!t) throw new Error(`No task "${task}". List them with calendar_list_tasks.`);
            if (!t.uid) throw new Error(`"${t.basename}" isn't on the server yet; sync first (it has no caldav_uid).`);
            const p = parseLocal(start);
            if (!p || p.allDay) throw new Error("start must be a date-time (YYYY-MM-DDTHH:mm)");
            const end = new Date(Date.UTC(p.wall.year, p.wall.month - 1, p.wall.day, p.wall.hour, p.wall.minute + minutes));
            const endLocal = end.toISOString().slice(0, 16);
            return { created: await s.createEvent({ title: t.basename, start, end: endLocal, calendar, taskUid: t.uid }) };
          }),
      });

      ctx.registerTool({
        name: "calendar_note",
        title: "Get the note of an event or task",
        description:
          "Path of the note of an event occurrence (recurrenceId for one occurrence of a recurring event) or a task, created if it " +
          "doesn't exist yet. Then read or edit it with your file tools (keep the frontmatter).",
        inputSchema: { uid: z.string(), recurrenceId: z.optional(z.string()) },
        handler: async ({ uid, recurrenceId }) => guard(async () => ({ path: await s.noteFor(uid, recurrenceId ?? null) })),
      });

      ctx.registerContextProvider({
        id: "calendar-view",
        viewTypes: ["calendar-tasks-calendar"],
        collect: () => s.calendarViewRange(),
        render: (d) => [`Calendar view: ${str(d.view)} from ${str(d.start)} to ${str(d.end)}. Use calendar_list for its content.`],
        chip: (d) => `${str(d.start).slice(0, 10)} → ${str(d.end).slice(0, 10)}`,
      });

      ctx.registerContextProvider({
        id: "note",
        viewTypes: ["markdown"],
        collect: (_view, file) => (file ? s.noteInfo(file.path) : null),
        render: (d) => [
          d.kind === "task"
            ? `This note is a task: ${d.done ? "done" : "not done"}${d.due ? `, due ${str(d.due)}` : ""}${d.project ? `, project ${str(d.project)}` : ""}, ${str(d.sync)}.`
            : `This note is an event note: ${str(d.start)} → ${str(d.end)}${d.recurrenceId ? ` (occurrence ${str(d.recurrenceId)})` : ""}.`,
        ],
      });

      ctx.registerSkill({ name: "calendar-tasks", markdown: skillMarkdown(s.folders()) });
    },
  };
}
