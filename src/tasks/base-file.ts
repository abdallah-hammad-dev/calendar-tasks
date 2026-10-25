import { NOTE_TYPE, PROP } from "../constants";

export interface BaseFileLabels {
  task: string;
  due: string;
  repeat: string;
  priority: string;
  created: string;
  completed: string;
  todo: string;
  noDue: string;
  byProject: string;
  done: string;
}

/**
 * How urgent a task is, as a number to sort on (`priority` is text: sorted as text, "high" < "low" < "medium"):
 * 1 high … 3 low, 4 none. The French words are read too, as the extension does.
 */
export const PRIORITY_RANK_FORMULA = (() => {
  const level = (en: string, fr: string) => `${PROP.priority} == "${en}" || ${PROP.priority} == "${fr}"`;
  return `if(${level("high", "haute")}, 1, if(${level("medium", "moyenne")}, 2, if(${level("low", "basse")}, 3, 4)))`;
})();

/**
 * The task list as a Bases file (spec §7.2): all task notes, four table views. Written once; the user owns it
 * afterwards. Syntax: https://obsidian.md/help/bases/syntax
 */
export function taskBaseFile(l: BaseFileLabels): string {
  const notDone = `${PROP.done} != true`;
  const columns = (...extra: string[]) => ["    order:", `      - ${PROP.done}`, "      - file.name", ...extra.map((c) => `      - ${c}`)];
  const sortBy = (...props: string[]) => ["    sort:", ...props.flatMap((p) => [`      - property: ${p}`, "        direction: ASC"])];
  const newestFirst = (prop: string) => ["    sort:", `      - property: ${prop}`, "        direction: DESC"];
  return [
    "filters:",
    "  and:",
    `    - '${PROP.type} == "${NOTE_TYPE.task}"'`,
    "formulas:",
    `  urgency: '${PRIORITY_RANK_FORMULA}'`,
    "properties:",
    "  file.name:",
    `    displayName: ${JSON.stringify(l.task)}`,
    `  ${PROP.due}:`,
    `    displayName: ${JSON.stringify(l.due)}`,
    `  ${PROP.repeat}:`,
    `    displayName: ${JSON.stringify(l.repeat)}`,
    `  ${PROP.priority}:`,
    `    displayName: ${JSON.stringify(l.priority)}`,
    `  ${PROP.created}:`,
    `    displayName: ${JSON.stringify(l.created)}`,
    `  ${PROP.completed}:`,
    `    displayName: ${JSON.stringify(l.completed)}`,
    "views:",
    "  - type: table",
    `    name: ${JSON.stringify(l.todo)}`,
    "    filters:",
    "      and:",
    `        - '${notDone}'`,
    ...columns(PROP.due, PROP.priority, PROP.repeat, PROP.project, PROP.collection),
    ...sortBy(PROP.due, "formula.urgency"),
    // Small tasks jotted down without a deadline, newest first (`isEmpty()` is true for a missing or empty value).
    "  - type: table",
    `    name: ${JSON.stringify(l.noDue)}`,
    "    filters:",
    "      and:",
    `        - '${notDone}'`,
    `        - '${PROP.due}.isEmpty()'`,
    ...columns(PROP.created, PROP.priority, PROP.project),
    ...newestFirst(PROP.created),
    "  - type: table",
    `    name: ${JSON.stringify(l.byProject)}`,
    "    filters:",
    "      and:",
    `        - '${notDone}'`,
    "    groupBy:",
    `      property: ${PROP.project}`,
    "      direction: ASC",
    ...columns(PROP.due, PROP.priority),
    ...sortBy(PROP.due, "formula.urgency"),
    "  - type: table",
    `    name: ${JSON.stringify(l.done)}`,
    "    filters:",
    "      and:",
    `        - '${PROP.done} == true'`,
    // The last ones done first (2026-10-25: when a task was ticked is kept).
    ...columns(PROP.completed, PROP.due, PROP.project),
    ...newestFirst(PROP.completed),
    "",
  ].join("\n");
}
