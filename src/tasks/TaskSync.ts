import { itemInfo } from "../caldav/ical";
import { NOTE_TYPE, PROP } from "../constants";
import type { CalendarChange, Conflict, SyncEngine } from "../sync/engine";
import type { CachedCalendar } from "../sync/store";
import { formatLocalDate, formatLocalDateTime, fromWall, parseLocal, wallClock } from "../ical/time";
import { nextOccurrence, repeatToNote } from "../editor/when";
import { collectionOf, normalizeDue, readNote, sanitizeTitle, titleMatches, uniquePath, type NoteState } from "./notes";
import { newTask, readTask, sameFields, taskLink, writeTask, type ReadTask, type TaskFields } from "./vtodo";

/** A markdown note as TaskSync sees it. */
export interface NoteRef {
  path: string;
  basename: string;
  frontmatter: Record<string, unknown> | null;
}

/** The slice of Obsidian TaskSync needs; `ObsidianVault` is the real one, tests use a fake. */
export interface VaultPort {
  allNotes(): NoteRef[];
  getNote(path: string): NoteRef | null;
  /** Resolves a link path the way Obsidian does, from a source note. */
  resolve(linkpath: string, from: string): NoteRef | null;
  /** Shortest unambiguous link text for a note, from a source note. */
  linkText(path: string, from: string): string;
  isProject(path: string): boolean;
  /** A note carrying the project tag with this exact name, if any. */
  findProject(name: string): NoteRef | null;
  exists(path: string): boolean;
  create(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  editFrontmatter(path: string, edit: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Moves a note and updates links to it. */
  rename(path: string, newPath: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

export interface TaskSyncDeps {
  vault: VaultPort;
  engine: Pick<SyncEngine, "calendars" | "item" | "putItem" | "deleteItem" | "newItemUrl" | "isPending">;
  /** `defaultCalendar`: the collection new tasks go to when nothing else says (URL; "" = the first by name). */
  settings: () => { tasksFolder: string; reminderNoteLink: boolean; defaultCalendar: string };
  vaultName: string;
  tz: () => string;
  newUid: () => string;
  /** Asks for a sync soon (the plugin debounces). */
  requestSync: () => void;
  /** A task note just got its reminder (and so a UID other items can link to). */
  created?: (path: string, uid: string) => void;
  /**
   * `next`: a repeating task was ticked and moved to its next date (`detail`). `no-collection`: the note names a
   * collection (`detail`) that doesn't exist or can't hold tasks; the task stays where it is.
   */
  notify: (message: string, kind: "no-task-calendar" | "clash" | "next" | "no-collection", detail?: string) => void;
}

const FIELDS = ["summary", "done", "due", "categories", "parentUid", "repeat", "priority", "completed"] as const;

/**
 * Keeps task notes and VTODOs in step (spec §4.1): every VTODO has a note (except ones already completed when
 * first seen), every task note has a VTODO. CalDAV owns time fields and status, the note owns its content; the
 * frontmatter mirrors the owned fields. All work is serialized, and every write is equality-checked, so a write
 * on one side coming back as a change event is a no-op.
 */
export class TaskSync {
  /** uid → note path */
  private notes = new Map<string, string>();
  /** uid → item; url → uid */
  private items = new Map<string, { url: string; calendarUrl: string }>();
  private uidOfUrl = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Unknown collections already told about, per note (edits come every few keystrokes). */
  private warned = new Set<string>();
  /**
   * uid → the collection its note was last in step with (written there, or where the cache had it). A note naming
   * another one was changed by the user: the task moves. One still naming this one while the task is elsewhere is
   * just behind (moved on the phone): the note follows.
   */
  private known = new Map<string, string>();

  constructor(private readonly d: TaskSyncDeps) {}

  /** Rebuilds both indexes from the vault and the engine's cache. */
  rebuild(): void {
    this.notes.clear();
    for (const n of this.d.vault.allNotes()) {
      const s = readNote(n.frontmatter);
      if (s?.uid) this.notes.set(s.uid, n.path);
    }
    this.items.clear();
    this.uidOfUrl.clear();
    this.known.clear();
    for (const cal of this.d.engine.calendars()) {
      for (const [url, it] of Object.entries(cal.items)) {
        const uid = this.indexItem(url, cal.info.url, it.data);
        if (uid) this.known.set(uid, cal.info.displayName);
      }
    }
  }

  /** Pushes every task note that differs from the cached VTODO (local edits made while not syncing). */
  pushAll(): Promise<void> {
    return this.serial(async () => {
      for (const n of this.d.vault.allNotes()) if (readNote(n.frontmatter)) await this.pushNote(n.path);
    });
  }

  /** Makes every VTODO's note match it, creating missing notes. Parents first, so child links resolve. */
  pullAll(): Promise<void> {
    return this.serial(async () => {
      const uids = [...this.items.keys()];
      const parentOf = (uid: string) => this.task(uid)?.parentUid ?? null;
      uids.sort((a, b) => Number(!!parentOf(a)) - Number(!!parentOf(b)));
      for (const uid of uids) await this.applyItem(uid);
    });
  }

  onServerChange(change: CalendarChange): Promise<void> {
    return this.serial(async () => {
      const changed: string[] = [];
      for (const url of change.removed) {
        const uid = this.uidOfUrl.get(url);
        if (!uid) continue;
        this.uidOfUrl.delete(url);
        if (this.items.get(uid)?.url !== url) continue; // already seen in its new list
        // Moved to another list (the phone does that when a reminder changes list): the same task, same note.
        const moved = this.findItem(uid);
        if (moved) {
          this.indexItem(moved.url, moved.calendarUrl, moved.data);
          changed.push(uid);
          continue;
        }
        this.items.delete(uid);
        // A whole calendar vanishing may be a server hiccup: leave the notes alone, they relink if it returns.
        if (!change.calendarRemoved) await this.serverDeleted(uid);
      }
      for (const url of [...change.added, ...change.updated]) {
        const data = this.d.engine.item(url)?.data;
        const uid = data ? this.indexItem(url, change.calendarUrl, data) : null;
        if (uid) changed.push(uid);
      }
      changed.sort((a, b) => Number(!!this.task(a)?.parentUid) - Number(!!this.task(b)?.parentUid));
      for (const uid of changed) await this.applyItem(uid);
    });
  }

  /** A push was refused: merge field by field (the server wins where both sides changed the same field). */
  onConflict(c: Conflict): Promise<void> {
    return this.serial(async () => {
      const uid = this.uidOfUrl.get(c.op.url);
      if (c.op.kind === "delete") {
        // The note was deleted here while the item changed there: the deletion stands.
        if (c.server) {
          await this.d.engine.deleteItem(c.op.url);
          this.d.requestSync();
        }
        return;
      }
      if (!c.server) {
        // Gone from this list but in another one (moved on the phone): our change goes there.
        const moved = uid && this.items.get(uid)?.url === c.op.url ? this.findItem(uid) : null;
        if (uid && moved) {
          this.uidOfUrl.delete(c.op.url);
          this.indexItem(moved.url, moved.calendarUrl, moved.data);
          const path = this.notePath(uid);
          const note = path ? this.d.vault.getNote(path) : null;
          const state = note && readNote(note.frontmatter);
          if (path && note && state) {
            // The note follows it there first (pushed from that state: Obsidian re-reads the frontmatter later).
            const collection = await this.setCollection(path, uid, moved.calendarUrl);
            await this.pushState(note, { ...state, collection });
          }
          this.d.requestSync();
          return;
        }
        if (uid) await this.serverDeleted(uid);
        return;
      }
      const tz = this.d.tz();
      const server = readTask(c.server.data, tz);
      const local = readTask(c.op.data, tz);
      const base = c.op.baseData ? readTask(c.op.baseData, tz) : null;
      if (!server || !local) return;
      const merged: TaskFields = { ...server };
      const clashes: string[] = [];
      for (const f of FIELDS) {
        const localChanged = base ? !same(local[f], base[f]) : false;
        const serverChanged = base ? !same(server[f], base[f]) : true;
        if (localChanged && !serverChanged) Object.assign(merged, { [f]: local[f] });
        else if (localChanged && serverChanged && !same(local[f], server[f])) clashes.push(f);
      }
      if (clashes.length) this.d.notify(server.summary, "clash");
      if (!sameFields(merged, server)) {
        await this.d.engine.putItem(c.op.calendarUrl, c.op.url, writeTask(c.server.data, diff(server, merged), this.writeOpts(server.uid)));
        this.d.requestSync();
      }
      if (uid) await this.applyItem(uid);
    });
  }

  /** For the editor's sync icon: not on the server yet, waiting to be pushed, or in step. */
  syncState(uid: string | null): "local" | "pending" | "synced" {
    const ref = uid ? this.items.get(uid) : undefined;
    if (!ref) return "local";
    return this.d.engine.isPending(ref.url) ? "pending" : "synced";
  }

  /** Resolves when all queued work is done. */
  whenIdle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  noteChanged(path: string): Promise<void> {
    return this.serial(() => this.pushNote(path));
  }

  /**
   * A deadline set from the calendar (dragged, or picked): the reminder changes at once, since the calendar is drawn
   * from it, then the note. Through the note alone it waited for the note's debounce, and a redraw meanwhile put
   * the deadline back where it was for a moment (2026-10-19: "ça revient puis ça se redéplace").
   */
  setDue(path: string, due: string | null): Promise<void> {
    return this.serial(async () => {
      const note = this.d.vault.getNote(path);
      const state = note && readNote(note.frontmatter);
      if (!note || !state) return;
      if (state.uid) await this.pushState(note, { ...state, due });
      await this.d.vault.editFrontmatter(path, (fm) => {
        if (due === null) delete fm[PROP.due];
        else fm[PROP.due] = due;
      });
    });
  }

  noteRenamed(oldPath: string, newPath: string): Promise<void> {
    return this.serial(async () => {
      for (const [uid, p] of this.notes) if (p === oldPath) this.notes.set(uid, newPath);
      await this.pushNote(newPath);
    });
  }

  /** A task note was deleted: its VTODO goes too (spec §6.4). */
  noteDeleted(path: string, frontmatter: Record<string, unknown> | null): Promise<void> {
    return this.serial(async () => {
      const uid = readNote(frontmatter)?.uid ?? [...this.notes].find(([, p]) => p === path)?.[0];
      if (!uid || this.notes.get(uid) !== path) return;
      this.notes.delete(uid);
      const ref = this.items.get(uid);
      if (!ref || this.readOnly(ref.calendarUrl)) return;
      await this.d.engine.deleteItem(ref.url);
      this.d.requestSync();
    });
  }

  // —— server → note ——

  /** The calendar holding a task's VTODO, if it is on the server. */
  calendarOf(uid: string): string | null {
    return this.items.get(uid)?.calendarUrl ?? null;
  }

  /** The note of a task, if it has one. */
  notePath(uid: string): string | null {
    const path = this.notes.get(uid);
    return path && this.d.vault.getNote(path) ? path : null;
  }

  /** The note of a task, created if needed (even for a completed task, e.g. opened from the phone). */
  ensureNote(uid: string): Promise<string | null> {
    return this.serial(async () => {
      await this.applyItem(uid, true);
      return this.notePath(uid);
    });
  }

  private async applyItem(uid: string, force = false): Promise<void> {
    const ref = this.items.get(uid);
    const data = ref && this.d.engine.item(ref.url)?.data;
    const task = data ? readTask(data, this.d.tz()) : null;
    if (!ref || !data || !task) return;
    let path = this.notes.get(uid);
    let pushed = false;
    if (path && !this.d.vault.getNote(path)) {
      this.notes.delete(uid);
      path = undefined;
    }

    if (!path) {
      if (task.done && !force) return; // already finished when first seen: no note
      const folder = this.d.settings().tasksFolder;
      path = this.uniquePath(folder, sanitizeTitle(task.summary));
      const fm: Record<string, unknown> = { [PROP.type]: NOTE_TYPE.task, [PROP.done]: task.done };
      if (task.due) fm[PROP.due] = task.due;
      if (task.repeat) fm[PROP.repeat] = repeatToNote(task.repeat);
      if (task.priority) fm[PROP.priority] = task.priority;
      const project = this.serverProject(task);
      if (project) fm[PROP.project] = `[[${this.d.vault.linkText(project, path)}]]`;
      const parentPath = task.parentUid ? this.notes.get(task.parentUid) : undefined;
      if (parentPath) fm[PROP.parent] = `[[${this.d.vault.linkText(parentPath, path)}]]`;
      if (task.created) fm[PROP.created] = task.created;
      if (task.done && task.completed) fm[PROP.completed] = task.completed;
      const collection = this.calendarName(ref.calendarUrl);
      if (collection) {
        fm[PROP.collection] = collection;
        this.known.set(uid, collection);
      }
      fm[PROP.uid] = uid;
      await this.d.vault.ensureFolder(folder);
      await this.d.vault.create(path, fm, task.notes);
      this.notes.set(uid, path);
    } else {
      const note = this.d.vault.getNote(path)!;
      const state = readNote(note.frontmatter);
      if (!state) return;
      // Ticked on the phone without moving on to the next date: move on here, and tell the server.
      const moved =
        task.done && task.repeat && !state.done
          ? await this.moveOn(path, note.basename, { ...state, done: true, due: task.due, repeat: task.repeat }, task.completed ?? this.now())
          : null;
      if (moved) {
        await this.applyFields(path, moved, { ...task, done: false, due: moved.due }, ref.calendarUrl);
        await this.pushState(note, moved);
        pushed = true; // with our link: `ensureLink` would put back the ticked copy it was given
      } else {
        await this.applyFields(path, state, task, ref.calendarUrl);
      }
      if (!titleMatches(task.summary, note.basename)) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const newPath = this.uniquePath(dir, sanitizeTitle(task.summary));
        await this.d.vault.rename(path, newPath);
        this.notes.set(uid, newPath);
      }
    }
    if (!pushed) await this.ensureLink(ref, data, task);
  }

  private async applyFields(path: string, state: NoteState, task: ReadTask, calendarUrl: string): Promise<void> {
    const edits: Record<string, unknown> = {};
    const collection = this.calendarName(calendarUrl);
    if (collection) {
      this.known.set(task.uid, collection);
      if (state.collection !== collection) edits[PROP.collection] = collection;
    }
    if (state.done !== task.done) edits[PROP.done] = task.done;
    if (state.created === null && task.created) edits[PROP.created] = task.created; // set once: the note's own stays
    // When it was ticked there (a time the server doesn't have leaves the note's); unticked, it goes.
    if (task.done ? task.completed && state.completed !== task.completed : state.completed !== null) {
      edits[PROP.completed] = task.done ? task.completed : undefined;
    }
    if (state.due !== task.due) edits[PROP.due] = task.due ?? undefined;
    if (state.repeat === undefined ? task.repeat !== null : state.repeat !== task.repeat) {
      edits[PROP.repeat] = task.repeat ? repeatToNote(task.repeat) : undefined;
    }
    if (state.priority === undefined ? task.priority !== null : state.priority !== task.priority) {
      edits[PROP.priority] = task.priority ?? undefined;
    }

    const current = state.project ? this.d.vault.resolve(state.project, path) : null;
    const fromServer = this.serverProject(task);
    const currentIsSynced = current && this.d.vault.isProject(current.path);
    if (fromServer ? fromServer !== current?.path : currentIsSynced) {
      edits[PROP.project] = fromServer ? `[[${this.d.vault.linkText(fromServer, path)}]]` : undefined;
    }

    const parent = state.parent ? this.d.vault.resolve(state.parent, path) : null;
    const parentPath = task.parentUid ? this.notes.get(task.parentUid) : undefined;
    if (task.parentUid ? parentPath && parentPath !== parent?.path : parent && readNote(parent.frontmatter)?.uid) {
      edits[PROP.parent] = parentPath ? `[[${this.d.vault.linkText(parentPath, path)}]]` : undefined;
    }

    if (!Object.keys(edits).length) return;
    await this.d.vault.editFrontmatter(path, (fm) => {
      for (const [k, v] of Object.entries(edits)) {
        if (v === undefined) delete fm[k];
        else fm[k] = v;
      }
    });
  }

  /** The VTODO was deleted elsewhere: the note stays (content is precious), done and unlinked (spec §6.4). */
  private async serverDeleted(uid: string): Promise<void> {
    const path = this.notes.get(uid);
    this.notes.delete(uid);
    if (!path || !this.d.vault.getNote(path)) return;
    this.known.delete(uid);
    await this.d.vault.editFrontmatter(path, (fm) => {
      fm[PROP.done] = true;
      delete fm[PROP.uid];
      delete fm[PROP.collection];
    });
  }

  /** Keeps our link as URL (and last line of the notes) so the phone links back to the note. */
  private async ensureLink(ref: { url: string; calendarUrl: string }, data: string, task: ReadTask): Promise<void> {
    if (this.readOnly(ref.calendarUrl)) return;
    const link = taskLink(this.d.vaultName, task.uid);
    if (task.url === link && task.hasLinkLine === this.d.settings().reminderNoteLink) return;
    await this.d.engine.putItem(ref.calendarUrl, ref.url, writeTask(data, {}, this.writeOpts(task.uid)));
    this.d.requestSync();
  }

  // —— note → server ——

  private async pushNote(path: string): Promise<void> {
    const note = this.d.vault.getNote(path);
    let state = note && readNote(note.frontmatter);
    if (!note || !state) return;
    // Pushed from the new state, not re-read: Obsidian parses the edited frontmatter later.
    if (state.done && state.repeat) state = (await this.moveOn(path, note.basename, state, this.now())) ?? state;
    // When it was ticked, if the tick didn't say (Bases, the properties): now when the reminder isn't done yet (a tick
    // here), else the reminder's time; never a guess (a note done long ago, unlinked). Unticked, it goes.
    if (state.done !== (state.completed !== null)) {
      const server = state.done && state.uid ? this.serverTask(state.uid) : null;
      const completed = server ? (server.done ? server.completed : this.now()) : null;
      if (completed !== state.completed) {
        await this.d.vault.editFrontmatter(path, (fm) => {
          if (completed) fm[PROP.completed] = completed;
          else delete fm[PROP.completed];
        });
        state = { ...state, completed };
      }
    }
    await this.pushState(note, state);
  }

  private async pushState(note: NoteRef, state: NoteState): Promise<void> {
    const path = note.path;
    if (!state.uid) {
      await this.createItem(note, state);
      return;
    }
    if (this.notes.get(state.uid) !== path) this.notes.set(state.uid, path);
    const ref = this.items.get(state.uid);
    const data = ref && this.d.engine.item(ref.url)?.data;
    const current = data ? readTask(data, this.d.tz()) : null;
    if (!ref || !data || !current || this.readOnly(ref.calendarUrl)) return;

    const wanted = this.fieldsFromNote(note, state, current);
    const link = taskLink(this.d.vaultName, state.uid);
    const linkOk = current.url === link && current.hasLinkLine === this.d.settings().reminderNoteLink;
    const changed = !sameFields(wanted, current) || !linkOk;
    const next = changed ? writeTask(data, diff(current, wanted), this.writeOpts(state.uid)) : data;
    // The note names another collection than the one it was in step with: the user moved the task there (it's
    // created there, then deleted here).
    const asked = state.collection && state.collection !== (this.known.get(state.uid) ?? this.calendarName(ref.calendarUrl)) ? state.collection : null;
    const target = asked ? this.calendarNamed(asked) : null;
    if (asked && !target) this.unknownCollection(note, asked);
    if (target && target !== ref.calendarUrl) {
      const url = this.d.engine.newItemUrl(target, state.uid);
      await this.d.engine.putItem(target, url, next);
      await this.d.engine.deleteItem(ref.url);
      this.uidOfUrl.delete(ref.url);
      this.items.set(state.uid, { url, calendarUrl: target });
      this.uidOfUrl.set(url, state.uid);
    }
    // Its name as the server spells it ("pro" → "Pro").
    if (target) await this.setCollection(path, state.uid, target, asked);
    if (target && target !== ref.calendarUrl) {
      this.d.requestSync();
      return;
    }
    if (!changed) return;
    await this.d.engine.putItem(ref.calendarUrl, ref.url, next);
    this.d.requestSync();
  }

  /**
   * A repeating task was ticked (`at`, local): instead of staying done, it comes back at its next date, and `at` joins
   * the times it was done. Returns the note's new state, or null when there's no deadline to move on from.
   */
  private async moveOn(path: string, name: string, state: NoteState, at: string): Promise<NoteState | null> {
    if (!state.due || !state.repeat) return null;
    const wall = wallClock(new Date(), this.d.tz());
    const next = nextOccurrence(state.due, state.repeat, { date: formatLocalDate(wall), dateTime: formatLocalDateTime(wall) });
    if (!next) return null;
    const completions = [...state.completions, at];
    let counted = false;
    await this.d.vault.editFrontmatter(path, (fm) => {
      // Already back at that date: a second push read the note before Obsidian re-parsed it (2026-10-25: one tick
      // was in `completions` twice). This tick is counted.
      counted = fm[PROP.done] !== true && normalizeDue(fm[PROP.due]) === next;
      if (counted) return;
      fm[PROP.done] = false;
      fm[PROP.due] = next;
      delete fm[PROP.completed];
      // Values written by hand that can't be read stay too.
      const kept: unknown = fm[PROP.completions];
      fm[PROP.completions] = [...(Array.isArray(kept) ? (kept as unknown[]) : kept ? [kept] : []), at];
    });
    if (!counted) this.d.notify(name, "next", next);
    return { ...state, done: false, due: next, completed: null, completions: counted ? state.completions : completions };
  }

  /** Now, as a local "YYYY-MM-DDTHH:mm" (when a task was ticked here). */
  private now(): string {
    return formatLocalDateTime(wallClock(new Date(), this.d.tz()));
  }

  /** What the server holds for a task, if it's known. */
  private serverTask(uid: string): ReadTask | null {
    const ref = this.items.get(uid);
    const data = ref && this.d.engine.item(ref.url)?.data;
    return data ? readTask(data, this.d.tz()) : null;
  }

  private async createItem(note: NoteRef, state: NoteState): Promise<void> {
    const calendarUrl = this.calendarFor(note, state);
    if (!calendarUrl) {
      this.d.notify("", "no-task-calendar");
      return;
    }
    const uid = this.d.newUid();
    const url = this.d.engine.newItemUrl(calendarUrl, uid);
    const fields = this.fieldsFromNote(note, state, null);
    // Made now, unless the note already says when (e.g. a note unlinked from its reminder, then reopened).
    const tz = this.d.tz();
    const said = state.created ? parseLocal(state.created) : null;
    const created = said ? fromWall(said.wall, tz) : new Date();
    await this.d.engine.putItem(calendarUrl, url, newTask(uid, fields, this.writeOpts(uid), created));
    this.items.set(uid, { url, calendarUrl });
    this.uidOfUrl.set(url, uid);
    this.notes.set(uid, note.path);
    const collection = this.calendarName(calendarUrl);
    if (collection) this.known.set(uid, collection);
    await this.d.vault.editFrontmatter(note.path, (fm) => {
      fm[PROP.uid] = uid;
      if (collection) fm[PROP.collection] = collection;
      if (state.created === null) fm[PROP.created] = formatLocalDateTime(wallClock(created, tz));
    });
    this.d.created?.(note.path, uid);
    this.d.requestSync();
  }

  private fieldsFromNote(note: NoteRef, state: NoteState, current: ReadTask | null): TaskFields {
    const project = state.project ? this.d.vault.resolve(state.project, note.path) : null;
    const projectName = project && this.d.vault.isProject(project.path) ? project.basename : null;
    const categories = (current?.categories ?? []).filter((c) => !this.d.vault.findProject(c));
    if (projectName) categories.push(projectName);

    let parentUid = current?.parentUid ?? null;
    if (state.parent) {
      const parent = this.d.vault.resolve(state.parent, note.path);
      const puid = parent ? readNote(parent.frontmatter)?.uid : null;
      if (puid) parentUid = puid;
      else if (parent) parentUid = null; // a note without a VTODO (yet): not linked on the server
    } else parentUid = null;

    return {
      summary: current && titleMatches(current.summary, note.basename) ? current.summary : note.basename,
      done: state.done,
      due: state.due,
      categories,
      parentUid,
      repeat: state.repeat === undefined ? (current?.repeat ?? null) : state.repeat,
      priority: state.priority === undefined ? (current?.priority ?? null) : state.priority,
      completed: state.done ? (state.completed ?? current?.completed ?? null) : null,
    };
  }

  // —— helpers ——

  /** The task with this UID wherever it is in the cache (the engine reports changes once every list is read). */
  private findItem(uid: string): { url: string; calendarUrl: string; data: string } | null {
    for (const cal of this.d.engine.calendars()) {
      for (const [url, it] of Object.entries(cal.items)) {
        if (it.data.includes(uid) && itemInfo(it.data)?.uid === uid) return { url, calendarUrl: cal.info.url, data: it.data };
      }
    }
    return null;
  }

  private indexItem(url: string, calendarUrl: string, data: string): string | null {
    const info = itemInfo(data);
    if (!info || info.kind !== "VTODO") return null;
    this.items.set(info.uid, { url, calendarUrl });
    this.uidOfUrl.set(url, info.uid);
    return info.uid;
  }

  private task(uid: string): ReadTask | null {
    const ref = this.items.get(uid);
    const data = ref && this.d.engine.item(ref.url)?.data;
    return data ? readTask(data, this.d.tz()) : null;
  }

  /** A category naming a project note (spec §4.2). */
  private serverProject(task: ReadTask): string | null {
    for (const c of task.categories) {
      const p = this.d.vault.findProject(c);
      if (p) return p.path;
    }
    return null;
  }

  /** Collections a task can go to: writable, holding tasks, by name. */
  private taskCalendars(): CachedCalendar[] {
    return this.d.engine
      .calendars()
      .filter((c) => !c.info.readOnly && c.info.components.includes("VTODO"))
      .sort((a, b) => a.info.displayName.localeCompare(b.info.displayName));
  }

  /** A collection named in a note (`collection: Pro`), among those a task can go to; any case. */
  private calendarNamed(name: string): string | null {
    const cals = this.taskCalendars();
    const lower = name.toLowerCase();
    return (cals.find((c) => c.info.displayName === name) ?? cals.find((c) => c.info.displayName.toLowerCase() === lower))?.info.url ?? null;
  }

  private calendarName(url: string): string | null {
    return this.d.engine.calendars().find((c) => c.info.url === url)?.info.displayName ?? null;
  }

  /**
   * Where a new task goes (spec §4.1): the collection its note names, else its parent's (a subtask stays with
   * it), else its project's (`collection` on the project note), else the default one, else the first by name.
   */
  private calendarFor(note: NoteRef, state: NoteState): string | null {
    const named = state.collection ? this.calendarNamed(state.collection) : null;
    if (named) return named;
    if (state.collection) this.unknownCollection(note, state.collection);
    const parent = state.parent ? this.d.vault.resolve(state.parent, note.path) : null;
    const parentUid = parent ? readNote(parent.frontmatter)?.uid : null;
    const parentCal = parentUid ? this.items.get(parentUid)?.calendarUrl : undefined;
    if (parentCal && !this.readOnly(parentCal)) return parentCal;
    const project = state.project ? this.d.vault.resolve(state.project, note.path) : null;
    const projectCollection = project ? collectionOf(project.frontmatter) : null;
    const fromProject = projectCollection ? this.calendarNamed(projectCollection) : null;
    if (fromProject) return fromProject;
    const cals = this.taskCalendars();
    const chosen = this.d.settings().defaultCalendar;
    return (cals.find((c) => c.info.url === chosen) ?? cals[0])?.info.url ?? null;
  }

  private unknownCollection(note: NoteRef, name: string): void {
    const key = `${note.path}\n${name}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.d.notify(note.basename, "no-collection", name);
  }

  /** Writes the collection's name in the note (unless it already says so: `written`) and remembers it. */
  private async setCollection(path: string, uid: string, calendarUrl: string, written?: string | null): Promise<string | null> {
    const name = this.calendarName(calendarUrl);
    if (!name) return null;
    this.known.set(uid, name);
    if (written !== name) await this.d.vault.editFrontmatter(path, (fm) => (fm[PROP.collection] = name));
    return name;
  }

  private readOnly(calendarUrl: string): boolean {
    return this.d.engine.calendars().find((c) => c.info.url === calendarUrl)?.info.readOnly ?? true;
  }

  private writeOpts(uid: string) {
    return { tz: this.d.tz(), link: taskLink(this.d.vaultName, uid), linkInNotes: this.d.settings().reminderNoteLink };
  }

  private uniquePath(folder: string, base: string): string {
    return uniquePath((p) => this.d.vault.exists(p), folder, base);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((e: unknown) => console.error("[calendar-tasks] task sync:", e instanceof Error ? e.message : e));
    return run;
  }
}

function same(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
}

function diff(from: TaskFields, to: TaskFields): Partial<TaskFields> {
  const out: Partial<TaskFields> = {};
  for (const f of FIELDS) if (!same(from[f], to[f])) Object.assign(out, { [f]: to[f] });
  return out;
}
