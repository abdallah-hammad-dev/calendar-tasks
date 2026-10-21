import { describe, expect, it } from "vitest";
import { tasksToPlan, weekStart } from "../src/calendar/plan";
import type { Occurrence } from "../src/calendar/expand";
import type { TaskInfo } from "../src/tasks/task-index";

const task = (o: Partial<TaskInfo>): TaskInfo => ({
  path: "", basename: "", done: false, due: null, repeat: null, priority: null, uid: null, projectPath: null, parentPath: null, collection: null, created: null, ...o,
});
const block = (taskUid: string): Occurrence => ({
  id: taskUid, kind: "timeblock", uid: `b-${taskUid}`, recurrenceId: null, itemUrl: "", calendarUrl: "", title: "",
  allDay: false, start: "2026-10-13T10:00", end: "2026-10-13T11:00", location: null, meeting: null, recurring: false, done: false,
  taskUid, invitation: null,
});

describe("the task panel", () => {
  it("starts the week on Monday", () => {
    expect(weekStart(new Date(2026, 9, 17, 15, 0))).toEqual(new Date(2026, 9, 12)); // a Saturday
    expect(weekStart(new Date(2026, 9, 12, 8, 0))).toEqual(new Date(2026, 9, 12)); // a Monday
    expect(weekStart(new Date(2026, 9, 18, 23, 0))).toEqual(new Date(2026, 9, 12)); // a Sunday
  });

  it("lists every open task, soonest deadline first, with its time blocks (waiting ones too)", () => {
    const tasks = [
      task({ path: "a", basename: "A", uid: "a", due: "2026-10-20" }),
      task({ path: "b", basename: "B", uid: "b" }),
      task({ path: "c", basename: "C", uid: null }),
      task({ path: "d", basename: "D", uid: "d", done: true }),
      task({ path: "e", basename: "E", uid: "e", due: "2026-10-15" }),
    ];
    const list = tasksToPlan(tasks, [block("b"), block("b"), block("d")], new Set(["c"]));
    expect(list.map((x) => `${x.task.basename}:${x.blocks}`)).toEqual(["E:0", "A:0", "B:2", "C:1"]);
  });

  it("puts the most urgent first among the same deadline", () => {
    const tasks = [
      task({ basename: "A", due: "2026-10-20" }),
      task({ basename: "B", due: "2026-10-20", priority: "low" }),
      task({ basename: "C", due: "2026-10-20", priority: "high" }),
      task({ basename: "D", due: "2026-10-19" }),
      task({ basename: "E", priority: "medium" }),
      task({ basename: "F" }),
    ];
    expect(tasksToPlan(tasks, [], new Set()).map((x) => x.task.basename)).toEqual(["D", "C", "B", "A", "E", "F"]);
  });
});
