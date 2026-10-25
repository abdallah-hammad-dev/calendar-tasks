import { getAllTags, getLanguage, MarkdownView, Menu, Notice, Platform, Plugin, TFile, type Editor } from "obsidian";
import type { Line, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ItemCatalog } from "./calendar/catalog";
import { wholeDevicePixels } from "./calendar/device-pixels";
import { CALENDAR_VIEW, CalendarView, type CalendarEntry, type CalendarHost } from "./calendar/CalendarView";
import { EventNotes, noteDate, type EventDateFormat } from "./calendar/event-notes";
import { expandItem, findOccurrence, pickOccurrence, type Occurrence } from "./calendar/expand";
import { tasksToPlan, weekStart } from "./calendar/plan";
import type { PreviewSource } from "./calendar/day-preview";
import { ConfirmModal, type EventChoice, type EventFormOptions } from "./calendar/modals";
import { TaskModal, type NewTask } from "./tasks/modals";
import { cancelOccurrence, editEvent, endSeries, isMirror, moveEvent, newEvent, renameEvent, setPartstat, type EventEdit, type PartStat } from "./calendar/vevent";
import { CalDavClient } from "./caldav/client";
import { itemInfo } from "./caldav/ical";
import { createCalendarModule, type CalendarServices } from "./claude/module";
import { claudeWorkspaceApi } from "./claude/workspace-api";
import { NOTE_TYPE, PROP, PROTOCOL_ACTION, type Priority } from "./constants";
import { obsidianTransport } from "./caldav/transport";
import { domParser } from "./caldav/xml";
import { chipModel, dueLabel, pastLabel, type ChipModel } from "./editor/chips";
import { linkLineEdit, parseTaskLine, plannedFrontmatter } from "./editor/convert";
import { TaskConverter } from "./editor/converter";
import { blockLabel, DateSuggest, shortDay, slotLabel } from "./editor/date-suggest";
import { repeatFromNote, repeatLabel, repeatToNote, taskEdit, type Block, type WhenToken } from "./editor/when";
import { refreshTaskDecorations, taskEditorExtension } from "./editor/live-preview";
import { decorateRendered } from "./editor/reading-view";
import { renderCheckbox, renderChips, type EditFocus, type RenderLabels } from "./editor/render";
import { joinText, meetingHost, openLabel, whenText } from "./calendar/event-card";
import { renderEventHeader } from "./editor/event-header";
import { renderTaskHeader, type TaskHeaderModel } from "./editor/task-header";
import { DatePickerModal } from "./editor/date-picker";
import { t } from "./i18n";
import { formatLocalDate, formatLocalDateTime, localZone, wallClock } from "./ical/time";
import { mergeSettings, SettingsTab, type CalendarTasksSettings, type SettingsHost } from "./settings";
import { SyncEngine } from "./sync/engine";
import { IdbStore } from "./sync/store";
import { taskBaseFile } from "./tasks/base-file";
import { ObsidianVault } from "./tasks/obsidian-vault";
import { normalizeDue, sanitizeTitle, setDone, uniquePath } from "./tasks/notes";
import { sameTags, tagsOf } from "./tasks/tags";
import { TaskIndex, type TaskInfo } from "./tasks/task-index";
import { TaskSync } from "./tasks/TaskSync";

const FOCUS_SYNC_GAP_MS = 30_000;
const NOTE_DEBOUNCE_MS = 800;
const SYNC_DEBOUNCE_MS = 1_500;
const REDRAW_DEBOUNCE_MS = 200;
const CHIP_REFRESH_MS = 5 * 60_000;
const RESTART_DEBOUNCE_MS = 1_500;
const DAY_MS = 86_400_000;
const PALETTE = ["#4f8cff", "#e2725b", "#3fb68b", "#c678dd", "#d19a66", "#56b6c2"];

/** An event note and what it stands for: its occurrence (null if gone), and the times it says. */
interface EventOfNote {
  file: TFile;
  occ: Occurrence | null;
  start: string;
  end: string | null;
}

export default class CalendarTasksPlugin extends Plugin implements SettingsHost {
  declare settings: CalendarTasksSettings;
  /** Null until a server is configured. */
  sync: SyncEngine | null = null;
  tasks: TaskSync | null = null;
  private settingTab!: SettingsTab;
  private store!: IdbStore;
  private vaultPort!: ObsidianVault;
  private connection = "";
  private interval: number | null = null;
  private intervalMinutes = 0;
  private lastSync = 0;
  /** The last sync couldn't reach the server: queued changes wait for the next one. */
  private syncFailed = false;
  private syncTimer: number | null = null;
  private noteTimers = new Map<string, number>();
  private calendarsShown = "";
  private warnedNoTaskCalendar = false;
  private index!: TaskIndex;
  private converter!: TaskConverter;
  /** Time blocks of task notes waiting for their reminder's UID (see `createBlocks`). */
  private pendingBlocks = new Map<string, Block[]>();
  /** The date format event notes were last named with (a change renames them). */
  private namedWith: EventDateFormat | null = null;
  private redrawTimer: number | null = null;
  private redrawData = false;
  private dayTimer: number | null = null;
  private restartTimer: number | null = null;
  private eventNotes!: EventNotes;
  private catalog!: ItemCatalog;

  override async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.namedWith = this.settings.eventDateFormat;
    this.store = new IdbStore(`calendar-tasks/${this.app.vault.getName()}`);
    this.vaultPort = new ObsidianVault(this.app);
    this.index = new TaskIndex(this.vaultPort);
    this.converter = new TaskConverter(this.app, this.vaultPort, () => this.settings, this.index, (path, blocks) =>
      this.pendingBlocks.set(path, blocks),
    );
    this.eventNotes = new EventNotes({
      vault: this.vaultPort,
      eventsFolder: () => this.settings.eventsFolder,
      dateFormat: () => this.settings.eventDateFormat,
    });
    this.catalog = new ItemCatalog(() => this.sync);
    this.settingTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingTab);
    // The calendar's dots and bars in whole device pixels, in this window and the ones popped out.
    this.register(wholeDevicePixels(window));
    this.registerEvent(this.app.workspace.on("window-open", (_win, popout) => this.register(wholeDevicePixels(popout))));
    this.addCommand({ id: "sync-now", name: t("command.syncNow"), callback: () => void this.syncNow(true) });
    this.addCommand({ id: "reset-cache", name: t("command.resetCache"), callback: () => void this.resetCache() });
    this.addCommand({
      id: "convert-to-task",
      name: t("command.convert"),
      icon: "list-checks",
      editorCallback: (editor, ctx) => void this.convertLines(editor, ctx.file?.path),
    });
    this.addRibbonIcon("list-plus", t("command.newTask"), () => this.openNewTask());
    this.addCommand({ id: "new-task", name: t("command.newTask"), icon: "list-plus", callback: () => this.openNewTask() });
    for (const [id, name, act] of [
      ["edit-task", t("command.editTask"), (path: string) => this.editTask(path, null)],
      ["block-time", t("command.blockTime"), (path: string) => this.pickSlot(path)],
      ["set-deadline", t("command.setDeadline"), (path: string) => this.pickDeadline(path)],
    ] as const) {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          const path = this.targetTask(view?.editor ?? null, view?.file?.path ?? null);
          if (!path) return false;
          if (!checking) act(path);
          return true;
        },
      });
    }
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const path = info.file?.path;
        if (!path) return;
        if (parseTaskLine(editor.getLine(editor.getCursor().line))) {
          menu.addItem((item) =>
            item
              .setTitle(t("command.convert"))
              .setIcon("list-checks")
              .onClick(() => void this.convertLines(editor, path)),
          );
        }
        const task = this.targetTask(editor, path);
        if (task) {
          menu.addItem((item) => item.setTitle(t("menu.editTask")).setIcon("pencil").onClick(() => this.editTask(task, null)));
          menu.addItem((item) => item.setTitle(t("menu.blockTime")).setIcon("clock").onClick(() => this.pickSlot(task)));
          menu.addItem((item) => item.setTitle(t("menu.deadline")).setIcon("flag").onClick(() => this.pickDeadline(task)));
        }
      }),
    );
    this.setUpEditor();
    this.registerView(CALENDAR_VIEW, (leaf) => new CalendarView(leaf, this.calendarHost()));
    this.addRibbonIcon("calendar", t("command.openCalendar"), () => void this.openCalendar());
    this.addCommand({ id: "open-calendar", name: t("command.openCalendar"), callback: () => void this.openCalendar() });
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => void this.openUid(params.uid, params.rid ?? null));

    this.registerDomEvent(window, "focus", () => {
      if (Date.now() - this.lastSync > FOCUS_SYNC_GAP_MS) void this.syncNow(false);
    });
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const was = this.index.get(file.path);
        this.index.refresh(file.path);
        const task = this.index.get(file.path);
        // Done for good (a repeating task comes back): its sessions that come back stop.
        if (was && task?.uid && !was.done && task.done && !task.repeat) void this.endSessions(task.uid);
        this.eventNotes.refresh(file.path);
        this.noteChanged(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.index.rename(oldPath, file.path);
        const blocks = this.pendingBlocks.get(oldPath);
        if (blocks) {
          this.pendingBlocks.delete(oldPath);
          this.pendingBlocks.set(file.path, blocks);
        }
        this.eventNotes.forget(oldPath);
        this.eventNotes.refresh(file.path);
        void this.tasks?.noteRenamed(oldPath, file.path);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("deleted", (file, prev) => {
        this.index.remove(file.path);
        this.eventNotes.forget(file.path);
        void this.tasks?.noteDeleted(file.path, prev?.frontmatter ?? null);
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.index.rebuild();
      this.eventNotes.rebuild();
      void this.restart();
      this.registerClaudeModule();
    });
  }

  override onunload(): void {
    for (const id of this.noteTimers.values()) window.clearTimeout(id);
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    if (this.dayTimer !== null) window.clearTimeout(this.dayTimer);
  }

  /** Checkboxes and chips on task links (both editor modes), and auto-conversion of dated checklist lines. */
  private setUpEditor(): void {
    const labels: RenderLabels = {
      due: t("chip.due"),
      pending: t("chip.pending"),
      local: t("chip.local"),
      toggle: t("chip.toggle"),
      edit: t("chip.edit"),
      priority: {
        high: t("priority.named", { level: t("priority.high").toLowerCase() }),
        medium: t("priority.named", { level: t("priority.medium").toLowerCase() }),
        low: t("priority.named", { level: t("priority.low").toLowerCase() }),
      },
    };
    const deps = {
      model: (linkpath: string, sourcePath: string) => this.chipFor(linkpath, sourcePath),
      toggle: (path: string) => void this.toggleTask(path),
      checkbox: (m: ChipModel) => renderCheckbox(m, labels, (path) => void this.toggleTask(path)),
      chips: (m: ChipModel) => renderChips(m, labels, (path, focus) => this.editTask(path, focus)),
    };
    this.registerEditorExtension(
      taskEditorExtension({ ...deps, lineLeft: (view, from, text, path) => void this.autoConvert(view, from, text, path) }),
    );
    this.registerEditorSuggest(
      new DateSuggest(this.app, {
        task: (linkpath, sourcePath) => {
          const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
          return (file && this.index.get(file.path)) ?? null;
        },
        edit: (path, found) => void this.applyEdit(path, found),
      }),
    );
    this.registerMarkdownPostProcessor((el, ctx) => decorateRendered(el, ctx, deps));
    this.register(this.index.onChange(() => this.scheduleRedraw()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateNoteHeaders()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateNoteHeaders()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateNoteHeaders()));
    // Chips and the calendar say "today" / "tomorrow" and turn red once a deadline has passed: keep them true.
    this.registerInterval(
      window.setInterval(() => {
        refreshTaskDecorations();
        this.updateNoteHeaders();
        for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW)) {
          if (leaf.view instanceof CalendarView) leaf.view.tick();
        }
      }, CHIP_REFRESH_MS),
    );
    this.scheduleNewDay();
  }

  /** Redraws everything just after midnight (chips, the calendar's today). */
  private scheduleNewDay(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 5, 0);
    this.dayTimer = window.setTimeout(() => {
      this.scheduleRedraw(true);
      this.scheduleNewDay();
    }, next.getTime() - now.getTime());
  }

  private chipFor(linkpath: string, sourcePath: string): ChipModel | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    const task = file && this.index.get(file.path);
    if (!task) return null;
    return chipModel(task, {
      contextTags: this.noteTags(sourcePath),
      children: this.index.childrenOf(task.path),
      sync: this.tasks ? this.tasks.syncState(task.uid) : "synced",
      now: new Date(),
      tz: localZone(),
      lang: getLanguage(),
      words: { today: t("chip.today"), tomorrow: t("chip.tomorrow") },
    });
  }

  /** Every tag of a note (properties and text), without "#". */
  private noteTags(path: string): string[] {
    const file = this.app.vault.getFileByPath(path);
    const cache = file && this.app.metadataCache.getFileCache(file);
    return cache ? tagsOf(getAllTags(cache) ?? []) : [];
  }

  /** The vault's tags, most used first: what the task form suggests. */
  private knownTags(): string[] {
    const count = new Map<string, { tag: string; n: number }>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(f);
      for (const tag of cache ? tagsOf(getAllTags(cache) ?? []) : []) {
        const seen = count.get(tag.toLowerCase());
        if (seen) seen.n++;
        else count.set(tag.toLowerCase(), { tag, n: 1 });
      }
    }
    return [...count.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((c) => c.tag);
  }

  /** Writes a new task note; TaskSync gives it its reminder. `parent` is a note path. */
  private async createTaskNote(task: {
    title: string;
    due?: string | null;
    /** RRULE. */
    repeat?: string | null;
    priority?: Priority | null;
    tags?: string[];
    parent?: string | null;
    collection?: string | null;
    body?: string;
  }): Promise<string> {
    const folder = this.settings.tasksFolder;
    const title = sanitizeTitle(task.title);
    const path = uniquePath((p) => this.vaultPort.exists(p), folder, title);
    const plan = {
      title,
      due: task.due ?? null,
      repeat: task.repeat ?? null,
      tags: task.tags ?? [],
      parent: task.parent ?? null,
      blocks: [],
      body: "",
    };
    const fm = plannedFrontmatter(plan, (target) => this.vaultPort.linkText(target, path));
    if (task.priority) fm[PROP.priority] = task.priority;
    if (task.collection) fm[PROP.collection] = task.collection;
    await this.vaultPort.ensureFolder(folder);
    await this.vaultPort.create(path, fm, task.body ?? "");
    return path;
  }

  /** The "New task" form, in the default collection. */
  private openNewTask(): void {
    const fallback = this.collectionFor("VTODO");
    new TaskModal(this.app, {
      preview: this.previewSource(null),
      knownTags: this.knownTags(),
      collections: this.writableCollections("VTODO").map((c) => c.info.displayName),
      collection: fallback ? (this.collections()[fallback] ?? null) : null,
      submit: (task) =>
        void this.createTaskNote(task)
          .then((path) => {
            if (task.blocks.length) this.pendingBlocks.set(path, task.blocks); // created once the task has its reminder
            new Notice(t("task.created", { name: path.split("/").pop()!.replace(/\.md$/, "") }));
          })
          .catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }))),
    }).open();
  }

  /**
   * The calendar for a form's day preview (none without a server). The task's own deadline is left out: the form
   * shows where it's being moved.
   */
  private previewSource(taskUid: string | null): PreviewSource | undefined {
    if (!this.sync) return undefined;
    const colors = new Map(this.calendarEntries().map((c) => [c.url, c.color]));
    return {
      occurrences: (from, to) => this.occurrences(from, to).filter((o) => !(o.kind === "deadline" && taskUid && o.taskUid === taskUid)),
      color: (url) => colors.get(url) ?? null,
      language: () => getLanguage(),
    };
  }

  /** The task form on a task already made (clicking its chips), starting at `focus`. */
  private editTask(path: string, focus: EditFocus): void {
    const task = this.index.get(path);
    if (!task) return;
    const planned = this.plannedBlocks(task);
    const where = task.uid ? this.tasks?.calendarOf(task.uid) : null;
    const collection = task.collection ?? (where ? (this.sync?.calendars().find((c) => c.info.url === where)?.info.displayName ?? null) : null);
    new TaskModal(this.app, {
      preview: this.previewSource(task.uid),
      knownTags: this.knownTags(),
      collections: this.writableCollections("VTODO").map((c) => c.info.displayName),
      collection,
      focus,
      edit: {
        title: task.basename,
        due: task.due,
        repeat: task.repeat,
        priority: task.priority,
        tags: task.tags,
        collection,
        planned: planned.length > 3 ? [...planned.slice(0, 3), { label: "…", start: null }] : planned,
      },
      submit: (form) =>
        void this.saveTaskForm(task, form).catch((e: unknown) =>
          new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) })),
        ),
    }).open();
  }

  /** Writes what the form changed: the note's properties, new time blocks, then its name. */
  private async saveTaskForm(before: TaskInfo, form: NewTask): Promise<void> {
    const file = this.app.vault.getFileByPath(before.path);
    if (!file) return;
    const collectionChanged = !!form.collection && form.collection !== before.collection;
    const priorityChanged = form.priority !== before.priority;
    const tagsChanged = !sameTags(form.tags, before.tags);
    if (form.due !== before.due || form.repeat !== before.repeat || priorityChanged || tagsChanged || collectionChanged) {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (form.due !== before.due) {
          if (form.due) fm[PROP.due] = form.due;
          else delete fm[PROP.due];
        }
        if (form.repeat !== before.repeat) {
          if (form.repeat) fm[PROP.repeat] = repeatToNote(form.repeat);
          else delete fm[PROP.repeat];
        }
        if (priorityChanged) {
          if (form.priority) fm[PROP.priority] = form.priority;
          else delete fm[PROP.priority];
        }
        if (tagsChanged) {
          if (form.tags.length) fm[PROP.tags] = form.tags;
          else delete fm[PROP.tags];
        }
        // The task moves there (TaskSync).
        if (collectionChanged) fm[PROP.collection] = form.collection;
      });
    }
    if (form.blocks.length) await this.blockTime(before.path, form.blocks);
    const title = sanitizeTitle(form.title);
    if (title && title !== before.basename) {
      const folder = before.path.includes("/") ? before.path.slice(0, before.path.lastIndexOf("/")) : "";
      await this.app.fileManager.renameFile(file, uniquePath((p) => this.vaultPort.exists(p), folder, title));
    }
  }

  /** A line's `@` tokens written after a task's link (`- [[Task]] @ven`): what they change on that task. */
  private async applyEdit(path: string, found: WhenToken): Promise<void> {
    const task = this.index.get(path);
    const file = this.app.vault.getFileByPath(path);
    if (!task || !file) return;
    const edit = taskEdit(found, task);
    if (edit.due !== undefined || edit.repeat !== undefined) {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (edit.due === null) delete fm[PROP.due];
        else if (edit.due) fm[PROP.due] = edit.due;
        if (edit.repeat === null) delete fm[PROP.repeat];
        else if (edit.repeat) fm[PROP.repeat] = repeatToNote(edit.repeat);
      });
    }
    if (edit.blocks.length) await this.blockTime(path, edit.blocks);
  }

  /** The task a command acts on: one linked on the cursor's line, else the note itself if it is a task. */
  private targetTask(editor: Editor | null, sourcePath: string | null): string | null {
    if (editor && sourcePath) {
      for (const m of editor.getLine(editor.getCursor().line).matchAll(/\[\[([^\]|#]+)/g)) {
        const file = this.app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), sourcePath);
        if (file && this.index.get(file.path)) return file.path;
      }
    }
    return sourcePath && this.index.get(sourcePath) ? sourcePath : null;
  }

  /** Asks for a day and a time, then sets the task's deadline (or removes it). */
  private pickDeadline(path: string): void {
    const due = this.index.get(path)?.due ?? null;
    new DatePickerModal(this.app, {
      mode: "due",
      value: due,
      pick: (value) => void this.setDeadline(path, value),
      remove: due ? { label: t("picker.noDeadline"), run: () => void this.setDeadline(path, null) } : undefined,
    }).open();
  }

  private async setDeadline(path: string, value: string | null): Promise<void> {
    if (this.tasks) return this.tasks.setDue(path, value);
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (value === null) delete fm[PROP.due];
      else fm[PROP.due] = value;
    });
  }

  /** Asks for a day and the hours (or the whole day), then blocks that time for the task. */
  private pickSlot(path: string): void {
    new DatePickerModal(this.app, { mode: "slot", pick: (block) => void this.blockTime(path, [block]) }).open();
  }

  /**
   * Time blocks for a task: created now if it's on the server, else as soon as it gets there. A notice says so,
   * unless `quiet` (dropped on the calendar, where it shows).
   */
  private async blockTime(path: string, blocks: Block[], quiet = false): Promise<void> {
    const uid = this.index.get(path)?.uid;
    if (uid) await this.addBlocks(uid, path, blocks, quiet);
    else {
      // Created when the task gets its reminder (`createBlocks`); meanwhile it isn't "to plan" any more.
      this.pendingBlocks.set(path, [...(this.pendingBlocks.get(path) ?? []), ...blocks]);
      new Notice(t("block.pending"));
      this.scheduleRedraw();
    }
  }

  private async toggleTask(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    const now = formatLocalDateTime(wallClock(new Date(), localZone()));
    if (file) await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => setDone(fm, fm.done !== true, now));
  }

  /**
   * Cursor left a `- [ ] … @date` line: convert it (spec §5.2). The line changes at once and the note is written
   * after; if writing fails, the line comes back.
   */
  private async autoConvert(view: EditorView, from: number, text: string, sourcePath: string): Promise<void> {
    if (!parseTaskLine(text)) return this.editFromLine(view, from, text, sourcePath);
    const task = this.converter.prepare(text, sourcePath, true);
    if (!task) return;
    await Promise.resolve(); // we're called from inside an editor update, which can't dispatch another
    const line = findLine(view.state.doc, from, text);
    if (!line) return task.cancel();
    view.dispatch({ changes: { from: line.from, to: line.to, insert: task.replacement } });
    try {
      await task.create();
      refreshTaskDecorations();
    } catch (e) {
      const back = findLine(view.state.doc, line.from, task.replacement);
      if (back) view.dispatch({ changes: { from: back.from, to: back.to, insert: text } });
      new Notice(t("convert.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Cursor left a `- [[Task]] @…` line: the `@` tokens change the task and leave the line. */
  private async editFromLine(view: EditorView, from: number, text: string, sourcePath: string): Promise<void> {
    const res = linkLineEdit(text, wallClock(new Date(), localZone()));
    const file = res && this.app.metadataCache.getFirstLinkpathDest(res.linkpath, sourcePath);
    if (!res || !file || !this.index.get(file.path)) return;
    await Promise.resolve(); // we're called from inside an editor update, which can't dispatch another
    const line = findLine(view.state.doc, from, text);
    if (!line) return;
    view.dispatch({ changes: { from: line.from, to: line.to, insert: res.rest } });
    await this.applyEdit(file.path, res.found);
  }

  /** "Convert to task" on the current line or every selected line, dated or not. */
  private async convertLines(editor: Editor, path: string | undefined): Promise<void> {
    if (!path) return;
    let converted = 0;
    const [first, last] = [editor.getCursor("from").line, editor.getCursor("to").line];
    for (let i = last; i >= first; i--) {
      const line = editor.getLine(i);
      const replacement = await this.converter.convert(line, path, false);
      if (replacement && editor.getLine(i) === line) {
        editor.replaceRange(replacement, { line: i, ch: 0 }, { line: i, ch: line.length });
        converted++;
      }
    }
    if (!converted) new Notice(t("convert.nothing"));
  }

  /**
   * Redraws what shows tasks, once changes settle. `data`: the calendar data changed (a sync, a TaskSync write), so
   * the calendar re-reads its events; otherwise (a note changed) only its task lists do: re-reading events then
   * would show the reminder's old state for a moment (a dragged deadline jumping back before its push).
   */
  private scheduleRedraw(data = false): void {
    this.redrawData ||= data;
    if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      const full = this.redrawData;
      this.redrawData = false;
      refreshTaskDecorations();
      if (full) this.refreshViews();
      else this.refreshTaskViews();
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
      }
    }, REDRAW_DEBOUNCE_MS);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Event notes take the new date in their names.
    if (this.settings.eventDateFormat !== this.namedWith) {
      this.namedWith = this.settings.eventDateFormat;
      void this.updateEventNotes();
    }
    if (this.connectionKey() !== this.connection) this.scheduleRestart();
    else if (this.settings.syncIntervalMinutes !== this.intervalMinutes) this.schedule();
  }

  /** Connection settings change on every keystroke: restart once typing pauses, not with half an address. */
  private scheduleRestart(): void {
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.connectionKey() !== this.connection) void this.restart();
    }, RESTART_DEBOUNCE_MS);
  }

  collections(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of this.writableCollections()) out[c.info.url] = c.info.displayName;
    return out;
  }

  /** Writable collections, by name; only those that can hold `component` when given. */
  private writableCollections(component?: "VEVENT" | "VTODO") {
    return (this.sync?.calendars() ?? [])
      .filter((c) => !c.info.readOnly && (!component || c.info.components.includes(component)))
      .sort((a, b) => a.info.displayName.localeCompare(b.info.displayName));
  }

  /** Where something new of this kind goes: `preferred` if it can hold it, else the default collection, else the first by name. */
  private collectionFor(component: "VEVENT" | "VTODO", preferred?: string | null): string | null {
    const cals = this.writableCollections(component);
    return (cals.find((c) => c.info.url === preferred) ?? cals.find((c) => c.info.url === this.settings.defaultCalendar) ?? cals[0])?.info.url ?? null;
  }

  /** Connects with the current settings, lists the calendars, then restarts syncing. */
  async testConnection(): Promise<void> {
    const client = this.client();
    if (!client) {
      new Notice(t("sync.notConfigured"));
      return;
    }
    try {
      const d = await client.discover();
      const calendars = await client.listCalendars(d.homeUrl);
      new Notice(t("connection.ok", { names: calendars.map((c) => c.displayName).join(", ") || "—" }));
      await this.restart();
    } catch (e) {
      new Notice(t("connection.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async syncNow(manual: boolean): Promise<void> {
    if (!this.sync) {
      if (manual) new Notice(t("sync.notConfigured"));
      return;
    }
    this.lastSync = Date.now();
    // Note edits still in their debounce window are queued first: the engine never pulls over a queued change,
    // and a refused push is merged field by field (TaskSync.onConflict).
    await this.flushNoteChanges();
    const r = await this.sync.sync();
    const failedChanged = !r.ok !== this.syncFailed;
    this.syncFailed = !r.ok;
    if (!r.ok) {
      console.warn(`[calendar-tasks] sync failed: ${r.error}`);
      if (manual) new Notice(t("sync.failed", { error: r.error ?? "?" }));
    } else {
      console.debug(`[calendar-tasks] synced ${r.calendars} calendars: ${r.pulled} pulled, ${r.pushed} pushed`);
      if (manual) new Notice(t("sync.done", { calendars: r.calendars, changes: r.pulled + r.pushed }));
    }
    this.catalog.invalidate();
    if (r.pulled) await this.updateEventNotes();
    // Redraw only when something moved; pushes turn the "waiting to sync" icons off, and an open card says
    // whether an answer reached the server (or can't, while it's unreachable).
    if (r.pulled || r.pushed || (failedChanged && this.sync.pendingCount)) this.scheduleRedraw(true);
    this.refreshSettingsIfCalendarsChanged();
  }

  /** (Re)creates the sync engine from the settings: at startup and when the connection settings change. */
  private async restart(): Promise<void> {
    this.connection = this.connectionKey();
    this.tasks = null;
    this.syncFailed = false;
    const client = this.client();
    this.sync = client
      ? new SyncEngine(client, this.store, `${this.settings.serverUrl}|${this.settings.username}`, {
          onChange: (c) => void this.tasks?.onServerChange(c),
          onConflict: (c) => void this.tasks?.onConflict(c),
        })
      : null;
    if (this.sync) {
      await this.sync.init();
      this.tasks = new TaskSync({
        vault: this.vaultPort,
        engine: this.sync,
        settings: () => this.settings,
        vaultName: this.app.vault.getName(),
        tz: localZone,
        newUid,
        // Every TaskSync write to the cache comes with this: deadlines and sync icons change.
        requestSync: () => {
          this.scheduleRedraw(true);
          this.requestSync();
        },
        notify: (name, kind, detail) => this.notify(name, kind, detail),
        created: (path, uid) => void this.createBlocks(path, uid),
      });
      this.tasks.rebuild();
      await this.tasks.pushAll(); // edits made while Obsidian was closed, before pulling over them
    }
    this.schedule();
    await this.syncNow(false);
    await this.tasks?.pullAll();
    this.catalog.invalidate();
    await this.updateEventNotes();
    this.refreshViews();
    await this.ensureBaseFile();
  }

  // —— calendar ——

  private calendarHost(): CalendarHost {
    return {
      occurrences: (from, to) => this.occurrences(from, to),
      calendars: () => this.calendarEntries(),
      updateCalendar: async (url, changes) => {
        try {
          if (!this.sync) throw new Error(t("sync.notConfigured"));
          await this.sync.updateCalendar(url, changes);
          this.refreshViews();
          return true;
        } catch (e) {
          new Notice(t("cal.updateFailed", { error: e instanceof Error ? e.message : String(e) }));
          return false;
        }
      },
      createCalendar: async (spec) => {
        try {
          if (!this.sync) throw new Error(t("sync.notConfigured"));
          await this.sync.createCalendar(newUid(), spec);
          this.refreshViews();
          this.refreshSettingsIfCalendarsChanged();
          return true;
        } catch (e) {
          new Notice(t("cal.createFailed", { error: e instanceof Error ? e.message : String(e) }));
          return false;
        }
      },
      deleteCalendar: (url) => this.deleteCalendar(url),
      toggleCalendar: (url) => {
        const hidden = new Set(this.settings.hiddenCalendars);
        if (!hidden.delete(url)) hidden.add(url);
        this.settings.hiddenCalendars = [...hidden];
        void this.saveData(this.settings);
      },
      open: (occ) => void this.openOccurrence(occ),
      hasNote: (occ) => this.hasEventNote(occ),
      syncState: (occ) => (!this.sync?.isPending(occ.itemUrl) ? "synced" : this.syncFailed ? "offline" : "queued"),
      sync: () => void this.syncNow(true),
      language: () => getLanguage(),
      editable: (occ) => this.editable(occ),
      move: (occ, start, end, allDay) => this.moveOccurrence(occ, start, end, allDay),
      newEvent: (start, end, allDay) => this.newEventOptions(start, end, allDay),
      editEvent: (occ) => this.editEventOptions(occ),
      editTask: (uid) => {
        const path = this.taskNotePath(uid);
        if (path) this.editTask(path, null);
      },
      pickSlotFor: (uid) => {
        const path = this.taskNotePath(uid);
        if (path) this.pickSlot(path);
      },
      remove: (occ, all) =>
        void this.removeOccurrence(occ, all).catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }))),
      menu: (occ, evt, edit) => this.occurrenceMenu(occ, evt, edit),
      planTasks: () => {
        const now = new Date();
        const ctx = { now, tz: localZone(), lang: getLanguage(), words: { today: t("chip.today"), tomorrow: t("chip.tomorrow") } };
        const blocks = this.occurrences(weekStart(now), new Date(now.getTime() + 90 * DAY_MS), true);
        return tasksToPlan(this.index.all(), blocks, new Set(this.pendingBlocks.keys())).map(({ task, blocks }) => ({
          path: task.path,
          title: task.basename,
          priority: task.priority,
          due: task.due ? dueLabel(task.due, false, ctx) : null,
          blocks,
        }));
      },
      planUnplannedOnly: () => this.settings.planUnplannedOnly,
      setPlanUnplannedOnly: (on) => {
        this.settings.planUnplannedOnly = on;
        void this.saveData(this.settings);
      },
      plan: (path, start, allDay) => {
        const tz = localZone();
        const block = allDay
          ? { start: formatLocalDate(wallClock(start, tz)), end: formatLocalDate(wallClock(new Date(start.getTime() + 86_400_000), tz)) }
          : { start: formatLocalDateTime(wallClock(start, tz)), end: formatLocalDateTime(wallClock(new Date(start.getTime() + 3_600_000), tz)) };
        void this.blockTime(path, [block], true);
      },
      pickSlot: (path) => this.pickSlot(path),
      newTask: () => this.openNewTask(),
      task: (uid) => {
        const path = this.taskNotePath(uid);
        const task = path ? this.index.get(path) : undefined;
        return task ? { title: task.basename, done: task.done } : null;
      },
      toggleTask: (uid) => {
        const path = this.taskNotePath(uid);
        if (path) void this.toggleTask(path);
      },
      rsvp: (occ, ps) => void this.rsvp(occ, ps).catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }))),
      savedView: () => this.settings.calendarView || null,
      saveView: (type) => {
        if (this.settings.calendarView === type) return;
        this.settings.calendarView = type;
        void this.saveData(this.settings);
      },
      planPanelOpen: () => this.settings.planPanelOpen,
      setPlanPanelOpen: (open) => {
        this.settings.planPanelOpen = open;
        void this.saveData(this.settings);
      },
    };
  }

  private taskNotePath(uid: string | null): string | null {
    return uid ? (this.tasks?.notePath(uid) ?? this.index.pathOfUid(uid)) : null;
  }

  private writableCalendar(url: string): boolean {
    return this.sync?.calendars().some((c) => c.info.url === url && !c.info.readOnly) ?? false;
  }

  /** Mirrored events and invitations can't be moved (only answered); deadlines move through their task note. */
  private editable(occ: Occurrence): boolean {
    if (occ.kind === "deadline") return !!this.taskNotePath(occ.taskUid);
    const data = this.sync?.item(occ.itemUrl)?.data;
    return !!data && this.writableCalendar(occ.calendarUrl) && !occ.invitation && !isMirror(data);
  }

  private async moveOccurrence(occ: Occurrence, start: Date, end: Date | null, allDay: boolean): Promise<boolean> {
    const tz = localZone();
    const local = (d: Date) => (allDay ? formatLocalDate(wallClock(d, tz)) : formatLocalDateTime(wallClock(d, tz)));
    try {
      if (occ.kind === "deadline") {
        const path = this.taskNotePath(occ.taskUid);
        if (!path) return false;
        await this.setDeadline(path, local(start));
        return true;
      }
      const data = this.sync?.item(occ.itemUrl)?.data;
      if (!data || !this.sync) return false;
      const fallbackEnd = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
      const updated = moveEvent(data, occ.recurring ? occ.recurrenceId : null, local(start), local(end ?? fallbackEnd), tz);
      await this.saveEvent(occ.calendarUrl, occ.itemUrl, updated);
      return true;
    } catch (e) {
      new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  }

  /**
   * Says what a collection holds and what becomes of the notes, then deletes it from the server. Its tasks'
   * notes end like a deleted reminder's (TaskSync: done, unlinked); a setting pointing at it goes back to automatic.
   */
  private deleteCalendar(url: string): void {
    const sync = this.sync;
    const cal = sync?.calendars().find((c) => c.info.url === url);
    if (!sync || !cal) return;
    let events = 0;
    let tasks = 0;
    let notes = 0;
    for (const it of Object.values(cal.items)) {
      const info = itemInfo(it.data);
      if (info?.kind === "VEVENT") events++;
      if (info?.kind !== "VTODO") continue;
      tasks++;
      if (this.tasks?.notePath(info.uid)) notes++;
    }
    const count = (n: number, one: "cal.count.event" | "cal.count.task", many: "cal.count.events" | "cal.count.tasks") =>
      n === 0 ? "" : n === 1 ? t(one) : t(many, { n });
    const what = [count(events, "cal.count.event", "cal.count.events"), count(tasks, "cal.count.task", "cal.count.tasks")].filter(Boolean).join(t("cal.and"));
    const name = cal.info.displayName;
    new ConfirmModal(this.app, {
      title: t("cal.deleteTitle", { name }),
      lines: [what ? t("cal.deleteHolds", { what }) : t("cal.deleteEmpty"), t("cal.deleteAll"), ...(notes ? [t("cal.deleteNotes")] : [])],
      action: t("menu.delete"),
      run: () =>
        void (async () => {
          await sync.deleteCalendar(url);
          if (this.settings.defaultCalendar === url) this.settings.defaultCalendar = "";
          this.settings.hiddenCalendars = this.settings.hiddenCalendars.filter((u) => u !== url);
          await this.saveData(this.settings);
          this.refreshViews();
          this.refreshSettingsIfCalendarsChanged();
          new Notice(t("cal.deleted", { name }));
        })().catch((e: unknown) => new Notice(t("cal.deleteFailed", { error: e instanceof Error ? e.message : String(e) }))),
    }).open();
  }

  private eventCalendars(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of this.sync?.calendars() ?? []) {
      if (!c.info.readOnly && c.info.components.includes("VEVENT")) out[c.info.url] = c.info.displayName;
    }
    return out;
  }

  /** Time blocks written on a task line (`@session mar 14h-16h`): events linked to the task, once it has a UID. */
  private async createBlocks(path: string, taskUid: string): Promise<void> {
    const blocks = this.pendingBlocks.get(path);
    this.pendingBlocks.delete(path);
    if (blocks?.length) await this.addBlocks(taskUid, path, blocks);
  }

  /** Events linked to a task (RELATED-TO), titled after it, in the task's collection (or the default one). */
  private async addBlocks(taskUid: string, path: string, blocks: Block[], quiet = false): Promise<void> {
    if (!this.sync) return;
    const calendarUrl = this.collectionFor("VEVENT", this.tasks?.calendarOf(taskUid));
    if (!calendarUrl) {
      new Notice(t("error.noEventCalendar"));
      return;
    }
    const title = path.split("/").pop()!.replace(/\.md$/, "");
    try {
      for (const b of blocks) {
        const uid = newUid();
        const data = newEvent(uid, { summary: title, start: b.start, end: b.end, relatedTo: taskUid, rrule: b.repeat }, localZone());
        await this.saveEvent(calendarUrl, this.sync.newItemUrl(calendarUrl, uid), data);
      }
      if (!quiet) new Notice(t("block.added", { list: blocks.map(blockLabel).join(", ") }));
    } catch (e) {
      new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Ends the series of work sessions of a task now done (`@session chaque mardi…`). */
  private async endSessions(taskUid: string): Promise<void> {
    for (const cal of this.sync?.calendars() ?? []) {
      if (!this.writableCalendar(cal.info.url)) continue;
      for (const [url, it] of Object.entries(cal.items)) {
        if (!it.data.includes(taskUid) || !/\nRRULE[:;]/.test(it.data) || isMirror(it.data)) continue;
        try {
          const ended = endSeries(it.data, taskUid, localZone());
          if (ended === "delete") await this.deleteEvent(url);
          else if (ended) await this.saveEvent(cal.info.url, url, ended.data);
        } catch (e) {
          console.warn(`[calendar-tasks] could not end a session series: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /** What the new event form needs for a selected range; null (with a notice) when there's nowhere to write it. */
  private newEventOptions(start: Date, end: Date, allDay: boolean): EventFormOptions | null {
    const calendars = this.eventCalendars();
    const urls = Object.keys(calendars);
    if (!this.sync || !urls.length) {
      new Notice(this.sync ? t("error.noEventCalendar") : t("sync.notConfigured"));
      return null;
    }
    const tz = localZone();
    const local = (d: Date) => (allDay ? formatLocalDate(wallClock(d, tz)) : formatLocalDateTime(wallClock(d, tz)));
    return {
      when: { start: local(start), end: local(end), allDay },
      calendars,
      calendarUrl: this.collectionFor("VEVENT") ?? urls[0]!,
      tasks: this.sessionTasks(null),
      submit: (choice) =>
        void (async () => {
          const uid = newUid();
          const { when } = choice;
          const fields = { summary: choice.title, start: when.start, end: when.end ?? when.start, location: choice.location || null, relatedTo: choice.taskUid };
          await this.saveEvent(choice.calendarUrl, this.sync!.newItemUrl(choice.calendarUrl, uid), newEvent(uid, fields, tz));
        })().catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }))),
    };
  }

  /** The tasks an event can be a work session for: the open ones, soonest deadline first, and the session's own. */
  private sessionTasks(session: Occurrence | null): { uid: string; title: string }[] {
    const own = session?.taskUid ?? null;
    const tasks = this.index
      .all()
      .filter((x) => x.uid && (!x.done || x.uid === own))
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
      .map((x) => ({ uid: x.uid!, title: x.basename }));
    // Its task has no note here: still offered, under the session's title (named after the task).
    if (own && !tasks.some((x) => x.uid === own)) tasks.unshift({ uid: own, title: session!.title });
    return tasks;
  }

  /**
   * The event form on an event or a work session, filled in (spec §7.1); null when it can't change here (an
   * invitation, a mirrored event, a read-only collection). One occurrence of a series is changed alone, as dragging
   * does: the series stays in its collection.
   */
  private editEventOptions(occ: Occurrence): EventFormOptions | null {
    if (!this.sync || occ.kind === "deadline" || !this.editable(occ)) return null;
    return {
      when: { start: occ.start, end: occ.end ?? occ.start, allDay: occ.allDay },
      calendars: this.eventCalendars(),
      calendarUrl: occ.calendarUrl,
      tasks: this.sessionTasks(occ),
      edit: { title: occ.title, location: occ.location ?? "", taskUid: occ.taskUid, series: occ.recurring },
      submit: (choice) =>
        void this.saveEventForm(occ, choice).catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) }))),
    };
  }

  /**
   * Writes what the event form changed, and only that (the place is a meeting link the form doesn't show: left
   * alone unless one is typed). Another collection: the event is created there, then deleted here.
   */
  private async saveEventForm(occ: Occurrence, choice: EventChoice): Promise<void> {
    const sync = this.sync;
    const data = sync?.item(occ.itemUrl)?.data;
    if (!sync || !data) return;
    const edit: EventEdit = {};
    const { when } = choice;
    if (choice.title !== occ.title) edit.summary = choice.title;
    if (when.start !== occ.start || when.end !== occ.end || when.allDay !== occ.allDay) {
      edit.start = when.start;
      edit.end = when.end ?? when.start;
    }
    if (choice.location !== (occ.location ?? "")) edit.location = choice.location || null;
    if (choice.taskUid !== occ.taskUid) edit.relatedTo = choice.taskUid;
    const changed = Object.keys(edit).length > 0;
    const updated = changed ? editEvent(data, occ.recurring ? occ.recurrenceId : null, edit, localZone()) : data;
    if (choice.calendarUrl === occ.calendarUrl) {
      if (changed) await this.saveEvent(occ.calendarUrl, occ.itemUrl, updated);
      return;
    }
    await this.saveEvent(choice.calendarUrl, sync.newItemUrl(choice.calendarUrl, occ.uid), updated);
    await this.deleteEvent(occ.itemUrl);
  }

  private occurrenceMenu(occ: Occurrence, evt: MouseEvent, edit: () => void): void {
    const menu = new Menu();
    const run = (fn: () => Promise<void>) => () =>
      void fn().catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) })));
    const open = openLabel(occ, this.hasEventNote(occ));
    menu.addItem((i) => i.setTitle(open.text).setIcon(open.icon).onClick(() => void this.openOccurrence(occ)));
    const meeting = occ.meeting;
    if (meeting) menu.addItem((i) => i.setTitle(joinText(meeting)).setIcon("video").onClick(() => window.open(meeting.url)));
    // A deadline's or a work session's task, then the event itself (a work session is one too).
    const taskPath = occ.kind !== "event" ? this.taskNotePath(occ.taskUid) : null;
    if (taskPath) menu.addItem((i) => i.setTitle(t("menu.editTask")).setIcon("pencil").onClick(() => this.editTask(taskPath, null)));
    const data = this.sync?.item(occ.itemUrl)?.data;
    const changeable = (occ.kind === "event" || occ.kind === "timeblock") && !!data && this.editable(occ);
    if (changeable) menu.addItem((i) => i.setTitle(t(occ.kind === "timeblock" ? "menu.editSession" : "menu.edit")).setIcon("pencil").onClick(edit));
    if (taskPath && occ.kind === "deadline") {
      menu.addItem((i) => i.setTitle(t("menu.blockTime")).setIcon("clock").onClick(() => this.pickSlot(taskPath)));
      menu.addItem((i) => i.setTitle(t("menu.deadline")).setIcon("flag").onClick(() => this.pickDeadline(taskPath)));
    }
    if (occ.invitation && data && this.writableCalendar(occ.calendarUrl)) {
      menu.addSeparator();
      for (const [ps, label] of [["ACCEPTED", "menu.accept"], ["TENTATIVE", "menu.maybe"], ["DECLINED", "menu.decline"]] as const) {
        menu.addItem((i) =>
          i
            .setTitle(t(label))
            .setChecked(occ.invitation?.partstat === ps)
            .onClick(run(() => this.rsvp(occ, ps))),
        );
      }
    }
    if (changeable) {
      menu.addSeparator();
      if (occ.recurring && occ.recurrenceId) {
        menu.addItem((i) => i.setTitle(t("menu.deleteOccurrence")).setIcon("trash").onClick(run(() => this.removeOccurrence(occ, false))));
      }
      menu.addItem((i) =>
        i
          .setTitle(occ.recurring ? t("menu.deleteSeries") : t("menu.delete"))
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(run(() => this.removeOccurrence(occ, true))),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Deletes an event or a work session: the whole item (a series as a whole) when `all`, else this occurrence. */
  private async removeOccurrence(occ: Occurrence, all: boolean): Promise<void> {
    const data = this.sync?.item(occ.itemUrl)?.data;
    if (!data) return;
    if (all || !occ.recurrenceId) await this.deleteEvent(occ.itemUrl);
    else await this.saveEvent(occ.calendarUrl, occ.itemUrl, cancelOccurrence(data, occ.recurrenceId));
  }

  /** My answer to an invitation (spec §4.6): written on the server, relayed by the backend. */
  private async rsvp(occ: Occurrence, partstat: PartStat): Promise<void> {
    const data = this.sync?.item(occ.itemUrl)?.data;
    const updated = data && setPartstat(data, this.myAddresses(), partstat);
    if (!updated) {
      new Notice(t("error.notAttendee"));
      return;
    }
    await this.saveEvent(occ.calendarUrl, occ.itemUrl, updated);
    // A declined invitation leaves the calendar (spec §4.6): say so, rather than let it vanish.
    if (partstat === "DECLINED") new Notice(t("rsvp.declined"));
  }

  private async saveEvent(calendarUrl: string, url: string, data: string): Promise<void> {
    if (!this.sync) return;
    await this.sync.putItem(calendarUrl, url, data);
    this.catalog.invalidate();
    await this.updateEventNotes();
    this.refreshViews();
    this.requestSync();
  }

  private async deleteEvent(url: string): Promise<void> {
    if (!this.sync) return;
    await this.sync.deleteItem(url);
    this.catalog.invalidate();
    this.refreshViews();
    this.requestSync();
  }

  private occurrences(from: Date, to: Date, includeHidden = false): Occurrence[] {
    const tz = localZone();
    const opts = { from, to, tz, me: this.myAddresses() };
    const hidden = new Set(includeHidden ? [] : this.settings.hiddenCalendars);
    const out: Occurrence[] = [];
    for (const cal of this.sync?.calendars() ?? []) {
      if (hidden.has(cal.info.url)) continue;
      for (const [url, it] of Object.entries(cal.items)) out.push(...expandItem(url, cal.info.url, it.data, opts));
    }
    return out;
  }

  private calendarEntries(): CalendarEntry[] {
    const hidden = new Set(this.settings.hiddenCalendars);
    return (this.sync?.calendars() ?? []).map((c, i) => ({
      url: c.info.url,
      name: c.info.displayName,
      color: c.info.color?.slice(0, 7) ?? PALETTE[i % PALETTE.length]!,
      hidden: hidden.has(c.info.url),
      readOnly: c.info.readOnly,
    }));
  }

  private myAddresses(): string[] {
    return [...(this.sync?.discovery?.addresses ?? []), ...this.settings.myAddresses];
  }

  /** Click in the calendar: a deadline or work session opens its task; an event opens (or creates) its note. */
  private async openOccurrence(occ: Occurrence): Promise<void> {
    if (occ.kind !== "event") {
      const uid = occ.taskUid;
      const path = uid ? (this.tasks?.notePath(uid) ?? this.index.pathOfUid(uid) ?? (await this.tasks?.ensureNote(uid))) : null;
      if (path) await this.openPath(path);
      else new Notice(t("open.notFound"));
      return;
    }
    await this.openPath(await this.eventNotes.ensure(occ));
  }

  /** An event's note is made on first open; until then the calendar offers to create it. */
  private hasEventNote(occ: Occurrence): boolean {
    return occ.kind === "event" && this.eventNotes.pathFor(occ.uid, occ.recurrenceId) !== null;
  }

  /** `obsidian://calendar-tasks?uid=…[&rid=…]`, e.g. tapped in Apple Calendar or Reminders (spec §4.5). */
  private async openUid(uid: string | undefined, rid: string | null): Promise<void> {
    const path = uid ? await this.noteOf(uid, rid) : null;
    if (path) await this.openPath(path);
    else new Notice(t("open.notFound"));
  }

  /** The note of a task or event occurrence, created if needed (today's / next occurrence if `rid` is null). */
  private async noteOf(uid: string, rid: string | null): Promise<string | null> {
    const taskPath = this.tasks?.notePath(uid) ?? this.index.pathOfUid(uid);
    if (taskPath) return taskPath;
    const entry = this.catalog.get(uid);
    const data = entry && this.sync?.item(entry.url)?.data;
    if (entry && data && entry.kind === "VTODO") {
      const path = await this.tasks?.ensureNote(uid);
      if (path) return path;
    }
    if (entry && data && entry.kind === "VEVENT") {
      const tz = localZone();
      const me = this.myAddresses();
      let occ = findOccurrence(entry.url, entry.calendarUrl, data, rid, { tz, me });
      if (!rid && occ?.recurring) {
        const now = new Date();
        const around = expandItem(entry.url, entry.calendarUrl, data, {
          from: new Date(now.getTime() - 60 * DAY_MS),
          to: new Date(now.getTime() + 400 * DAY_MS),
          tz,
          me,
        });
        occ = pickOccurrence(around, now, tz) ?? occ;
      }
      if (occ) return this.eventNotes.ensure(occ);
    }
    return this.eventNotes.pathFor(uid, rid);
  }

  // —— Claude (claude-workspace module, desktop) ——

  private registerClaudeModule(retried = false): void {
    if (!Platform.isDesktopApp) return;
    const api = claudeWorkspaceApi(this.app);
    if (api) this.register(api.registerModule(createCalendarModule(this.claudeServices())));
    else if (!retried) window.setTimeout(() => this.registerClaudeModule(true), 5_000);
  }

  private claudeServices(): CalendarServices {
    const fail = (msg: string): never => {
      throw new Error(msg);
    };
    const needSync = () => this.sync ?? fail("No CalDAV server is configured (Calendar & Tasks settings).");
    const calendarByRef = (ref: string | undefined, component: "VEVENT" | "VTODO") => {
      const cals = needSync()
        .calendars()
        .filter((c) => !c.info.readOnly && c.info.components.includes(component));
      const found = ref
        ? cals.find((c) => c.info.url === ref || c.info.displayName.toLowerCase() === ref.toLowerCase())
        : cals.find((c) => c.info.url === this.collectionFor(component));
      return found?.info.url ?? fail(`No writable calendar "${ref ?? ""}". Writable calendars: ${cals.map((c) => c.info.displayName).join(", ") || "none"}.`);
    };
    const eventData = (uid: string) => {
      const entry = this.catalog.get(uid);
      const data = entry && entry.kind === "VEVENT" ? needSync().item(entry.url)?.data : undefined;
      if (!entry || !data) fail(`No event with uid "${uid}". Find it with calendar_list.`);
      if (isMirror(data!)) fail("This event comes from another account: it can only be answered (calendar_rsvp).");
      return { entry: entry!, data: data! };
    };
    return {
      connected: () => !!this.sync,
      tz: localZone,
      folders: () => ({
        tasks: this.settings.tasksFolder,
        events: this.settings.eventsFolder,
        taskBase: this.settings.taskBaseFile,
        eventNoteExample: `${noteDate("2026-10-13", this.settings.eventDateFormat)} Title`,
      }),
      calendars: () =>
        (this.sync?.calendars() ?? []).map((c) => ({ url: c.info.url, name: c.info.displayName, readOnly: c.info.readOnly, components: c.info.components })),
      occurrences: (from, to) => this.occurrences(from, to, true),
      tasks: () => this.index.all(),
      syncState: (uid) => (this.tasks ? this.tasks.syncState(uid) : "local"),
      createEvent: async (e) => {
        const calendarUrl = calendarByRef(e.calendar, "VEVENT");
        const uid = newUid();
        const data = newEvent(uid, { summary: e.title, start: e.start, end: e.end, location: e.location, relatedTo: e.taskUid }, localZone());
        await this.saveEvent(calendarUrl, needSync().newItemUrl(calendarUrl, uid), data);
        return { uid };
      },
      updateEvent: async (uid, rid, changes) => {
        const { entry, data } = eventData(uid);
        const tz = localZone();
        const current = findOccurrence(entry.url, entry.calendarUrl, data, rid, { tz, me: this.myAddresses() });
        if (!current) fail(`No occurrence ${rid ?? ""} of event ${uid}.`);
        if (current!.invitation) fail("You were invited to this event: answer it with calendar_rsvp instead.");
        let updated = data;
        const target = current!.recurring ? rid : null;
        if (changes.start || changes.end) updated = moveEvent(updated, target, changes.start ?? current!.start, changes.end ?? current!.end ?? current!.start, tz);
        if (changes.title) updated = renameEvent(updated, target, changes.title);
        await this.saveEvent(entry.calendarUrl, entry.url, updated);
      },
      deleteEvent: async (uid, rid) => {
        const { entry, data } = eventData(uid);
        if (rid) await this.saveEvent(entry.calendarUrl, entry.url, cancelOccurrence(data, rid));
        else await this.deleteEvent(entry.url);
      },
      rsvp: async (uid, answer) => {
        const entry = this.catalog.get(uid);
        const data = entry ? needSync().item(entry.url)?.data : undefined;
        const updated = data && setPartstat(data, this.myAddresses(), answer);
        if (!entry || !updated) fail("You're not among this event's attendees (or it doesn't exist).");
        await this.saveEvent(entry!.calendarUrl, entry!.url, updated!);
      },
      createTask: async (task) => {
        const parent = task.parent ? (this.findTask(task.parent)?.path ?? fail(`No task "${task.parent}".`)) : null;
        const repeat = task.repeat ? (repeatFromNote(task.repeat) ?? fail(`Can't read the repetition "${task.repeat}".`)) : null;
        return this.createTaskNote({ ...task, repeat, tags: tagsOf(task.tags ?? []), parent });
      },
      setTaskDone: async (ref, done) => {
        const task = this.findTask(ref) ?? fail(`No task "${ref}". List them with calendar_list_tasks.`);
        const file = this.app.vault.getFileByPath(task.path) ?? fail(`No note at ${task.path}.`);
        const now = formatLocalDateTime(wallClock(new Date(), localZone()));
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => setDone(fm, done, now));
        return task.path;
      },
      setTaskDates: async (ref, dates) => {
        const task = this.findTask(ref) ?? fail(`No task "${ref}". List them with calendar_list_tasks.`);
        const file = this.app.vault.getFileByPath(task.path) ?? fail(`No note at ${task.path}.`);
        const repeat = dates.repeat ? (repeatFromNote(dates.repeat) ?? fail(`Can't read the repetition "${dates.repeat}".`)) : dates.repeat;
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          if (dates.due === null) delete fm[PROP.due];
          else if (dates.due !== undefined) fm[PROP.due] = dates.due;
          if (repeat === null) delete fm[PROP.repeat];
          else if (repeat !== undefined) fm[PROP.repeat] = repeatToNote(repeat);
          if (dates.priority === null) delete fm[PROP.priority];
          else if (dates.priority !== undefined) fm[PROP.priority] = dates.priority;
        });
        return task.path;
      },
      noteFor: async (uid, rid) => (await this.noteOf(uid, rid)) ?? fail(`Nothing with uid "${uid}" (sync first?).`),
      findTask: (ref) => this.findTask(ref),
      calendarViewRange: () => {
        const view = this.app.workspace.getLeavesOfType(CALENDAR_VIEW)[0]?.view;
        return view instanceof CalendarView ? view.describe() : null;
      },
      noteInfo: (path) => {
        const task = this.index.get(path);
        if (task) {
          return {
            kind: "task",
            done: task.done,
            due: task.due,
            tags: task.tags,
            sync: this.tasks ? this.tasks.syncState(task.uid) : "local",
          };
        }
        const fm = this.vaultPort.getNote(path)?.frontmatter;
        if (fm?.type !== "event") return null;
        return { kind: "event", start: fm.start ?? null, end: fm.end ?? null, recurrenceId: fm.recurrence_id ?? null };
      },
    };
  }

  /** A task from a note path, a note name or a UID. */
  private findTask(ref: string): TaskInfo | null {
    const byPath = this.index.get(ref) ?? this.index.get(`${ref}.md`);
    if (byPath) return byPath;
    const uidPath = this.index.pathOfUid(ref);
    if (uidPath) return this.index.get(uidPath) ?? null;
    return this.index.all().find((x) => x.basename === ref) ?? null;
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const fromCalendar = this.app.workspace.getActiveViewOfType(CalendarView) !== null;
    await this.app.workspace.getLeaf(fromCalendar ? "tab" : false).openFile(file);
  }

  /** Opens the calendar (on `date`, "YYYY-MM-DD", if given). */
  private async openCalendar(date?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CALENDAR_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: CALENDAR_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (date && leaf.view instanceof CalendarView) leaf.view.goTo(date);
  }

  private async updateEventNotes(): Promise<void> {
    const opts = { tz: localZone(), me: this.myAddresses() };
    await this.eventNotes.update((uid, rid) => {
      const e = this.catalog.get(uid);
      const data = e && this.sync?.item(e.url)?.data;
      return e && data ? findOccurrence(e.url, e.calendarUrl, data, rid, opts) : null;
    });
  }

  /** After a note changed: the calendar's task lists ("To plan") and the headers of open task notes. */
  private refreshTaskViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW)) {
      if (leaf.view instanceof CalendarView) leaf.view.refreshTasks();
    }
    this.updateNoteHeaders();
  }

  /** Redraws what shows calendar data: calendar views and the headers of open task notes. */
  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW)) {
      if (leaf.view instanceof CalendarView) leaf.view.refresh();
    }
    this.updateNoteHeaders();
  }

  /**
   * The header of every open task or event note (spec §5.4, §4.3): its data on top, outside the scrolling page so
   * it stays; the note's properties hidden unless asked for.
   */
  private updateNoteHeaders(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const content = view.contentEl;
      const old = content.querySelector(":scope > .ct-task-header");
      const task = view.file ? this.index.get(view.file.path) : undefined;
      const event = !task && view.file ? this.eventOfNote(view.file) : null;
      const header = task ? this.taskHeader(task) : event ? this.eventHeader(event) : null;
      if (!header) {
        old?.remove();
        content.removeClass("ct-task-view", "ct-show-props");
        continue;
      }
      content.addClass("ct-task-view");
      content.toggleClass("ct-show-props", this.settings.showTaskProperties);
      if (old) old.replaceWith(header);
      else content.prepend(header);
    }
  }

  /** What an event note stands for: its occurrence (null if gone; declined ones too), and the times it says. */
  private eventOfNote(file: TFile): EventOfNote | null {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const uid: unknown = fm?.[PROP.uid];
    if (fm?.[PROP.type] !== NOTE_TYPE.event || typeof uid !== "string") return null;
    const rid: unknown = fm[PROP.recurrenceId];
    const entry = this.catalog.get(uid);
    const data = entry && this.sync?.item(entry.url)?.data;
    const opts = { tz: localZone(), me: this.myAddresses(), declined: true };
    const occ = entry && data ? findOccurrence(entry.url, entry.calendarUrl, data, typeof rid === "string" ? rid : null, opts) : null;
    const start = occ?.start ?? normalizeDue(fm[PROP.start]);
    return start ? { file, occ, start, end: occ ? occ.end : normalizeDue(fm[PROP.end]) } : null;
  }

  private eventHeader({ file, occ, start, end }: EventOfNote): HTMLElement {
    const calendar = occ ? this.calendarEntries().find((c) => c.url === occ.calendarUrl) : undefined;
    const answer = occ?.invitation?.partstat;
    return renderEventHeader(
      {
        when: whenText(occ ?? { start, end, allDay: start.length === 10 }, getLanguage()),
        calendar: calendar ? { name: calendar.name, color: calendar.color } : null,
        repeats: !!occ?.recurring,
        meeting: occ?.meeting ? { text: joinText(occ.meeting), host: meetingHost(occ.meeting), url: occ.meeting.url } : null,
        location: occ?.location ?? null,
        invitation: occ?.invitation ? { partstat: answer === "ACCEPTED" || answer === "TENTATIVE" || answer === "DECLINED" ? answer : null } : null,
        // Before the first sync nothing is known yet: not "deleted".
        missing: answer === "DECLINED" ? "declined" : !occ && this.sync?.calendars().length ? "deleted" : null,
      },
      {
        reveal: () => void this.revealInCalendar(occ, start),
        rsvp: (ps) => {
          if (occ) void this.rsvp(occ, ps).catch((e: unknown) => new Notice(t("error.write", { error: e instanceof Error ? e.message : String(e) })));
        },
        deleteNote: () => void this.app.fileManager.promptForDeletion(file),
        properties: {
          shown: this.settings.showTaskProperties,
          toggle: () => {
            this.settings.showTaskProperties = !this.settings.showTaskProperties;
            void this.saveData(this.settings);
            this.updateNoteHeaders();
          },
        },
      },
      {
        reveal: t("header.reveal"),
        repeats: t("card.repeats"),
        declined: t("header.declined"),
        deleted: t("header.deleted"),
        deleteNote: t("header.deleteNote"),
        answers: { ACCEPTED: t("menu.accept"), TENTATIVE: t("menu.maybe"), DECLINED: t("menu.decline") },
        showProperties: t("header.showProperties"),
        hideProperties: t("header.hideProperties"),
      },
    );
  }

  /** The calendar on an occurrence: its day, scrolled to it, blinking once (or just its day when it's gone). */
  private async revealInCalendar(occ: Occurrence | null, start: string): Promise<void> {
    // Its collection hidden, it wouldn't be there: the collection is shown again.
    if (occ && this.settings.hiddenCalendars.includes(occ.calendarUrl)) {
      this.settings.hiddenCalendars = this.settings.hiddenCalendars.filter((u) => u !== occ.calendarUrl);
      void this.saveData(this.settings);
      this.refreshViews();
      new Notice(t("header.calendarShown", { name: this.calendarEntries().find((c) => c.url === occ.calendarUrl)?.name ?? "" }));
    }
    await this.openCalendar();
    const view = this.app.workspace.getLeavesOfType(CALENDAR_VIEW)[0]?.view;
    if (!(view instanceof CalendarView)) return;
    if (occ) view.reveal(occ.id, occ.start);
    else view.goTo(start.slice(0, 10));
  }

  private taskHeader(task: TaskInfo): HTMLElement {
    const ctx = { now: new Date(), tz: localZone(), lang: getLanguage(), words: { today: t("chip.today"), tomorrow: t("chip.tomorrow") } };
    const kids = this.index.childrenOf(task.path);
    const note = (path: string | null) => (path ? { path, name: path.split("/").pop()!.replace(/\.md$/, "") } : null);
    const sync = this.tasks ? this.tasks.syncState(task.uid) : "synced";
    const model: TaskHeaderModel = {
      done: task.done,
      priority: task.priority ? { level: task.priority, label: t("priority.named", { level: t(`priority.${task.priority}`).toLowerCase() }) } : null,
      due: task.due ? dueLabel(task.due, task.done, ctx) : null,
      repeat: task.repeat ? (repeatLabel(task.repeat, getLanguage().startsWith("fr") ? "fr" : "en") ?? t("suggest.customRepeat")) : null,
      tags: task.tags,
      parent: note(task.parentPath),
      progress: kids.length ? `${kids.filter((k) => k.done).length}/${kids.length}` : null,
      blocks: this.plannedBlocks(task).map((b) => ({ label: b.label, start: b.start })),
      sync: sync === "synced" ? null : sync,
      created: this.pastText(task.created, ctx, "created"),
      completed: task.done ? this.pastText(task.completed, ctx, "done") : null,
      history: this.history(task, ctx),
    };
    return renderTaskHeader(
      model,
      {
        toggle: () => void this.toggleTask(task.path),
        edit: (focus) => this.editTask(task.path, focus),
        open: (path) => void this.app.workspace.openLinkText(path, task.path),
        block: () =>
          new DatePickerModal(this.app, { mode: "slot", pick: (block) => void this.blockTime(task.path, [block]) }).open(),
        showBlock: (start) => void this.openCalendar(start.slice(0, 10)),
        properties: {
          shown: this.settings.showTaskProperties,
          toggle: () => {
            this.settings.showTaskProperties = !this.settings.showTaskProperties;
            void this.saveData(this.settings);
            this.updateNoteHeaders();
          },
        },
      },
      {
        todo: t("header.todo"),
        done: t("header.done"),
        deadline: t("header.deadline"),
        addBlock: t("modal.addBlock"),
        repeat: t("header.repeat"),
        tags: t("header.tags"),
        parent: t("header.parent"),
        progress: t("header.progress"),
        history: t("header.history"),
        edit: t("menu.editTask"),
        showProperties: t("header.showProperties"),
        hideProperties: t("header.hideProperties"),
        pending: t("chip.pending"),
        local: t("chip.local"),
      },
    );
  }

  /** When a task was made or ticked: "Créée hier", "Faite le 18 oct."…, the whole date in the tooltip. */
  private pastText(value: string | null, ctx: { now: Date; tz: string; lang: string }, kind: "created" | "done"): { text: string; tooltip: string } | null {
    const c = value ? pastLabel(value, ctx) : null;
    if (!c) return null;
    const text = c.relative === "today" ? t(`header.${kind}Today`) : c.relative === "yesterday" ? t(`header.${kind}Yesterday`) : t(`header.${kind}On`, { date: c.day });
    return { text, tooltip: t(`header.${kind}On`, { date: c.full }) };
  }

  /** A repeating task's times done, newest first: the day for the bar, the whole date and time for its tooltip. */
  private history(task: TaskInfo, ctx: { now: Date; tz: string; lang: string }): TaskHeaderModel["history"] {
    if (!task.repeat || !task.completions.length) return null;
    return [...task.completions].reverse().flatMap((c) => {
      const l = pastLabel(c, ctx);
      return l ? [{ day: l.day, full: l.full }] : [];
    });
  }

  /** A task's time blocks ahead, with those waiting for its reminder (not on the server yet), soonest first. */
  private plannedBlocks(task: TaskInfo): { label: string; start: string }[] {
    const pending = this.pendingBlocks.get(task.path) ?? [];
    return [
      ...this.taskBlocks(task.uid).map((o) => ({ label: slotLabel(o.start, o.end!), start: o.start })),
      ...pending.map((b) => ({ label: blockLabel(b), start: b.start })),
    ].sort((a, b) => a.start.localeCompare(b.start));
  }

  /** A task's time blocks from now to 90 days ahead, soonest first (only items that mention its UID are read). */
  private taskBlocks(uid: string | null): Occurrence[] {
    if (!uid) return [];
    const now = new Date();
    const opts = { from: now, to: new Date(now.getTime() + 90 * DAY_MS), tz: localZone(), me: this.myAddresses() };
    const out: Occurrence[] = [];
    for (const cal of this.sync?.calendars() ?? []) {
      for (const [url, it] of Object.entries(cal.items)) {
        if (!it.data.includes(uid)) continue;
        out.push(...expandItem(url, cal.info.url, it.data, opts).filter((o) => o.kind === "timeblock" && o.taskUid === uid && o.end));
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  private noteChanged(path: string): void {
    if (!this.tasks) return;
    const prev = this.noteTimers.get(path);
    if (prev !== undefined) window.clearTimeout(prev);
    this.noteTimers.set(
      path,
      window.setTimeout(() => {
        this.noteTimers.delete(path);
        void this.tasks?.noteChanged(path);
      }, NOTE_DEBOUNCE_MS),
    );
  }

  private async flushNoteChanges(): Promise<void> {
    const paths = [...this.noteTimers.keys()];
    for (const path of paths) {
      window.clearTimeout(this.noteTimers.get(path));
      this.noteTimers.delete(path);
      void this.tasks?.noteChanged(path);
    }
    await this.tasks?.whenIdle();
  }

  private requestSync(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow(false);
    }, SYNC_DEBOUNCE_MS);
  }

  private notify(name: string, kind: "no-task-calendar" | "clash" | "next" | "no-collection", detail?: string): void {
    if (kind === "clash") new Notice(t("tasks.clash", { name }));
    else if (kind === "no-collection") new Notice(t("tasks.noCollection", { name, collection: detail ?? "" }));
    else if (kind === "next") new Notice(t("tasks.next", { name, date: shortDay(detail ?? "") }));
    else if (!this.warnedNoTaskCalendar) {
      this.warnedNoTaskCalendar = true;
      new Notice(t("tasks.noCalendar"));
    }
  }

  /** Writes the task list base file once (spec §7.2); never again, even if the user deletes it. */
  private async ensureBaseFile(): Promise<void> {
    if (this.settings.taskBaseCreated) return;
    const path = this.settings.taskBaseFile;
    if (!this.vaultPort.exists(path)) await this.writeBaseFile(path);
    this.settings.taskBaseCreated = true;
    await this.saveData(this.settings);
  }

  /** The settings button: the task list base file rewritten with the default views, after asking if it exists. */
  regenerateTaskBase(): void {
    const path = this.settings.taskBaseFile;
    const name = path.split("/").pop()!;
    const write = () =>
      void this.writeBaseFile(path)
        .then(() => new Notice(t("base.regenerated", { name })))
        .catch((e: unknown) => new Notice(t("base.regenerateFailed", { error: e instanceof Error ? e.message : String(e) })));
    if (!this.app.vault.getFileByPath(path)) return write();
    const views = [t("base.todo"), t("base.noDue"), t("base.byTag"), t("base.done")].join(", ");
    new ConfirmModal(this.app, {
      title: t("base.regenerateTitle", { name }),
      lines: [t("base.regenerateViews", { views }), t("base.regenerateLost")],
      action: t("base.regenerate"),
      run: write,
    }).open();
  }

  private async writeBaseFile(path: string): Promise<void> {
    const content = taskBaseFile({
      task: t("base.task"),
      due: t("base.due"),
      repeat: t("base.repeat"),
      priority: t("modal.priority"),
      created: t("base.created"),
      completed: t("base.completed"),
      todo: t("base.todo"),
      noDue: t("base.noDue"),
      byTag: t("base.byTag"),
      done: t("base.done"),
    });
    const existing = this.app.vault.getFileByPath(path);
    if (existing) return this.app.vault.modify(existing, content);
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder) await this.vaultPort.ensureFolder(folder);
    await this.app.vault.create(path, content);
  }

  /**
   * After a sync or a change of collections: the settings list them, and task notes name theirs, so a collection
   * renamed (here or elsewhere) is renamed in them too.
   */
  private refreshSettingsIfCalendarsChanged(): void {
    const shown = JSON.stringify((this.sync?.calendars() ?? []).map((c) => [c.info.url, c.info.displayName, c.info.readOnly]));
    if (shown === this.calendarsShown) return;
    const first = !this.calendarsShown;
    this.calendarsShown = shown;
    this.settingTab.update();
    if (!first) void this.tasks?.pullAll();
  }

  private async resetCache(): Promise<void> {
    await this.sync?.reset();
    this.tasks?.rebuild();
    await this.syncNow(false);
    await this.tasks?.pullAll();
    new Notice(t("cache.reset"));
  }

  private schedule(): void {
    if (this.interval !== null) window.clearInterval(this.interval);
    this.intervalMinutes = this.settings.syncIntervalMinutes;
    this.interval = window.setInterval(() => void this.syncNow(false), this.intervalMinutes * 60_000);
    this.registerInterval(this.interval);
  }

  private client(): CalDavClient | null {
    const { serverUrl, username, passwordSecret } = this.settings;
    if (!serverUrl || !username) return null;
    const password = (passwordSecret && this.app.secretStorage.getSecret(passwordSecret)) || "";
    return new CalDavClient({ serverUrl, username, password, transport: obsidianTransport, parseXml: domParser });
  }

  private connectionKey(): string {
    const { serverUrl, username, passwordSecret } = this.settings;
    return `${serverUrl}|${username}|${passwordSecret}`;
  }
}

/** RFC 4122 v4 UID (crypto.randomUUID needs a secure context; fall back to getRandomValues). */
function newUid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The line holding `text`: at `from` if it's still there, else wherever it moved. */
function findLine(doc: Text, from: number, text: string): Line | null {
  const at = from <= doc.length ? doc.lineAt(from) : null;
  if (at?.text === text) return at;
  for (let i = 1; i <= doc.lines; i++) if (doc.line(i).text === text) return doc.line(i);
  return null;
}
