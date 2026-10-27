import type { Priority } from "../constants";
import { readNote } from "./notes";
import type { NoteRef, VaultPort } from "./TaskSync";

export interface TaskInfo {
  path: string;
  basename: string;
  done: boolean;
  due: string | null;
  /** RRULE, when the task repeats. */
  repeat: string | null;
  priority: Priority | null;
  uid: string | null;
  /** Its tags (without "#"). */
  tags: string[];
  parentPath: string | null;
  /** The notes its body links to (paths): a parent's sub-tasks are listed there. */
  links: string[];
  /** The collection its note names. */
  collection: string | null;
  /** When it was made, local "YYYY-MM-DD[THH:mm]". */
  created: string | null;
  /** When it was ticked (only while done), local "YYYY-MM-DDTHH:mm". */
  completed: string | null;
  /** Each time a repeating task was ticked, oldest first. */
  completions: string[];
}

/**
 * What a parent's note changing does to its sub-tasks (spec §4.1): one whose line left it is no longer its sub-task
 * (`detach`); one detached that way whose line came back (undo, a cut line pasted) is again (`attach`), unless it has
 * another parent by then. `detached`: child path → the parent it was detached from.
 */
export function listingChanges(
  was: TaskInfo,
  now: TaskInfo,
  get: (path: string) => TaskInfo | undefined,
  detached: ReadonlyMap<string, string>,
): { detach: string[]; attach: string[] } {
  const detach = was.links.filter((p) => !now.links.includes(p) && get(p)?.parentPath === now.path);
  const attach = now.links.filter((p) => {
    const child = get(p);
    return !was.links.includes(p) && detached.get(p) === now.path && !!child && !child.parentPath;
  });
  return { detach, attach };
}

/** Every task note's state, kept current from vault events; what the editor decorations read. */
export class TaskIndex {
  private byPath = new Map<string, TaskInfo>();
  private listeners = new Set<() => void>();

  constructor(private readonly vault: Pick<VaultPort, "allNotes" | "getNote" | "resolve" | "bodyLinks">) {}

  rebuild(): void {
    this.byPath.clear();
    for (const n of this.vault.allNotes()) this.set(n);
    this.emit();
  }

  refresh(path: string): void {
    const n = this.vault.getNote(path);
    const had = this.byPath.has(path);
    if (n && this.set(n)) this.emit();
    else if (had) {
      this.byPath.delete(path);
      this.emit();
    }
  }

  /**
   * Records a task note just created, before Obsidian has parsed it, so the line that links to it gets its
   * checkbox right away. The parsed version replaces it on the next `refresh`.
   */
  prime(info: TaskInfo): void {
    if (this.byPath.has(info.path)) return;
    this.byPath.set(info.path, info);
    this.emit();
  }

  /** A change being written to a task note, known before Obsidian has read it back; the next `refresh` replaces it. */
  patch(path: string, change: Partial<TaskInfo>): void {
    const info = this.byPath.get(path);
    if (!info) return;
    this.byPath.set(path, { ...info, ...change });
    this.emit();
  }

  remove(path: string): void {
    if (this.byPath.delete(path)) this.emit();
  }

  rename(oldPath: string, newPath: string): void {
    this.byPath.delete(oldPath);
    // Its children follow at once: Obsidian rewrites their `parent` link later, which mustn't read as a new parent.
    for (const [p, t] of this.byPath) if (t.parentPath === oldPath) this.byPath.set(p, { ...t, parentPath: newPath });
    this.refresh(newPath);
  }

  get(path: string): TaskInfo | undefined {
    return this.byPath.get(path);
  }

  all(): TaskInfo[] {
    return [...this.byPath.values()];
  }

  pathOfUid(uid: string): string | null {
    for (const t of this.byPath.values()) if (t.uid === uid) return t.path;
    return null;
  }

  childrenOf(path: string): TaskInfo[] {
    return [...this.byPath.values()].filter((t) => t.parentPath === path);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(n: NoteRef): boolean {
    const s = readNote(n.frontmatter);
    if (!s) {
      this.byPath.delete(n.path);
      return false;
    }
    const resolve = (link: string | null) => (link ? (this.vault.resolve(link, n.path)?.path ?? null) : null);
    this.byPath.set(n.path, {
      path: n.path,
      basename: n.basename,
      done: s.done,
      due: s.due,
      repeat: s.repeat ?? null,
      priority: s.priority ?? null,
      uid: s.uid,
      tags: s.tags,
      parentPath: resolve(s.parent),
      links: this.vault.bodyLinks(n.path),
      collection: s.collection,
      created: s.created ?? null,
      completed: s.completed,
      completions: s.completions,
    });
    return true;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
