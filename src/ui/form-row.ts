import { setIcon } from "obsidian";

/**
 * One line of a compact form (the new event form, an event's times): an icon (or none), its name, then its field,
 * in a grid whose columns line up from line to line (`.ct-form-grid`). Returns where the field goes.
 */
export function formRow(grid: HTMLElement, icon: string | null, name: string): HTMLElement {
  const i = grid.createSpan({ cls: "ct-form-icon" });
  if (icon) setIcon(i, icon);
  grid.createSpan({ cls: "ct-form-name", text: name });
  return grid.createDiv({ cls: "ct-form-field" });
}
