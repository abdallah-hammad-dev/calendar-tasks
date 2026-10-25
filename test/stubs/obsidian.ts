/**
 * Minimal runtime stand-in for the `obsidian` module (which ships types only).
 * Add to it as tests need more surface; keep behavior dumb and observable.
 */

export const Platform = { isDesktopApp: true, isMobile: false, isWin: false, isMacOS: false, isLinux: true };

export class Notice {
  static last: string | undefined;
  constructor(public message: string) {
    Notice.last = message;
  }
}

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
}
export class TFile extends TAbstractFile {
  get extension(): string {
    return this.name.includes(".") ? (this.name.split(".").pop() ?? "") : "";
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
}
export class TFolder extends TAbstractFile {}

export class Component {
  load(): void {}
  unload(): void {}
}

export class View extends Component {
  contentEl: any = makeEl();
  containerEl: any = makeEl();
  constructor(public leaf: WorkspaceLeaf) {
    super();
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}
export class ItemView extends View {}
export class FileView extends ItemView {
  file: TFile | null = null;
}

export class WorkspaceLeaf {
  view: View | null = null;
}

export class Workspace {
  detached: string[] = [];
  detachLeavesOfType(type: string): void {
    this.detached.push(type);
  }
  onLayoutReady(cb: () => void): void {
    cb();
  }
  getActiveFile(): TFile | null {
    return null;
  }
}

export class App {
  workspace = new Workspace();
}

export class Plugin extends Component {
  commands = new Map<string, any>();
  views = new Map<string, (leaf: WorkspaceLeaf) => View>();
  savedData: unknown = undefined;
  constructor(
    public app: App = new App(),
    public manifest: any = { id: "calendar-tasks", version: "0.0.0" },
  ) {
    super();
  }
  addCommand(cmd: any): any {
    this.commands.set(cmd.id, cmd);
    return cmd;
  }
  removeCommand(id: string): void {
    this.commands.delete(id);
  }
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    if (this.views.has(type)) throw new Error(`Attempting to register an existing view type "${type}"`);
    this.views.set(type, creator);
  }
  addSettingTab(_tab: unknown): void {}
  registerEvent(_ref: unknown): void {}
  async loadData(): Promise<unknown> {
    return this.savedData;
  }
  async saveData(data: unknown): Promise<void> {
    this.savedData = structuredClone(data);
  }
}

export class PluginSettingTab {
  containerEl: any = makeEl();
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
  display(): void {}
}

export class Setting {
  constructor(_el: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addTextArea(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
}

function makeEl(): any {
  const el: any = {
    text: "",
    children: [] as any[],
    empty() {
      el.children = [];
      el.text = "";
    },
    setText(t: string) {
      el.text = t;
    },
    createDiv() {
      const c = makeEl();
      el.children.push(c);
      return c;
    },
    createEl() {
      return el.createDiv();
    },
  };
  return el;
}

/** Like Obsidian's: an empty path becomes "/" (the vault root). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "") || "/";
}

export class MarkdownView extends FileView {
  getMode(): string {
    return "source";
  }
}

export function debounce<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}

export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}
export class SuggestModal<T> extends Modal {
  setPlaceholder(_p: string): void {}
  declare _item: T;
}
export abstract class AbstractInputSuggest<T> {
  constructor(
    public app: unknown,
    _input: unknown,
  ) {}
  setValue(_v: string): void {}
  close(): void {}
  declare _item: T;
}
export function setIcon(_el: unknown, _name: string): void {}
export function setTooltip(_el: unknown, _text: string): void {}
export const MarkdownRenderer = { render: async () => undefined };
export const Keymap = { isModEvent: () => false };
export class Menu {
  addItem(): this {
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtPosition(): this {
    return this;
  }
}

/** `getLanguage()` (1.8+). Tests set `language.current`. */
export const language = { current: "en" };
export function getLanguage(): string {
  return language.current;
}
