import { getLinkpath, type MarkdownPostProcessorContext } from "obsidian";
import type { ChipModel } from "./chips";

export interface ReadingDeps {
  model(linkpath: string, sourcePath: string): ChipModel | null;
  checkbox(model: ChipModel): HTMLElement;
  chips(model: ChipModel): HTMLElement;
}

/** Reading view: the same checkboxes and chips around rendered links to task notes. */
export function decorateRendered(el: HTMLElement, ctx: MarkdownPostProcessorContext, deps: ReadingDeps): void {
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
    if (a.previousElementSibling?.classList.contains("ct-task-check")) continue;
    const href = a.getAttribute("data-href");
    const model = href ? deps.model(getLinkpath(href), ctx.sourcePath) : null;
    if (!model) continue;
    if (model.done) a.addClass("ct-task-done");
    a.before(deps.checkbox(model));
    a.after(deps.chips(model));
  }
}
