import { getAllTags, normalizePath, stringifyYaml, TFolder, type App, type TFile } from "obsidian";
import type { NoteRef, VaultPort } from "./TaskSync";

/** VaultPort on Obsidian's documented APIs. Writes go through `fileManager` so links stay up to date. */
export class ObsidianVault implements VaultPort {
  constructor(
    private readonly app: App,
    private readonly projectTag: () => string,
  ) {}

  allNotes(): NoteRef[] {
    return this.app.vault.getMarkdownFiles().map((f) => this.ref(f));
  }

  getNote(path: string): NoteRef | null {
    const f = this.app.vault.getFileByPath(path);
    return f && f.extension === "md" ? this.ref(f) : null;
  }

  resolve(linkpath: string, from: string): NoteRef | null {
    const f = this.app.metadataCache.getFirstLinkpathDest(linkpath, from);
    return f ? this.ref(f) : null;
  }

  linkText(path: string, from: string): string {
    const f = this.app.vault.getFileByPath(path);
    if (f) return this.app.metadataCache.fileToLinktext(f, from, true);
    // Not written yet: its name alone, like fileToLinktext, unless another note already answers to it.
    const name = path.replace(/\.md$/, "");
    const base = name.slice(name.lastIndexOf("/") + 1);
    return this.app.metadataCache.getFirstLinkpathDest(base, from) ? name : base;
  }

  isProject(path: string): boolean {
    const f = this.app.vault.getFileByPath(path);
    const cache = f && this.app.metadataCache.getFileCache(f);
    if (!cache) return false;
    const want = `#${this.projectTag()}`.toLowerCase();
    return (getAllTags(cache) ?? []).some((t) => t.toLowerCase() === want);
  }

  findProject(name: string): NoteRef | null {
    const f = this.app.vault.getMarkdownFiles().find((x) => x.basename === name && this.isProject(x.path));
    return f ? this.ref(f) : null;
  }

  exists(path: string): boolean {
    return !!this.app.vault.getAbstractFileByPath(normalizePath(path));
  }

  async create(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    await this.app.vault.create(path, `---\n${stringifyYaml(frontmatter)}---\n${body ? `${body}\n` : ""}`);
  }

  async editFrontmatter(path: string, edit: (fm: Record<string, unknown>) => void): Promise<void> {
    const f = this.app.vault.getFileByPath(path);
    if (f) await this.app.fileManager.processFrontMatter(f, edit);
  }

  async rename(path: string, newPath: string): Promise<void> {
    const f = this.app.vault.getFileByPath(path);
    if (f) await this.app.fileManager.renameFile(f, newPath);
  }

  async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`"${current}" is a file, not a folder`);
    }
  }

  private ref(f: TFile): NoteRef {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    return { path: f.path, basename: f.basename, frontmatter: fm ? { ...fm } : null };
  }
}
