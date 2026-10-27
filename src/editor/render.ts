import { setIcon, setTooltip } from "obsidian";
import { PRIORITY_MARK, type Priority } from "../constants";
import type { ChipModel } from "./chips";
import type { ChipKey } from "./fields-state";

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
export type EditFocus = "due" | "repeat" | "priority" | "tags" | null;

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
 * How the chips of a line are drawn: one marked by a first Backspace, those not drawn (the one whose field is open,
 * those just taken off), and which part this is when a field opened from a chip splits them (the chips before it
 * after the link, the rest after the field: the field stands in the chip's place).
 */
export interface ChipMarks {
  selected: ChipKey | null;
  hidden: ChipKey[];
  part?: { at: ChipKey; side: "before" | "after" };
}

/**
 * Priority (!!!, !!, !), deadline, repetition, tags (a chip each), progress and sync state, drawn after a task link.
 * Clicking a chip (or the pencil shown on hover) edits the task there: `key` is the chip (null for the pencil), `el`
 * what was clicked.
 */
export function renderChips(
  model: ChipModel,
  labels: RenderLabels,
  onEdit: (path: string, focus: EditFocus, el: HTMLElement, key: ChipKey | null) => void,
  marks?: ChipMarks,
): HTMLElement {
  const wrap = createSpan({ cls: "ct-task-chips" });
  const clickable = (el: HTMLElement, focus: EditFocus, tooltip: string, key: ChipKey | null) => {
    el.addClass("is-clickable");
    if (key) el.dataset.key = key;
    if (key && key === marks?.selected) el.addClass("is-selected");
    setTooltip(el, tooltip);
    // Keep the editor from moving the cursor into the link (which would reveal its source).
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onEdit(model.path, focus, el, key);
    });
  };
  const chips: { key: ChipKey; draw: () => void }[] = [];
  const priority = model.priority;
  if (priority) {
    chips.push({
      key: "priority",
      draw: () => clickable(wrap.createSpan({ cls: `ct-chip ct-chip-priority is-${priority}`, text: PRIORITY_MARK[priority] }), "priority", `${labels.priority[priority]} · ${labels.edit}`, "priority"),
    });
  }
  const due = model.due;
  if (due) {
    chips.push({
      key: "due",
      draw: () => {
        const chip = wrap.createSpan({ cls: `ct-chip ct-chip-due${due.overdue ? " is-overdue" : ""}` });
        setIcon(chip.createSpan({ cls: "ct-chip-icon" }), "flag");
        chip.appendText(due.text);
        clickable(chip, "due", `${labels.due} · ${labels.edit}`, "due");
      },
    });
  }
  const repeat = model.repeat;
  if (repeat) {
    chips.push({
      key: "repeat",
      draw: () => {
        const chip = wrap.createSpan({ cls: "ct-chip ct-chip-repeat" });
        setIcon(chip.createSpan({ cls: "ct-chip-icon" }), "repeat");
        chip.appendText(repeat);
        clickable(chip, "repeat", labels.edit, "repeat");
      },
    });
  }
  for (const tag of model.tags) {
    const key: ChipKey = `tag:${tag}`;
    chips.push({ key, draw: () => clickable(wrap.createSpan({ cls: "ct-chip ct-chip-tags", text: `#${tag}` }), "tags", labels.edit, key) });
  }
  const part = marks?.part;
  const split = part ? chips.findIndex((c) => c.key === part.at) : -1;
  chips.forEach((c, i) => {
    if (marks?.hidden.includes(c.key)) return;
    if (part && split >= 0 && (part.side === "before" ? i >= split : i <= split)) return;
    c.draw();
  });
  if (part?.side === "before") {
    wrap.addClass("is-before");
    return wrap; // the rest is drawn after the field
  }
  if (model.progress) wrap.createSpan({ cls: "ct-chip ct-chip-progress", text: model.progress });
  if (model.sync) {
    const icon = wrap.createSpan({ cls: `ct-sync ct-sync-${model.sync}` });
    setIcon(icon, model.sync === "pending" ? "cloud-upload" : "cloud-off");
    setTooltip(icon, model.sync === "pending" ? labels.pending : labels.local);
  }
  if (!model.done && !part) {
    const pencil = wrap.createSpan({ cls: "ct-chip-edit" });
    setIcon(pencil, "pencil");
    clickable(pencil, null, labels.edit, null);
  }
  return wrap;
}
