import { setIcon, setTooltip } from "obsidian";
import { PRIORITY_MARK, type Priority } from "../constants";
import type { ChipModel } from "./chips";

export interface RenderLabels {
  due: string;
  pending: string;
  local: string;
  toggle: string;
  edit: string;
  /** "Haute"…, said when the priority's marks are hovered. */
  priority: Record<Priority, string>;
}

/** The field a click on a chip opens the task form at. */
export type EditFocus = "due" | "repeat" | "priority" | "project" | null;

/** The checkbox drawn before a task link. Clicking it toggles the task note's `done`. */
export function renderCheckbox(model: ChipModel, labels: RenderLabels, onToggle: (path: string) => void): HTMLElement {
  const box = createEl("input", { cls: "task-list-item-checkbox ct-task-check", type: "checkbox" });
  box.checked = model.done;
  setTooltip(box, labels.toggle);
  // Keep the editor from moving the cursor into the link (which would reveal its source).
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(model.path);
  });
  return box;
}

/**
 * Priority (!!!, !!, !), deadline, repetition, project, progress and sync state, drawn after a task link. Clicking a chip (or the pencil
 * shown on hover) opens the task's form there.
 */
export function renderChips(model: ChipModel, labels: RenderLabels, onEdit: (path: string, focus: EditFocus) => void): HTMLElement {
  const wrap = createSpan({ cls: "ct-task-chips" });
  const clickable = (el: HTMLElement, focus: EditFocus, tooltip: string) => {
    el.addClass("is-clickable");
    setTooltip(el, tooltip);
    // Keep the editor from moving the cursor into the link (which would reveal its source).
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onEdit(model.path, focus);
    });
  };
  if (model.priority) {
    const chip = wrap.createSpan({ cls: `ct-chip ct-chip-priority is-${model.priority}`, text: PRIORITY_MARK[model.priority] });
    clickable(chip, "priority", `${labels.priority[model.priority]} · ${labels.edit}`);
  }
  if (model.due) {
    const chip = wrap.createSpan({ cls: `ct-chip ct-chip-due${model.due.overdue ? " is-overdue" : ""}` });
    setIcon(chip.createSpan({ cls: "ct-chip-icon" }), "flag");
    chip.appendText(model.due.text);
    clickable(chip, "due", `${labels.due} · ${labels.edit}`);
  }
  if (model.repeat) {
    const chip = wrap.createSpan({ cls: "ct-chip ct-chip-repeat" });
    setIcon(chip.createSpan({ cls: "ct-chip-icon" }), "repeat");
    chip.appendText(model.repeat);
    clickable(chip, "repeat", labels.edit);
  }
  if (model.project) clickable(wrap.createSpan({ cls: "ct-chip ct-chip-project", text: model.project }), "project", labels.edit);
  if (model.progress) wrap.createSpan({ cls: "ct-chip ct-chip-progress", text: model.progress });
  if (model.sync) {
    const icon = wrap.createSpan({ cls: `ct-sync ct-sync-${model.sync}` });
    setIcon(icon, model.sync === "pending" ? "cloud-upload" : "cloud-off");
    setTooltip(icon, model.sync === "pending" ? labels.pending : labels.local);
  }
  if (!model.done) {
    const pencil = wrap.createSpan({ cls: "ct-chip-edit" });
    setIcon(pencil, "pencil");
    clickable(pencil, null, labels.edit);
  }
  return wrap;
}
