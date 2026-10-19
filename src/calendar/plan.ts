import { PRIORITIES } from "../constants";
import type { TaskInfo } from "../tasks/task-index";
import type { Occurrence } from "./expand";

/** Monday 00:00 of the week `now` is in (local time): time blocks from then on count as planning. */
export function weekStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
}

/**
 * The calendar's task panel (spec §5.3): every open task, with how many time blocks it has this week or later
 * (`blocks`: occurrences from the start of the week on; a block dropped on a day already past this week counts,
 * the user just placed it; one still waiting to be created counts too: `pending`, note paths). A task can have
 * several; the panel can show only those with none. Soonest deadline first, then the most urgent, then by name.
 */
/** high 0, medium 1, low 2, none 3. */
const rank = (task: TaskInfo) => (task.priority ? PRIORITIES.indexOf(task.priority) : PRIORITIES.length);

export function tasksToPlan(tasks: TaskInfo[], blocks: Occurrence[], pending: Set<string>): { task: TaskInfo; blocks: number }[] {
  const count = new Map<string, number>();
  for (const o of blocks) if (o.kind === "timeblock" && o.taskUid) count.set(o.taskUid, (count.get(o.taskUid) ?? 0) + 1);
  return tasks
    .filter((x) => !x.done)
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || rank(a) - rank(b) || a.basename.localeCompare(b.basename))
    .map((task) => ({ task, blocks: (task.uid ? (count.get(task.uid) ?? 0) : 0) + (pending.has(task.path) ? 1 : 0) }));
}
