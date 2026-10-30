/**
 * Browser stand-in for the `obsidian` module, for UI previews only (copied from claude-workspace's
 * tools/ui-preview, plus getLanguage and number/folder controls).
 * Reproduces Obsidian's DOM helpers and the markup of Setting / Menu so that
 * Obsidian's real app.css styles our views the same way it does in the app.
 */
import { StateField } from "@codemirror/state";
import { createElement, icons } from "lucide";
import { marked } from "marked";
import type { SettingControl, SettingDefinitionGroup, SettingDefinitionItem, SettingGroup, SettingGroupItem } from "obsidian";

type DomInfo = {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  href?: string;
};

function applyInfo(el: HTMLElement, o?: DomInfo | string): void {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")).filter(Boolean));
  if (o.text !== undefined) {
    if (typeof o.text === "string") el.textContent = o.text;
    else el.appendChild(o.text);
  }
  for (const [k, v] of Object.entries(o.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, String(v));
  if (o.type) el.setAttribute("type", o.type);
  if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
  if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
  if (o.title) el.setAttribute("title", o.title);
  if (o.href) el.setAttribute("href", o.href);
}

function createEl(this: Node, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void): HTMLElement {
  const el = document.createElement(tag);
  applyInfo(el, o);
  this.appendChild(el);
  cb?.(el);
  return el;
}

const nodeProto = Node.prototype as unknown as Record<string, unknown>;
nodeProto.createEl = createEl;
nodeProto.createDiv = function (this: Node, o?: DomInfo | string) {
  return createEl.call(this, "div", o);
};
nodeProto.createSpan = function (this: Node, o?: DomInfo | string) {
  return createEl.call(this, "span", o);
};
nodeProto.empty = function (this: Node) {
  while (this.firstChild) this.removeChild(this.firstChild);
};
nodeProto.appendText = function (this: Node, t: string) {
  this.appendChild(document.createTextNode(t));
};
nodeProto.detach = function (this: Node) {
  this.parentNode?.removeChild(this);
};

const el = HTMLElement.prototype as unknown as Record<string, unknown>;
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto.setText = function (this: Element, t: string | DocumentFragment) {
  (this as unknown as { empty(): void }).empty();
  if (typeof t === "string") this.textContent = t;
  else this.appendChild(t);
};
elementProto.getText = function (this: Element) {
  return this.textContent ?? "";
};
elementProto.addClass = function (this: Element, ...c: string[]) {
  this.classList.add(...c.flatMap((x) => x.split(" ")).filter(Boolean));
};
elementProto.addClasses = function (this: Element, c: string[]) {
  this.classList.add(...c);
};
elementProto.removeClass = function (this: Element, ...c: string[]) {
  this.classList.remove(...c);
};
elementProto.toggleClass = function (this: Element, c: string | string[], v: boolean) {
  for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, v);
};
elementProto.hasClass = function (this: Element, c: string) {
  return this.classList.contains(c);
};
elementProto.setAttr = function (this: Element, k: string, v: string | number | boolean | null) {
  if (v === null || v === false) this.removeAttribute(k);
  else this.setAttribute(k, String(v));
};
el.show = function (this: HTMLElement) {
  this.style.display = "";
};
el.hide = function (this: HTMLElement) {
  this.style.display = "none";
};
el.toggle = function (this: HTMLElement, v: boolean) {
  this.style.display = v ? "" : "none";
};
el.isShown = function (this: HTMLElement) {
  return this.style.display !== "none" && this.isConnected;
};
el.onClickEvent = function (this: HTMLElement, cb: (e: MouseEvent) => void) {
  this.addEventListener("click", cb);
};
const fragProto = DocumentFragment.prototype as unknown as Record<string, unknown>;
fragProto.createEl = createEl;

const g = window as unknown as Record<string, unknown>;
g.createFragment = (cb?: (f: DocumentFragment) => void) => {
  const f = document.createDocumentFragment();
  cb?.(f);
  return f;
};
g.activeWindow = window;
g.activeDocument = document;
// Obsidian's global DOM helpers (detached elements).
const detached = (tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void) => {
  const el = document.createElement(tag);
  applyInfo(el, o);
  cb?.(el);
  return el;
};
g.createEl = detached;
g.createDiv = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => detached("div", o, cb);
g.createSpan = (o?: DomInfo | string, cb?: (el: HTMLElement) => void) => detached("span", o, cb);

// ───────────────────────── icons, tooltips, markdown ─────────────────────────

const pascal = (n: string) => n.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function setIcon(parent: HTMLElement, name: string): void {
  (parent as unknown as { empty(): void }).empty();
  const node = (icons as Record<string, unknown>)[pascal(name)];
  const svg = node
    ? (createElement(node as Parameters<typeof createElement>[0]) as unknown as SVGElement)
    : (createElement(icons.CircleHelp) as unknown as SVGElement);
  svg.setAttribute("class", `svg-icon lucide-${name}`);
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  if (!node) svg.style.color = "red"; // missing icon: make it obvious in screenshots
  parent.appendChild(svg);
}

export function setTooltip(target: HTMLElement, text: string): void {
  target.setAttribute("aria-label", text);
}

export const MarkdownRenderer = {
  render(_app: unknown, md: string, target: HTMLElement): Promise<void> {
    target.innerHTML = marked.parse(md, { async: false });
    return Promise.resolve();
  },
};

// ───────────────────────── basics ─────────────────────────

// `?phone=1`: Obsidian on an iPhone (the harness adds the body's classes and the app's frame).
const phone = new URLSearchParams(location.search).get("phone") === "1";
export const Platform = { isDesktopApp: !phone, isMobile: phone, isPhone: phone, isIosApp: phone };
export const getLanguage = (): string => new URLSearchParams(location.search).get("lang") ?? "fr";
export const Keymap = { isModEvent: () => false };
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T): T {
  return fn;
}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export class Notice {
  noticeEl = document.createElement("div");
  constructor(message: string) {
    console.log("[Notice]", message);
  }
}

export class TFolder {
  path = "";
}

export class TFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
}

export class Component {
  load(): void {}
  unload(): void {}
  register(): void {}
  registerEvent(): void {}
  registerDomEvent(el: EventTarget, type: string, cb: EventListener, options?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
  }
  addChild<T>(c: T): T {
    return c;
  }
}

export class View extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  app: unknown;
  constructor(public leaf: { app: unknown }) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.contentEl = (this.containerEl as unknown as { createDiv(o: string): HTMLElement }).createDiv("view-content");
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(): Promise<void> {}
  onPaneMenu(_menu: unknown, _source: string): void {}
}
export class ItemView extends View {}

/** Obsidian's modal markup: .modal-container > .modal-bg + .modal > .modal-title + .modal-content. */
export class Modal extends Component {
  containerEl = document.createElement("div");
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  scope = { register: (): void => undefined };
  constructor(public app: unknown) {
    super();
    const c = (p: HTMLElement, cls: string) => (p as unknown as { createDiv(o: string): HTMLElement }).createDiv(cls);
    this.containerEl.className = "modal-container mod-dim";
    c(this.containerEl, "modal-bg");
    this.modalEl = c(this.containerEl, "modal");
    const close = c(this.modalEl, "modal-header-button mod-raised clickable-icon");
    setIcon(close, "x");
    close.addEventListener("click", () => this.close());
    const header = c(this.modalEl, "modal-header");
    this.titleEl = c(header, "modal-title");
    this.contentEl = c(this.modalEl, "modal-content");
  }
  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }
  onOpen(): void {}
  onClose(): void {}
  open(): void {
    document.body.appendChild(this.containerEl);
    this.onOpen();
  }
  close(): void {
    this.onClose();
    this.containerEl.remove();
  }
}
export class SuggestModal<T> extends Modal {
  setPlaceholder(_p: string): void {}
  declare _t: T;
}

/** Obsidian's suggestions under a text box (.suggestion-container > .suggestion > .suggestion-item), on input. */
export abstract class AbstractInputSuggest<T> {
  limit = 100;
  suggestEl: HTMLElement | null = null;
  private picked: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  constructor(
    public app: unknown,
    private readonly textInputEl: HTMLInputElement | HTMLDivElement,
  ) {
    textInputEl.addEventListener("input", () => void this.update());
    textInputEl.addEventListener("focus", () => void this.update());
    document.addEventListener("scroll", () => this.suggestEl && this.reposition(this.textInputEl.getBoundingClientRect()), { capture: true, passive: true });
  }
  /** As Obsidian's, which doesn't know of a keyboard: under the field. */
  reposition(rect: DOMRect): void {
    Object.assign(this.suggestEl!.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.bottom + 5}px`, bottom: "", minWidth: `${rect.width}px` });
  }
  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }
  getValue(): string {
    return this.textInputEl instanceof HTMLInputElement ? this.textInputEl.value : (this.textInputEl.textContent ?? "");
  }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.picked?.(value, evt);
  }
  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.picked = callback;
    return this;
  }
  open(): void {}
  close(): void {
    this.suggestEl?.remove();
    this.suggestEl = null;
  }
  private async update(): Promise<void> {
    const items = (await this.getSuggestions(this.getValue())).slice(0, this.limit || undefined);
    this.close();
    if (!items.length) return;
    const container = document.createElement("div");
    container.className = "suggestion-container";
    const list = container.appendChild(document.createElement("div"));
    list.className = "suggestion";
    items.forEach((item, i) => {
      const el = list.appendChild(document.createElement("div"));
      el.className = `suggestion-item${i === 0 ? " is-selected" : ""}`;
      this.renderSuggestion(item, el);
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectSuggestion(item, e);
      });
    });
    document.body.appendChild(container);
    this.suggestEl = container;
    this.reposition(this.textInputEl.getBoundingClientRect());
  }
}

// ───────────────────────── Menu (real markup) ─────────────────────────

class MenuItem {
  dom: HTMLElement;
  private iconEl: HTMLElement;
  private titleEl: HTMLElement;
  private click: (() => void) | null = null;
  /** Like Obsidian: a tap on an item closes the menu, then runs it. */
  constructor(menu: HTMLElement, hide: () => void) {
    this.dom = (menu as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item tappable");
    this.iconEl = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-icon");
    this.titleEl = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-title");
    this.dom.addEventListener("click", () => {
      hide();
      this.click?.();
    });
  }
  setTitle(t: string | DocumentFragment): this {
    (this.titleEl as unknown as { setText(t: string | DocumentFragment): void }).setText(t);
    return this;
  }
  setIcon(name: string | null): this {
    if (name) setIcon(this.iconEl, name);
    return this;
  }
  setChecked(c: boolean | null): this {
    if (c) {
      const check = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-icon mod-checked");
      setIcon(check, "check");
      this.dom.classList.add("mod-checked");
    }
    return this;
  }
  setSection(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  setWarning(w: boolean): this {
    this.dom.classList.toggle("mod-warning", w);
    return this;
  }
  onClick(cb: () => void): this {
    this.click = cb;
    return this;
  }
}

export class Menu extends Component {
  private dom = document.createElement("div");
  constructor() {
    super();
    this.dom.className = "menu";
    const scroll = document.createElement("div");
    scroll.className = "menu-scroll";
    this.dom.appendChild(scroll);
  }
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem(this.dom.firstElementChild as HTMLElement, () => this.hide()));
    return this;
  }
  addSeparator(): this {
    (this.dom.firstElementChild as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-separator");
    return this;
  }
  /** Like Obsidian: a mousedown or a click outside it (on the window, as it bubbles) hides it. */
  private outside = (e: Event): void => {
    if (!this.dom.contains(e.target as Node)) this.hide();
  };
  hide(): void {
    this.dom.remove();
    window.removeEventListener("mousedown", this.outside);
    window.removeEventListener("click", this.outside);
  }
  showAtPosition(pos: { x: number; y: number }): this {
    document.body.appendChild(this.dom);
    // After the click that opened it.
    setTimeout(() => {
      window.addEventListener("mousedown", this.outside);
      window.addEventListener("click", this.outside);
    }, 0);
    // Like Obsidian: keep the menu inside the window.
    this.dom.style.left = "0px";
    const w = this.dom.offsetWidth;
    const h = this.dom.offsetHeight;
    this.dom.style.left = `${Math.max(8, Math.min(pos.x, window.innerWidth - w - 8))}px`;
    this.dom.style.top = `${pos.y + h + 8 <= window.innerHeight ? pos.y : Math.max(8, pos.y - h - 4)}px`;
    return this;
  }
  showAtMouseEvent(e: MouseEvent): this {
    return this.showAtPosition({ x: e.clientX, y: e.clientY });
  }
}

// ───────────────────────── Setting (real markup) ─────────────────────────

abstract class ValueComponent<T> {
  protected cb: ((v: T) => unknown) | null = null;
  onChange(cb: (v: T) => unknown): this {
    this.cb = cb;
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private value = false;
  constructor(parent: HTMLElement) {
    super();
    this.toggleEl = (parent as unknown as { createDiv(o: string): HTMLElement }).createDiv("checkbox-container");
    this.toggleEl.appendChild(Object.assign(document.createElement("input"), { type: "checkbox", tabIndex: 0 }));
    this.toggleEl.addEventListener("click", () => this.setValue(!this.value));
  }
  /** As in Obsidian: a change calls back, even from code. */
  setValue(v: boolean): this {
    if (v === this.value) return this;
    this.value = v;
    this.toggleEl.classList.toggle("is-enabled", v);
    void this.cb?.(v);
    return this;
  }
  override setDisabled(d: boolean): this {
    this.toggleEl.classList.toggle("is-disabled", d);
    return this;
  }
}

class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement | HTMLTextAreaElement;
  constructor(parent: HTMLElement, tag: "input" | "textarea") {
    super();
    this.inputEl = document.createElement(tag);
    if (tag === "input") this.inputEl.setAttribute("type", "text");
    parent.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => void this.cb?.(this.inputEl.value));
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
  override setDisabled(d: boolean): this {
    this.inputEl.disabled = d;
    return this;
  }
}

class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  constructor(parent: HTMLElement) {
    super();
    this.selectEl = document.createElement("select");
    this.selectEl.className = "dropdown";
    parent.appendChild(this.selectEl);
    this.selectEl.addEventListener("change", () => void this.cb?.(this.selectEl.value));
  }
  addOption(value: string, display: string): this {
    this.selectEl.appendChild(Object.assign(document.createElement("option"), { value, textContent: display }));
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }
  setValue(v: string): this {
    this.selectEl.value = v;
    return this;
  }
  override setDisabled(d: boolean): this {
    this.selectEl.disabled = d;
    return this;
  }
}

/** Obsidian 1.14's keychain picker: masked value with a clear button once linked, then "Change" (or "Link..."). */
export class SecretComponent extends ValueComponent<string | null> {
  private valueEl: HTMLElement;
  private buttonEl: HTMLButtonElement;
  constructor(_app: unknown, parent: HTMLElement) {
    super();
    this.valueEl = (parent as unknown as { createDiv(o: string): HTMLElement }).createDiv("setting-secret-value");
    this.buttonEl = document.createElement("button");
    parent.appendChild(this.buttonEl);
  }
  setValue(v: string | null): this {
    (this.valueEl as unknown as { empty(): void }).empty();
    this.buttonEl.textContent = v ? "Change" : "Link...";
    if (v) {
      const chip = (this.valueEl as unknown as { createSpan(o: string): HTMLElement }).createSpan("setting-hotkey");
      (chip as unknown as { createSpan(o: object): HTMLElement }).createSpan({ cls: "setting-password", text: "\u2022".repeat(7) });
      setIcon((chip as unknown as { createSpan(o: string): HTMLElement }).createSpan("setting-hotkey-icon"), "x");
    }
    return this;
  }
  override setDisabled(d: boolean): this {
    this.buttonEl.disabled = d;
    return this;
  }
}

class ExtraButtonComponent {
  extraSettingsEl: HTMLElement;
  constructor(parent: HTMLElement) {
    this.extraSettingsEl = (parent as unknown as { createDiv(o: string): HTMLElement }).createDiv("clickable-icon extra-setting-button");
  }
  setIcon(name: string): this {
    setIcon(this.extraSettingsEl, name);
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  onClick(cb: () => unknown): this {
    this.extraSettingsEl.addEventListener("click", () => void cb());
    return this;
  }
}

class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement("button");
    parent.appendChild(this.buttonEl);
  }
  setButtonText(t: string): this {
    this.buttonEl.textContent = t;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  /** Since 1.14: destructive + call to action. */
  setWarning(): this {
    this.buttonEl.classList.add("mod-destructive", "mod-cta");
    return this;
  }
  setDisabled(d: boolean): this {
    this.buttonEl.disabled = d;
    return this;
  }
  onClick(cb: () => unknown): this {
    this.buttonEl.addEventListener("click", () => void cb());
    return this;
  }
}

type Disableable = { setDisabled(d: boolean): unknown };

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  private components: Disableable[] = [];
  constructor(container: HTMLElement) {
    const c = (p: HTMLElement, cls: string) => (p as unknown as { createDiv(o: string): HTMLElement }).createDiv(cls);
    this.settingEl = c(container, "setting-item");
    this.settingEl.tabIndex = -1;
    this.infoEl = c(this.settingEl, "setting-item-info");
    this.nameEl = c(this.infoEl, "setting-item-name");
    this.descEl = c(this.infoEl, "setting-item-description");
    this.controlEl = c(this.settingEl, "setting-item-control");
  }
  setName(n: string | DocumentFragment): this {
    (this.nameEl as unknown as { setText(t: string | DocumentFragment): void }).setText(n);
    return this;
  }
  setDesc(d: string | DocumentFragment): this {
    (this.descEl as unknown as { setText(t: string | DocumentFragment): void }).setText(d);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setDisabled(d: boolean): this {
    this.settingEl.classList.toggle("is-disabled", d);
    for (const c of this.components) c.setDisabled(d);
    return this;
  }
  private add<T extends Disableable>(c: T, cb: (c: T) => unknown): this {
    this.components.push(c);
    cb(c);
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => unknown): this {
    this.settingEl.classList.add("mod-toggle");
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addText(cb: (t: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl, "input"), cb);
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl, "textarea"), cb);
  }
  addDropdown(cb: (d: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb: (b: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  addComponent(cb: (el: HTMLElement) => unknown): this {
    const c = cb(this.controlEl) as Partial<Disableable> | undefined;
    if (typeof c?.setDisabled === "function") this.components.push(c as Disableable);
    return this;
  }
}

// ───────────────────────── declarative settings (1.13+) ─────────────────────────

interface RenderedRow {
  def: SettingGroupItem;
  setting: Setting;
  cleanup?: () => void;
}
interface RenderedGroup {
  def: SettingDefinitionGroup;
  el: HTMLElement;
  rows: RenderedRow[];
}

const isGroup = (d: SettingDefinitionItem): d is SettingDefinitionGroup => "type" in d && (d.type === "group" || d.type === "list");
const evaluate = (v: boolean | (() => boolean) | undefined, fallback: boolean) => (v === undefined ? fallback : typeof v === "function" ? v() : v);

/**
 * Obsidian's SettingTab, rendering `getSettingDefinitions()` roughly like app.js does: rows outside a
 * group go into a group without heading, groups use SettingGroup's markup, `visible`/`disabled` are
 * applied by refreshDomState(). Redraws everything instead of reconciling rows. Pages, lists' add/delete/
 * reorder, search and number/file/folder/slider/color controls are left out until a scenario needs them.
 */
export class PluginSettingTab {
  containerEl = document.createElement("div");
  settingItems: SettingDefinitionItem[] = [];
  private rendered: RenderedGroup[] = [];
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {
    this.containerEl.className = "vertical-tab-content";
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }
  getControlValue(_key: string): unknown {
    return undefined;
  }
  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
  update(): void {
    this.settingItems = this.getSettingDefinitions();
    if (this.containerEl.isConnected) this.display();
  }
  /** What Obsidian does when the tab is opened: draw the definitions kept by the last update(). */
  display(): void {
    for (const g of this.rendered) for (const r of g.rows) r.cleanup?.();
    (this.containerEl as unknown as { empty(): void }).empty();
    const groups: SettingDefinitionGroup[] = [];
    let loose: SettingGroupItem[] | null = null;
    for (const item of this.settingItems) {
      if (isGroup(item)) {
        groups.push(item);
        loose = null;
      } else {
        if (!loose) groups.push({ type: "group", items: (loose = []) });
        loose.push(item as SettingGroupItem);
      }
    }
    this.rendered = groups.map((g) => this.renderGroup(g));
    this.refreshDomState();
  }
  refreshDomState(): void {
    for (const g of this.rendered) {
      let anyRowShown = false;
      for (const { def, setting } of g.rows) {
        const shown = evaluate(def.visible, true);
        (setting.settingEl as unknown as { toggle(v: boolean): void }).toggle(shown);
        anyRowShown ||= shown;
        if ("type" in def) continue;
        const disabled = "disabled" in def ? def.disabled : def.control?.disabled;
        if (disabled !== undefined) setting.setDisabled(evaluate(disabled, false));
      }
      (g.el as unknown as { toggle(v: boolean): void }).toggle(evaluate(g.def.visible, true) && (!g.rows.length || anyRowShown));
    }
  }
  hide(): void {}

  private renderGroup(def: SettingDefinitionGroup): RenderedGroup {
    const div = (p: HTMLElement, cls: string) => (p as unknown as { createDiv(o: string): HTMLElement }).createDiv(cls);
    const el = div(this.containerEl, "setting-group");
    if (def.type === "list") el.classList.add("mod-list");
    if (def.cls) el.classList.add(...def.cls.split(" ").filter(Boolean));
    if (def.heading) {
      const head = div(el, "setting-item setting-item-heading");
      div(head, "setting-item-name").textContent = def.heading;
      div(head, "setting-item-control");
    }
    div(el, "setting-group-search");
    const listEl = div(el, "setting-items");
    const group = { listEl } as unknown as SettingGroup;
    const rows = (def.items ?? []).map((item) => this.renderRow(item, listEl, group));
    return { def, el, rows };
  }

  private renderRow(def: SettingGroupItem, listEl: HTMLElement, group: SettingGroup): RenderedRow {
    const setting = new Setting(listEl);
    const row: RenderedRow = { def, setting };
    setting.setName(def.name);
    setting.setDesc(def.desc ? (typeof def.desc === "string" ? def.desc : (def.desc.cloneNode(true) as DocumentFragment)) : "");
    if ("type" in def) {
      setting.settingEl.classList.add("mod-navigable", "tappable");
      setIcon((setting.controlEl as unknown as { createDiv(o: string): HTMLElement }).createDiv("setting-item-chevron"), "chevron-right");
    } else if (def.action) {
      const action = def.action;
      setting.settingEl.classList.add("mod-action", "tappable");
      setting.settingEl.addEventListener("click", () => action(setting.settingEl, 0));
    } else if (def.render) {
      // Obsidian's Setting/SettingGroup types are richer than these stand-ins; the callbacks only use what is here.
      const cleanup = def.render(setting as never, group);
      if (cleanup) row.cleanup = cleanup;
    } else if (def.control) {
      this.renderControl(setting, def.control);
    }
    return row;
  }

  private renderControl(setting: Setting, control: SettingControl): void {
    const value = this.getControlValue(control.key) ?? control.defaultValue;
    const onChange = async (v: unknown) => {
      await this.setControlValue(control.key, v);
      this.refreshDomState();
    };
    switch (control.type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(value === true).onChange(onChange));
        break;
      case "dropdown":
        setting.addDropdown((d) => {
          for (const [k, label] of Object.entries(control.options)) d.addOption(k, label);
          d.setValue(String(value ?? "")).onChange(onChange);
        });
        break;
      case "text":
      case "textarea":
        setting[control.type === "text" ? "addText" : "addTextArea"]((t) => {
          if (control.placeholder) t.setPlaceholder(control.placeholder);
          if (control.type === "textarea" && control.rows !== undefined) (t.inputEl as HTMLTextAreaElement).rows = control.rows;
          t.setValue(typeof value === "string" ? value : "").onChange(onChange);
        });
        break;
      case "number":
      case "folder":
      case "file":
        setting.addText((t) => {
          if ("placeholder" in control && control.placeholder) t.setPlaceholder(control.placeholder);
          t.setValue(value === undefined || value === null ? "" : String(value as string | number)).onChange(onChange);
        });
        break;
      case "secret":
        setting.addComponent((el) => new SecretComponent(this.app, el).setValue(typeof value === "string" ? value : "").onChange(onChange));
        break;
      default:
        throw new Error(`ui-preview: "${control.type}" controls aren't drawn yet (tools/ui-preview/obsidian-browser.ts)`);
    }
  }
}

export class Plugin extends Component {}
export class EditorSuggest<T> {
  context: unknown = null;
  constructor(public app: unknown) {}
  declare _t?: T;
}
/** The note an editor shows; a scenario sets it with `editorInfoField.init`. */
export const editorInfoField = StateField.define<{ file: { path: string } | null }>({ create: () => ({ file: null }), update: (v) => v });
export class WorkspaceLeaf {}
export class MarkdownView {}
export class FileView {}
