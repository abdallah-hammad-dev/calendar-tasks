import { beforeEach, describe, expect, it } from "vitest";
import { chipModel, pastLabel, dueLabel } from "../src/editor/chips";
import { cutSpans, hasTaskMarker, linkLineEdit, parseTaskLine, planTask, plannedFrontmatter } from "../src/editor/convert";
import { TaskIndex } from "../src/tasks/task-index";
import { FakeVault } from "./support/fake-vault";

const TODAY = { year: 2026, month: 10, day: 15 };
let vault: FakeVault;
const plan = (text: string, sourcePath = "Daily/2026-10-15.md") => planTask(text, { sourcePath, vault, today: TODAY });

beforeEach(() => {
  vault = new FakeVault();
  vault.add("Docs/Rapport.md", {});
  vault.add("Daily/2026-10-15.md", {});
  vault.add("Réunions/Point 14-10.md", { tags: ["olera"] });
  vault.add("Tâches/Préparer slides.md", { type: "task", done: false, tags: ["cours"] });
});

describe("hasTaskMarker", () => {
  it("wants an @ (a deadline, a time block, a repetition, or alone); other checklist lines stay steps", () => {
    expect(hasTaskMarker("Appeler Paul @demain", TODAY)).toBe(true);
    expect(hasTaskMarker("Appeler Paul @session lun 14h", TODAY)).toBe(true);
    expect(hasTaskMarker("Appeler Paul @chaque lundi", TODAY)).toBe(true);
    expect(hasTaskMarker("Appeler Paul @", TODAY)).toBe(true);
    expect(hasTaskMarker("Acheter du lait", TODAY)).toBe(false);
    expect(hasTaskMarker("Écrire à paul@uni.edu", TODAY)).toBe(false);
    expect(hasTaskMarker("Vérifier que a > b", TODAY)).toBe(false);
    expect(hasTaskMarker("Voir @quelquechose", TODAY)).toBe(false);
  });
});

describe("parseTaskLine", () => {
  it("takes unticked checklist lines only", () => {
    expect(parseTaskLine("  - [ ] Appeler Paul @demain")).toEqual({ indent: "  ", bullet: "-", text: "Appeler Paul @demain" });
    expect(parseTaskLine("* [ ] x")).toMatchObject({ bullet: "*" });
    expect(parseTaskLine("- [x] done")).toBeNull();
    expect(parseTaskLine("- [ ] ")).toBeNull();
    expect(parseTaskLine("- [[Task]]")).toBeNull();
  });
});

describe("linkLineEdit", () => {
  const today = { year: 2026, month: 10, day: 15 };

  it("reads @ tokens after the link of a converted line, and the line without them", () => {
    const res = linkLineEdit("- [[Rapport]] @ven", today)!;
    expect(res).toMatchObject({ linkpath: "Rapport", rest: "- [[Rapport]]" });
    expect(res.found!.when.due).toBe("2026-10-16");
    expect(linkLineEdit("  * [[Projets/Rapport|R]] @session mar 14h-16h voir Paul", today)).toMatchObject({
      linkpath: "Projets/Rapport",
      rest: "  * [[Projets/Rapport|R]] voir Paul",
    });
  });

  it("takes #tags after the link for the task (else Obsidian gives them to the note the line is in)", () => {
    expect(linkLineEdit("- [[Untitled task]] #Eejip", today)).toMatchObject({ rest: "- [[Untitled task]]", found: null, tags: ["Eejip"] });
    expect(linkLineEdit("- [[Rapport]] @ven #famille voir Paul", today)).toMatchObject({ rest: "- [[Rapport]] voir Paul", tags: ["famille"] });
    expect(linkLineEdit("- [[Rapport]] #2026", today)).toBeNull();
  });

  it("ignores lines that don't start with a link, and text with no @ token", () => {
    expect(linkLineEdit("Voir [[Rapport]] @ven", today)).toBeNull();
    expect(linkLineEdit("- [[Rapport]] écrire à paul@exemple.fr", today)).toBeNull();
    expect(linkLineEdit("- [[Rapport]]", today)).toBeNull();
  });

  it("cuts spans with the space before them", () => {
    expect(cutSpans("a @x b @y", [{ start: 2, end: 4 }, { start: 7, end: 9 }])).toBe("a b");
  });
});

describe("planTask", () => {
  it("takes the date and the tags off the title", () => {
    expect(plan("Préparer démo @lun 14h #olera")).toEqual({
      title: "Préparer démo",
      due: "2026-10-19T14:00",
      repeat: null,
      blocks: [],
      tags: ["olera"],
      parent: null,
      body: "",
    });
  });

  it("keeps time blocks apart: they become events, not note fields", () => {
    const p = plan("Rapport @ven 18h @session mar 14h-16h")!;
    expect(p).toMatchObject({ title: "Rapport", due: "2026-10-16T18:00", blocks: [{ start: "2026-10-20T14:00", end: "2026-10-20T16:00" }] });
    expect(plannedFrontmatter(p, (x) => x)).toEqual({ type: "task", done: false, due: "2026-10-16T18:00" });
  });

  it("writes the repetition as a phrase in the note", () => {
    const p = plan("Sport @chaque lundi et jeudi 7h")!;
    expect(p).toMatchObject({ title: "Sport", due: "2026-10-15T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" }); // a Thursday
    expect(plannedFrontmatter(p, (x) => x)).toMatchObject({ repeat: "every monday and thursday" });
  });

  it("takes a lone @ as a task without a date", () => {
    expect(plan("Acheter du lait @")).toMatchObject({ title: "Acheter du lait", due: null, blocks: [] });
    expect(plan("Acheter @ du lait")).toMatchObject({ title: "Acheter du lait" });
  });

  it("keeps links as their text and copies the line into the note", () => {
    expect(plan("Relire [[Rapport]] avec [[Olera|l'équipe]] @demain")).toMatchObject({
      title: "Relire Rapport avec l'équipe",
      body: "Relire [[Rapport]] avec [[Olera|l'équipe]] @demain",
    });
    expect(plan("Lire [[Docs/Rapport|le rapport]]")).toMatchObject({ title: "Lire le rapport", tags: [] });
  });

  it("takes the #tags out of the title into the note's tags, once each", () => {
    expect(plan("Appeler mamie #famille @demain #Famille #urgent")).toMatchObject({ title: "Appeler mamie", tags: ["famille", "urgent"], body: "" });
    expect(plan("Ranger #projets/maison le garage")).toMatchObject({ title: "Ranger le garage", tags: ["projets/maison"] });
    // Not tags: a number alone, a # inside a word, a heading-like "# ".
    expect(plan("Payer la facture #2026 de C#")).toMatchObject({ title: "Payer la facture 2026 de C", tags: [] });
  });

  it("takes no tags from where it is written: only the line's", () => {
    expect(plan("Envoyer le CR", "Réunions/Point 14-10.md")!.tags).toEqual([]);
  });

  it("makes a sub-task when written in a task note, without its tags", () => {
    expect(plan("Faire le plan @demain", "Tâches/Préparer slides.md")).toMatchObject({ parent: "Tâches/Préparer slides.md", tags: [] });
  });

  it("gives up when nothing is left for a title", () => {
    expect(plan("@demain #famille")).toBeNull();
  });

  it("writes the frontmatter of the new note", () => {
    const p = plan("Faire le plan @demain #cours", "Tâches/Préparer slides.md")!;
    expect(plannedFrontmatter(p, (path) => path.split("/").pop()!.replace(".md", ""))).toEqual({
      type: "task",
      done: false,
      due: "2026-10-16",
      tags: ["cours"],
      parent: "[[Préparer slides]]",
    });
  });
});

describe("chips", () => {
  const ctx = {
    now: new Date("2026-10-15T10:00:00Z"),
    tz: "Europe/Paris",
    lang: "fr",
    words: { today: "Aujourd'hui", tomorrow: "Demain" },
  };

  it("labels due dates, and flags overdue ones", () => {
    expect(dueLabel("2026-10-15", false, ctx)).toEqual({ text: "Aujourd'hui", overdue: false });
    expect(dueLabel("2026-10-16T09:00", false, ctx)).toEqual({ text: "Demain 09:00", overdue: false });
    expect(dueLabel("2026-10-14", false, ctx)).toEqual({ text: "14 oct.", overdue: true });
    expect(dueLabel("2026-10-14", true, ctx).overdue).toBe(false);
    expect(dueLabel("2026-10-15T11:00", false, ctx).overdue).toBe(true); // 11:00 Paris = 09:00 UTC, past
    expect(dueLabel("2027-01-05", false, ctx).text).toBe("5 janv. 2027");
  });

  it("says when a task was made: today, yesterday, else its day; the whole date for the tooltip", () => {
    expect(pastLabel("2026-10-15T09:05", ctx)).toEqual({ relative: "today", day: "15 oct.", full: "jeudi 15 octobre 2026 à 09:05" });
    expect(pastLabel("2026-10-14T23:30", ctx)!.relative).toBe("yesterday");
    expect(pastLabel("2026-10-13", ctx)).toEqual({ relative: null, day: "13 oct.", full: "mardi 13 octobre 2026" });
    expect(pastLabel("2025-12-31T08:00", ctx)!.day).toBe("31 déc. 2025");
    expect(pastLabel("hier", ctx)).toBeNull();
  });

  it("shows the deadline and the repetition", () => {
    const index = new TaskIndex(vault);
    vault.add("Tâches/Sport.md", { type: "task", done: false, due: "2026-10-14", repeat: "every monday" });
    index.rebuild();
    const m = chipModel(index.get("Tâches/Sport.md")!, { ...ctx, contextTags: [], children: [], sync: "synced" });
    expect(m.due).toEqual({ text: "14 oct.", overdue: true });
    expect(m.repeat).toBe("chaque lundi");
  });

  it("shows the tags the note it's in doesn't have, plus progress and sync", () => {
    const index = new TaskIndex(vault);
    vault.add("Tâches/Faire le plan.md", { type: "task", done: true, parent: "[[Préparer slides]]", tags: ["cours", "#urgent"] });
    vault.add("Tâches/Réserver salle.md", { type: "task", done: false, parent: "[[Préparer slides]]" });
    index.rebuild();
    const task = index.get("Tâches/Préparer slides.md")!;
    const base = { ...ctx, children: index.childrenOf(task.path), sync: "pending" as const };
    expect(chipModel(task, { ...base, contextTags: [] })).toMatchObject({ tags: ["cours"], progress: "1/2", sync: "pending" });
    expect(chipModel(task, { ...base, contextTags: ["Cours"] }).tags).toEqual([]);
    const kid = index.get("Tâches/Faire le plan.md")!;
    expect(chipModel(kid, { ...base, children: [], contextTags: ["cours"] }).tags).toEqual(["urgent"]);
  });
});
