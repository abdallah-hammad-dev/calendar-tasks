import { PROP, type Priority } from "../constants";
import { linkpathOf, readNote } from "./notes";
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
  projectPath: string | null;
  parentPath: string | null;
  /** The collection its note names. */
  collection: string | null;
}

/** Every task note's state, kept current from vault events; what the editor decorations read. */
export class TaskIndex {
  private byPath = new Map<string, TaskInfo>();
  private listeners = new Set<() => void>();

  constructor(private readonly vault: Pick<VaultPort, "allNotes" | "getNote" | "resolve" | "isProject">) {}

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

  remove(path: string): void {
    if (this.byPath.delete(path)) this.emit();
  }

  rename(oldPath: string, newPath: string): void {
    this.byPath.delete(oldPath);
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

  /** The project a note belongs to: itself if it is a project, else its `project` link. */
  projectOf(path: string): string | null {
    if (this.vault.isProject(path)) return path;
    const link = linkpathOf(this.vault.getNote(path)?.frontmatter?.[PROP.project]);
    return link ? (this.vault.resolve(link, path)?.path ?? null) : null;
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
      projectPath: resolve(s.project),
      parentPath: resolve(s.parent),
      collection: s.collection,
    });
    return true;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
