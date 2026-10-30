import { Platform, setIcon, type Modal } from "obsidian";

/**
 * A form as a sheet on a phone, as iOS's own (Calendar) and Obsidian's since 1.14: ✕ and ✓ at the top, where the
 * keyboard can't cover them; the sheet above the keyboard (Obsidian's `--keyboard-height`, styles.css); the field
 * being typed in scrolled just into sight, right above the keyboard (2026-10-30: the user's Apple Calendar
 * stops on the field; ours went on to an empty sheet). Call it once the form and its `.ct-modal-buttons` row are
 * drawn; elsewhere it does nothing.
 */
export function formSheet(modal: Modal): void {
  if (!Platform.isPhone) return;
  const { containerEl, modalEl, contentEl, titleEl } = modal;
  containerEl.addClass("ct-sheet-container");
  modalEl.addClass("ct-sheet");
  const row = contentEl.querySelector(".ct-modal-buttons");
  const buttons = row ? Array.from(row.querySelectorAll("button")) : [];
  const header = titleEl.parentElement;
  const action = buttons[buttons.length - 1];
  // Obsidian's own ✕ stands for Cancel: it goes on the left, and the action becomes the ✓ on the right, a real
  // button still (its handler, `disabled`). `.modal-close-button` is its name before 1.14.
  const close = modalEl.querySelector(".modal-header-button, .modal-close-button");
  if (row && header && close && action && buttons.length > 1) {
    close.addClass("ct-sheet-close");
    action.setAttr("aria-label", action.textContent ?? "");
    action.empty();
    action.className = "modal-header-button mod-raised clickable-icon mod-cta ct-sheet-action";
    setIcon(action, "check");
    header.append(action);
    row.remove();
  }
  contentEl.addEventListener("focusin", (e) => {
    const field = e.target;
    if (!(field instanceof HTMLElement) || !field.matches("input, textarea")) return;
    // Once the keyboard is up: the sheet shrinks as it comes. Then Obsidian places the suggestions again, which it
    // does on a scroll: the field moved with the sheet, not with one.
    window.setTimeout(() => {
      field.scrollIntoView({ block: "nearest", behavior: "smooth" });
      contentEl.dispatchEvent(new Event("scroll"));
    }, 350);
  });
}
