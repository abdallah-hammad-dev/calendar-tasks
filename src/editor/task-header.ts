import { Menu, setIcon, setTooltip } from "obsidian";
import { PRIORITY_MARK, type Priority } from "../constants";
import type { EditFocus } from "./render";

/** What the header of a task note shows (spec §5.4). */
export interface TaskHeaderModel {
  done: boolean;
  /** Its level, and what its tooltip says ("Priorité : haute"). */
  priority: { level: Priority; label: string } | null;
  due: { text: string; overdue: boolean } | null;
  /** "chaque lundi"… */
  repeat: string | null;
  /** Its tags, without "#". */
  tags: string[];
  parent: { name: string; path: string } | null;
  /** "2/5" child tasks done. */
  progress: string | null;
  /** Time blocks ahead, soonest first: label and local start. */
  blocks: { label: string; start: string }[];
  sync: "pending" | "local" | null;
  /** When it was made ("Créée hier"), the whole date in the tooltip. Shown faint: handy, not important. */
  created: { text: string; tooltip: string } | null;
  /** When it was ticked ("Faite hier", the whole date in the tooltip), said by its checkbox; null if not done or not known. */
  completed: { text: string; tooltip: string } | null;
  /**
   * A repeating task: each time it was done, newest first ("26 oct.", the whole date and time in the tooltip),
   * faint on the bar as far as there's room; a click lists them all.
   */
  history: { day: string; full: string }[] | null;
}

export interface TaskHeaderActions {
  toggle(): void;
  edit(focus: EditFocus): void;
  /** Opens a note (the parent task). */
  open(path: string): void;
  /** Adds a time block. */
  block(): void;
  /** Shows a time block in the calendar. */
  showBlock(start: string): void;
  properties: { shown: boolean; toggle(): void };
}

export interface TaskHeaderLabels {
  todo: string;
  done: string;
  deadline: string;
  addBlock: string;
  repeat: string;
  tags: string;
  parent: string;
  progress: string;
  history: string;
  edit: string;
  showProperties: string;
  hideProperties: string;
  pending: string;
  local: string;
}

/**
 * The bar above a task note: its checkbox and what it holds (priority, deadline, repetition, time blocks, tags, parent,
 * progress), each clickable, instead of the raw properties. Only what it has: the pencil adds the rest.
 */
export function renderTaskHeader(model: TaskHeaderModel, actions: TaskHeaderActions, labels: TaskHeaderLabels): HTMLElement {
  const header = createDiv({ cls: `ct-task-header${model.done ? " is-done" : ""}` });
  const inner = header.createDiv({ cls: "ct-task-header-inner" });

  const state = inner.createEl("label", { cls: "ct-task-header-state" });
  const box = state.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" });
  box.checked = model.done;
  box.addEventListener("click", (e) => {
    e.preventDefault();
    actions.toggle();
  });
  const word = state.createSpan({ text: model.done ? (model.completed?.text ?? labels.done) : labels.todo });
  if (model.done && model.completed) setTooltip(word, model.completed.tooltip);

  const item = (icon: string, text: string, tooltip: string, onClick: () => void, cls = "") => {
    const el = inner.createEl("button", { cls: `ct-task-header-item ${cls}`.trim() });
    setIcon(el.createSpan({ cls: "ct-chip-icon" }), icon);
    el.createSpan({ text });
    setTooltip(el, tooltip);
    el.addEventListener("click", onClick);
    return el;
  };
  if (model.priority) {
    // The marks alone, as on the links; the word is in the tooltip.
    const el = inner.createEl("button", { cls: `ct-task-header-item ct-priority is-${model.priority.level}` });
    el.createSpan({ cls: "ct-priority-mark", text: PRIORITY_MARK[model.priority.level] });
    setTooltip(el, model.priority.label);
    el.addEventListener("click", () => actions.edit("priority"));
  }
  if (model.due) item("flag", model.due.text, labels.deadline, () => actions.edit("due"), model.due.overdue ? "is-overdue" : "is-due");
  if (model.repeat) item("repeat", model.repeat, labels.repeat, () => actions.edit("repeat"));
  const next = model.blocks[0];
  if (next) {
    const more = model.blocks.length > 1 ? ` +${model.blocks.length - 1}` : "";
    item("clock", `${next.label}${more}`, model.blocks.map((b) => b.label).join("\n"), () => actions.showBlock(next.start));
    if (!model.done) {
      const add = inner.createEl("button", { cls: "clickable-icon ct-task-header-add" });
      setIcon(add, "plus");
      setTooltip(add, labels.addBlock);
      add.addEventListener("click", () => actions.block());
    }
  }
  if (model.tags.length) {
    // All in one item, as one field.
    const el = inner.createEl("button", { cls: "ct-task-header-item ct-task-header-tags", text: model.tags.map((tag) => `#${tag}`).join(" ") });
    setTooltip(el, labels.tags);
    el.addEventListener("click", () => actions.edit("tags"));
  }
  if (model.parent) {
    const path = model.parent.path;
    item("corner-left-up", model.parent.name, labels.parent, () => actions.open(path), "is-link");
  }
  if (model.progress) item("list-checks", model.progress, labels.progress, () => undefined, "is-static");
  if (model.sync) {
    const icon = inner.createSpan({ cls: `ct-sync ct-sync-${model.sync}` });
    setIcon(icon, model.sync === "pending" ? "cloud-upload" : "cloud-off");
    setTooltip(icon, model.sync === "pending" ? labels.pending : labels.local);
  }

  // Faint, in the room left before the tools, only what fits whole (never a line of its own): the times a repeating
  // task was done, newest first, then when it was made.
  const faint = inner.createDiv({ cls: "ct-task-header-faint" });
  const history = model.history ?? [];
  const showHistory = (at: HTMLElement) => {
    const menu = new Menu();
    for (const d of history) menu.addItem((i) => i.setTitle(d.full).setIcon("check"));
    const r = at.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  };
  history.forEach((d, i) => {
    const el = faint.createSpan({ cls: "ct-task-header-done-day" });
    if (i === 0) setIcon(el.createSpan({ cls: "ct-chip-icon" }), "check");
    el.createSpan({ text: d.day });
    setTooltip(el, d.full);
    el.addEventListener("click", () => showHistory(el));
  });
  if (model.created) setTooltip(faint.createSpan({ cls: "ct-task-header-created", text: model.created.text }), model.created.tooltip);
  const tools = inner.createDiv({ cls: "ct-task-header-tools" });
  const tool = (icon: string, tooltip: string, onClick: () => void, active = false) => {
    const el = tools.createEl("button", { cls: `clickable-icon${active ? " is-active" : ""}` });
    setIcon(el, icon);
    setTooltip(el, tooltip);
    el.addEventListener("click", onClick);
  };
  tool("pencil", labels.edit, () => actions.edit(null));
  const shown = actions.properties.shown;
  tool("list", shown ? labels.hideProperties : labels.showProperties, () => actions.properties.toggle(), shown);
  return header;
}
