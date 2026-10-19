import { Menu, setIcon, type Setting } from "obsidian";

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
}

export interface MenuSelect {
  el: HTMLButtonElement;
  /** `label`: for a value not among the options (it's added). */
  setValue(value: string, label?: string): void;
  focus(): void;
}

/**
 * A dropdown that opens Obsidian's own menu (themed, keyboard-friendly) instead of the system list, which looks
 * foreign (a blue Windows list in the middle of a modal). `extra`: an item after a separator ("Custom…").
 */
export function menuSelect(
  parent: HTMLElement,
  o: {
    options: SelectOption[];
    value: string;
    onChange: (value: string) => void;
    extra?: { label: string; icon?: string; run: () => void };
  },
): MenuSelect {
  let value = o.value;
  let options = o.options;
  const el = parent.createEl("button", { cls: "ct-select" });
  const label = el.createSpan({ cls: "ct-select-label" });
  setIcon(el.createSpan({ cls: "ct-select-chevron" }), "chevrons-up-down");
  const show = () => {
    const current = options.find((x) => x.value === value);
    label.setText(current?.label ?? value);
  };
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const menu = new Menu();
    for (const opt of options) {
      menu.addItem((item) => {
        item.setTitle(opt.label).setChecked(opt.value === value);
        if (opt.icon) item.setIcon(opt.icon);
        item.onClick(() => {
          value = opt.value;
          show();
          o.onChange(value);
        });
      });
    }
    if (o.extra) {
      const extra = o.extra;
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(extra.label).onClick(() => extra.run());
        if (extra.icon) item.setIcon(extra.icon);
      });
    }
    const r = el.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4, width: r.width });
  });
  show();
  return {
    el,
    setValue: (v: string, text?: string) => {
      if (!options.some((x) => x.value === v)) options = [...options, { value: v, label: text ?? v }];
      value = v;
      show();
    },
    focus: () => el.focus(),
  };
}

/** A setting row named with an icon before its name (the forms' rows). */
export function named(setting: Setting, icon: string, name: string): Setting {
  setting.setName(name);
  const el = createSpan({ cls: "ct-setting-icon" });
  setIcon(el, icon);
  setting.nameEl.prepend(el);
  return setting;
}
