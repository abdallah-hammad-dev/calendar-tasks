import type { NoteRef, VaultPort } from "../../src/tasks/TaskSync";

interface FakeFile {
  fm: Record<string, unknown> | null;
  body: string;
}

const basename = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

/** In-memory vault: wiki-link resolution by path or name, and link updates on rename. */
export class FakeVault implements VaultPort {
  files = new Map<string, FakeFile>();
  /** Notes whose frontmatter reads as it was (`lag`) until `catchUp`, as Obsidian re-parses a note after writing it. */
  private parsed = new Map<string, Record<string, unknown> | null>();
  add(path: string, fm: Record<string, unknown> | null, opts: { body?: string } = {}): void {
    this.files.set(path, { fm: fm ? structuredClone(fm) : null, body: opts.body ?? "" });
  }
  fm(path: string): Record<string, unknown> | null | undefined {
    return this.files.get(path)?.fm;
  }
  remove(path: string): void {
    this.files.delete(path);
  }

  allNotes(): NoteRef[] {
    return [...this.files.keys()].map((p) => this.getNote(p)!);
  }
  getNote(path: string): NoteRef | null {
    const f = this.files.get(path);
    const fm = this.parsed.has(path) ? this.parsed.get(path)! : f?.fm;
    return f ? { path, basename: basename(path), frontmatter: fm ? structuredClone(fm) : null } : null;
  }
  lag(path: string): void {
    this.parsed.set(path, structuredClone(this.files.get(path)?.fm ?? null));
  }
  catchUp(path: string): void {
    this.parsed.delete(path);
  }
  resolve(linkpath: string): NoteRef | null {
    const direct = this.files.has(`${linkpath}.md`) ? `${linkpath}.md` : this.files.has(linkpath) ? linkpath : null;
    const path = direct ?? [...this.files.keys()].find((p) => basename(p) === linkpath) ?? null;
    return path ? this.getNote(path) : null;
  }
  linkText(path: string): string {
    const name = basename(path);
    return [...this.files.keys()].filter((p) => basename(p) === name).length > 1 ? path.replace(/\.md$/, "") : name;
  }
  bodyLinks(path: string): string[] {
    const body = this.files.get(path)?.body ?? "";
    const paths = [...body.matchAll(/!?\[\[([^\]|#]+)/g)].map((m) => this.resolve(m[1]!.trim())?.path);
    return [...new Set(paths.filter((p): p is string => !!p))];
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  async create(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`exists: ${path}`);
    this.add(path, frontmatter, { body });
  }
  async editFrontmatter(path: string, edit: (fm: Record<string, unknown>) => void): Promise<void> {
    const f = this.files.get(path)!;
    const fm = structuredClone(f.fm ?? {});
    edit(fm);
    f.fm = fm;
  }
  async rename(path: string, newPath: string): Promise<void> {
    const f = this.files.get(path)!;
    this.files.delete(path);
    this.files.set(newPath, f);
    // Like Obsidian: links to the old name now point to the new one.
    const [from, to] = [basename(path), basename(newPath)];
    for (const other of this.files.values()) {
      for (const [k, v] of Object.entries(other.fm ?? {})) if (v === `[[${from}]]`) other.fm![k] = `[[${to}]]`;
    }
  }
  async ensureFolder(): Promise<void> {}
}
