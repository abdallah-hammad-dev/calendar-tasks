import type { App } from "obsidian";
import { localZone, wallClock } from "../ical/time";
import type { CalendarTasksSettings } from "../settings";
import { uniquePath } from "../tasks/notes";
import type { ObsidianVault } from "../tasks/obsidian-vault";
import type { TaskIndex } from "../tasks/task-index";
import type { Block } from "./when";
import { hasTaskMarker, parseTaskLine, planTask, plannedFrontmatter } from "./convert";

/** A conversion decided but not written yet: the line can change at once, the note follows. */
export interface PreparedTask {
  replacement: string;
  /** Writes the note. */
  create(): Promise<void>;
  /** Gives up before writing (the line changed meanwhile). */
  cancel(): void;
}

/**
 * Turns a `- [ ] …` line into a task note and the line that replaces it (`- [[Task]]`). The new note has no
 * `caldav_uid`: TaskSync sees it appear and creates its VTODO.
 */
export class TaskConverter {
  private inFlight = new Set<string>();
  /** Paths given to notes not written yet, so two quick conversions don't pick the same one. */
  private reserved = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly vault: ObsidianVault,
    private readonly settings: () => CalendarTasksSettings,
    private readonly index: Pick<TaskIndex, "prime" | "remove">,
    /** Time blocks asked on the line (`@session …`), for the plugin to create once the task has its reminder. */
    private readonly onBlocks: (path: string, blocks: Block[]) => void = () => undefined,
  ) {}

  /**
   * Plans the conversion without touching the disk, and records the task in the index so its line can be drawn
   * with a checkbox right away. `requireMarker`: auto-conversion only takes lines with `@`, `@date` or `>date` (spec §5.2).
   */
  prepare(line: string, sourcePath: string, requireMarker: boolean): PreparedTask | null {
    const parts = parseTaskLine(line);
    if (!parts) return null;
    const today = wallClock(new Date(), localZone());
    if (requireMarker && !hasTaskMarker(parts.text, today)) return null;
    const key = `${sourcePath}\n${line}`;
    if (this.inFlight.has(key)) return null;
    const plan = planTask(parts.text, { sourcePath, vault: this.vault, today });
    if (!plan) return null;
    const folder = this.settings().tasksFolder;
    const path = uniquePath((p) => this.reserved.has(p) || this.vault.exists(p), folder, plan.title);
    this.inFlight.add(key);
    this.reserved.add(path);
    this.index.prime({
      path,
      basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      done: false,
      due: plan.due,
      repeat: plan.repeat,
      priority: null,
      uid: null,
      projectPath: plan.project,
      parentPath: plan.parent,
      collection: null, // TaskSync picks it (parent's, project's or the default) and writes it
      created: null, // TaskSync writes it with the reminder
      completed: null,
      completions: [],
    });
    const release = () => {
      this.inFlight.delete(key);
      this.reserved.delete(path);
    };
    return {
      replacement: `${parts.indent}${parts.bullet} [[${this.vault.linkText(path, sourcePath)}]]`,
      create: async () => {
        try {
          await this.vault.ensureFolder(folder);
          await this.vault.create(path, plannedFrontmatter(plan, (target) => this.vault.linkText(target, path)), plan.body);
          if (plan.blocks.length) this.onBlocks(path, plan.blocks);
        } catch (e) {
          this.index.remove(path);
          throw e;
        } finally {
          release();
        }
      },
      cancel: () => {
        release();
        this.index.remove(path);
      },
    };
  }

  /** Writes the note, then returns the replacement line (for commands that edit through the Editor API). */
  async convert(line: string, sourcePath: string, requireMarker: boolean): Promise<string | null> {
    const task = this.prepare(line, sourcePath, requireMarker);
    if (!task) return null;
    await task.create();
    return task.replacement;
  }
}
