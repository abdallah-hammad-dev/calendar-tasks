import { formatLocalDate, parseLocal, wallClock, fromWall } from "../ical/time";
import type { Priority } from "../constants";
import type { TaskInfo } from "../tasks/task-index";
import { repeatLabel } from "./when";

/** What is drawn around a link to a task note (spec §5.1). */
export interface ChipModel {
  path: string;
  done: boolean;
  priority: Priority | null;
  /** The deadline; `overdue` once passed while not done. */
  due: { text: string; overdue: boolean } | null;
  /** "chaque lundi"…, when the task repeats. */
  repeat: string | null;
  /** Project name, shown when it differs from the note's own project. */
  project: string | null;
  sync: "pending" | "local" | null;
  /** "2/5" child tasks done. */
  progress: string | null;
}

export interface ChipContext {
  /** Project of the note the link is in. */
  contextProject: string | null;
  children: TaskInfo[];
  sync: "local" | "pending" | "synced";
  now: Date;
  tz: string;
  lang: string;
  words: { today: string; tomorrow: string };
}

export function chipModel(task: TaskInfo, ctx: ChipContext): ChipModel {
  const projectName = task.projectPath && task.projectPath !== ctx.contextProject ? basename(task.projectPath) : null;
  const doneKids = ctx.children.filter((c) => c.done).length;
  return {
    path: task.path,
    done: task.done,
    priority: task.priority,
    due: task.due ? dueLabel(task.due, task.done, ctx) : null,
    repeat: task.repeat ? (repeatLabel(task.repeat, ctx.lang.startsWith("fr") ? "fr" : "en") ?? "↻") : null,
    project: projectName,
    sync: ctx.sync === "synced" ? null : ctx.sync,
    progress: ctx.children.length ? `${doneKids}/${ctx.children.length}` : null,
  };
}

export function dueLabel(due: string, done: boolean, ctx: Pick<ChipContext, "now" | "tz" | "lang" | "words">) {
  const p = parseLocal(due);
  if (!p) return { text: due, overdue: false };
  const today = wallClock(ctx.now, ctx.tz);
  const todayStr = formatLocalDate(today);
  const tomorrow = wallClock(new Date(fromWall({ ...today, hour: 12, minute: 0, second: 0 }, ctx.tz).getTime() + 86_400_000), ctx.tz);
  const dateStr = formatLocalDate(p.wall);
  let text =
    dateStr === todayStr
      ? ctx.words.today
      : dateStr === formatLocalDate(tomorrow)
        ? ctx.words.tomorrow
        : new Intl.DateTimeFormat(ctx.lang, { day: "numeric", month: "short", timeZone: "UTC", ...(p.wall.year !== today.year ? { year: "numeric" } : {}) }).format(
            new Date(Date.UTC(p.wall.year, p.wall.month - 1, p.wall.day)),
          );
  if (!p.allDay) text += ` ${String(p.wall.hour).padStart(2, "0")}:${String(p.wall.minute).padStart(2, "0")}`;
  const overdue = !done && (p.allDay ? dateStr < todayStr : fromWall(p.wall, ctx.tz).getTime() < ctx.now.getTime());
  return { text, overdue };
}

function basename(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}
