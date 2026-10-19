import { NOTE_TYPE, PROP } from "../constants";
import { sanitizeTitle, titleMatches, uniquePath } from "../tasks/notes";
import type { VaultPort } from "../tasks/TaskSync";
import type { Occurrence } from "./expand";

const key = (uid: string, rid: string | null) => `${uid}\n${rid ?? ""}`;

/** How the day is written in an event note's name (a setting); never with "/", which a file name can't hold. */
export const EVENT_DATE_FORMATS = ["DD-MM-YYYY", "DD.MM.YYYY", "YYYY-MM-DD"] as const;
export type EventDateFormat = (typeof EVENT_DATE_FORMATS)[number];

/** "2026-10-13" as `format` writes it: "13-10-2026", "13.10.2026", "2026-10-13". */
export function noteDate(day: string, format: EventDateFormat): string {
  const [y, m, d] = day.split("-");
  return format === "YYYY-MM-DD" ? day : `${d}${format === "DD.MM.YYYY" ? "." : "-"}${m}${format === "DD.MM.YYYY" ? "." : "-"}${y}`;
}

/**
 * The names an event note can take, in order: `13-10-2026 Title`, then, when another event of that day has the
 * same title, with its time (`13-10-2026 Title 14h30`). After that, " (2)"… as for any note.
 */
export function eventNoteNames(occ: Pick<Occurrence, "start" | "title">, format: EventDateFormat): string[] {
  const name = `${noteDate(occ.start.slice(0, 10), format)} ${sanitizeTitle(occ.title || "Event")}`;
  if (occ.start.length <= 10) return [name];
  const [h, m] = [Number(occ.start.slice(11, 13)), Number(occ.start.slice(14, 16))];
  return [name, `${name} ${h}h${m ? String(m).padStart(2, "0") : ""}`];
}

/**
 * Event notes (spec §4.3): created when an event is opened, one per occurrence of a recurring event, named
 * `13-10-2026 Title` (the date as set) in the events folder. `start`/`end` follow the server (one way); the note
 * is renamed when the event is renamed or moved, or the date format changes. A deleted event leaves its note alone.
 */
export class EventNotes {
  private byKey = new Map<string, string>();

  constructor(
    private readonly d: {
      vault: VaultPort;
      eventsFolder: () => string;
      dateFormat: () => EventDateFormat;
    },
  ) {}

  /** The first name free in `folder` for this occurrence (its time added if the plain one is another event's). */
  private freePath(folder: string, occ: Occurrence): string {
    const names = eventNoteNames(occ, this.d.dateFormat());
    const prefix = folder ? `${folder}/` : "";
    const free = names.find((n) => !this.d.vault.exists(`${prefix}${n}.md`));
    return free ? `${prefix}${free}.md` : uniquePath((p) => this.d.vault.exists(p), folder, names[0]!);
  }

  rebuild(): void {
    this.byKey.clear();
    for (const n of this.d.vault.allNotes()) this.track(n.path, n.frontmatter);
  }

  /** A note changed or appeared (e.g. created on another device and synced here). */
  refresh(path: string): void {
    this.forget(path);
    this.track(path, this.d.vault.getNote(path)?.frontmatter ?? null);
  }

  forget(path: string): void {
    for (const [k, p] of this.byKey) if (p === path) this.byKey.delete(k);
  }

  private track(path: string, fm: Record<string, unknown> | null): void {
    if (fm?.[PROP.type] !== NOTE_TYPE.event || typeof fm[PROP.uid] !== "string") return;
    const rid = typeof fm[PROP.recurrenceId] === "string" ? (fm[PROP.recurrenceId] as string) : null;
    this.byKey.set(key(fm[PROP.uid] as string, rid), path);
  }

  pathFor(uid: string, rid: string | null): string | null {
    const path = this.byKey.get(key(uid, rid));
    return path && this.d.vault.exists(path) ? path : null;
  }

  /** The note of an occurrence, created if needed. */
  async ensure(occ: Occurrence): Promise<string> {
    const existing = this.pathFor(occ.uid, occ.recurrenceId);
    if (existing) return existing;
    const folder = this.d.eventsFolder();
    const path = this.freePath(folder, occ);
    const fm: Record<string, unknown> = { [PROP.type]: NOTE_TYPE.event, [PROP.start]: occ.start };
    if (occ.end) fm[PROP.end] = occ.end;
    fm[PROP.uid] = occ.uid;
    if (occ.recurrenceId) fm[PROP.recurrenceId] = occ.recurrenceId;
    await this.d.vault.ensureFolder(folder);
    await this.d.vault.create(path, fm, "");
    this.byKey.set(key(occ.uid, occ.recurrenceId), path);
    return path;
  }

  /** Brings every event note in line with its occurrence (`find` returns null if it is gone: note left alone). */
  async update(find: (uid: string, rid: string | null) => Occurrence | null): Promise<void> {
    for (const [k, path] of [...this.byKey]) {
      const note = this.d.vault.getNote(path);
      if (!note) {
        this.byKey.delete(k);
        continue;
      }
      const [uid, rid] = k.split("\n") as [string, string];
      const occ = find(uid, rid || null);
      if (!occ) continue;
      const fm = note.frontmatter ?? {};
      if (fm[PROP.start] !== occ.start || (fm[PROP.end] ?? null) !== occ.end) {
        await this.d.vault.editFrontmatter(path, (f) => {
          f[PROP.start] = occ.start;
          if (occ.end) f[PROP.end] = occ.end;
          else delete f[PROP.end];
        });
      }
      if (!eventNoteNames(occ, this.d.dateFormat()).some((n) => titleMatches(n, note.basename))) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const newPath = this.freePath(dir, occ);
        await this.d.vault.rename(path, newPath);
        this.byKey.set(k, newPath);
      }
    }
  }
}
