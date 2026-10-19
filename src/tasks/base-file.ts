import { NOTE_TYPE, PROP } from "../constants";

export interface BaseFileLabels {
  task: string;
  due: string;
  repeat: string;
  priority: string;
  todo: string;
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
 * The task list as a Bases file (spec §7.2): all task notes, three table views. Written once; the user owns it
 * afterwards. Syntax: https://obsidian.md/help/bases/syntax
 */
export function taskBaseFile(l: BaseFileLabels): string {
  const notDone = `${PROP.done} != true`;
  const columns = (...extra: string[]) => ["    order:", `      - ${PROP.done}`, "      - file.name", ...extra.map((c) => `      - ${c}`)];
  const sortBy = (...props: string[]) => ["    sort:", ...props.flatMap((p) => [`      - property: ${p}`, "        direction: ASC"])];
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
    "views:",
    "  - type: table",
    `    name: ${JSON.stringify(l.todo)}`,
    "    filters:",
    "      and:",
    `        - '${notDone}'`,
    ...columns(PROP.due, PROP.priority, PROP.repeat, PROP.project, PROP.collection),
    ...sortBy(PROP.due, "formula.urgency"),
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
    ...columns(PROP.due, PROP.project),
    "",
  ].join("\n");
}
