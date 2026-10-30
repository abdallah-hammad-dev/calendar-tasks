import { Platform, type Modal } from "obsidian";

/**
 * A form as a sheet on a phone, as iOS's own (Reminders, Calendar): Cancel and the action at the top, where the
 * keyboard can't cover them; the sheet above the keyboard (Obsidian's `--keyboard-height`, styles.css); the field
 * being typed in scrolled into sight, and one with suggestions under it (`.ct-sheet-top`) to the top, so they show
 * above the keyboard (2026-10-30: the keyboard covered the tags and their suggestions). Call it once the form and
 * its `.ct-modal-buttons` row are drawn; elsewhere it does nothing.
 */
export function formSheet(modal: Modal): void {
  if (!Platform.isPhone) return;
  const { containerEl, modalEl, contentEl, titleEl } = modal;
  containerEl.addClass("ct-sheet-container");
  modalEl.addClass("ct-sheet");
  const row = contentEl.querySelector(".ct-modal-buttons");
  const buttons = row ? Array.from(row.querySelectorAll("button")) : [];
  const header = titleEl.parentElement;
  const cancel = buttons[0];
  const action = buttons[buttons.length - 1];
  if (row && header && cancel && action && cancel !== action) {
    cancel.addClass("ct-sheet-cancel");
    action.addClass("ct-sheet-action");
    header.prepend(cancel);
    header.append(action);
    row.remove();
  }
  contentEl.addEventListener("focusin", (e) => {
    const field = e.target;
    if (!(field instanceof HTMLElement) || !field.matches("input, textarea")) return;
    // Once the keyboard is up: the sheet shrinks as it comes.
    window.setTimeout(() => field.scrollIntoView({ block: field.matches(".ct-sheet-top") ? "start" : "nearest", behavior: "smooth" }), 350);
  });
}
