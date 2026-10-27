import { beforeEach, describe, expect, it } from "vitest";
import { chipModel, pastLabel, dueLabel } from "../src/editor/chips";
import { childLineInsert, cutSpans, hasTaskMarker, linkLine, linkLineEdit, parseTaskLine, planTask, plannedFrontmatter, typedAt } from "../src/editor/convert";
import { listingChanges, TaskIndex } from "../src/tasks/task-index";
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

describe("typedAt", () => {
  const at = (line: string) => typedAt(line, line.length);

  it("finds the @ being typed after a space or at the start", () => {
    expect(at("- [ ] Rapport @ven")).toBe(14);
    expect(at("@demain")).toBe(0);
    expect(at("- [ ] Rapport @ven @")).toBe(19);
  });

  it("takes an @ right after a task's link (where a click on the line puts the cursor)", () => {
    expect(at("- [[zzfez]]@")).toBe(11);
    expect(at("- [[zzfez]]@dem")).toBe(11);
    expect(at("  * [[Projets/Rapport|R]]@ven")).toBe(25);
  });

  it("ignores an @ inside a word", () => {
    expect(at("- [ ] écrire à paul@exemple")).toBeNull();
    expect(at("- [ ] Voir [[Rapport]]@ven")).toBeNull(); // not a link line: the link isn't first
    expect(at("- [ ] Rapport")).toBeNull();
  });
});

describe("linkLine", () => {
  it("ends a task's line with a space for its chips, unless text follows the link", () => {
    expect(linkLine("- [[Rapport]]")).toBe("- [[Rapport]] ");
    expect(linkLine("- [[Rapport]]", "  ")).toBe("- [[Rapport]] ");
    expect(linkLine("- [[Rapport]]", " voir Paul")).toBe("- [[Rapport]] voir Paul");
  });
});

describe("childLineInsert", () => {
  const isChild = (l: string) => l === "Enfant";
  const apply = (text: string) => {
    const spot = childLineInsert(text, "- [[Enfant]] ", isChild);
    return spot ? text.slice(0, spot.at) + spot.insert + text.slice(spot.at) : null;
  };
  it("lists a sub-task in its parent's body: first line, under a list, or after a blank line", () => {
    expect(apply("---\ntype: task\n---\n")).toBe("---\ntype: task\n---\n- [[Enfant]] \n");
    expect(apply("---\ntype: task\n---")).toBe("---\ntype: task\n---\n- [[Enfant]] \n");
    expect(apply("---\na: 1\n---\n- [[Autre]] \n\n")).toBe("---\na: 1\n---\n- [[Autre]] \n- [[Enfant]] \n\n");
    expect(apply("---\na: 1\n---\nContexte.\n")).toBe("---\na: 1\n---\nContexte.\n\n- [[Enfant]] \n");
  });
  it("leaves a body that already links to it (a frontmatter link doesn't count)", () => {
    expect(apply("---\na: 1\n---\nVoir [[Enfant|ça]].\n")).toBeNull();
    expect(apply("---\nx: \"[[Enfant]]\"\n---\n")).toBe("---\nx: \"[[Enfant]]\"\n---\n- [[Enfant]] \n");
  });
});

describe("linkLineEdit", () => {
  const today = { year: 2026, month: 10, day: 15 };

  it("reads @ tokens after the link of a converted line, and the line without them", () => {
    const res = linkLineEdit("- [[Rapport]] @ven", today)!;
    expect(res).toMatchObject({ linkpath: "Rapport", rest: "- [[Rapport]] " });
    expect(res.found!.when.due).toBe("2026-10-16");
    expect(linkLineEdit("  * [[Projets/Rapport|R]] @session mar 14h-16h voir Paul", today)).toMatchObject({
      linkpath: "Projets/Rapport",
      rest: "  * [[Projets/Rapport|R]] voir Paul",
    });
  });

  it("reads an @ or a # right after the link", () => {
    expect(linkLineEdit("- [[zzfez]]@demain", today)).toMatchObject({ rest: "- [[zzfez]] ", found: { when: { due: "2026-10-16" } } });
    expect(linkLineEdit("- [[zzfez]]#famille", today)).toMatchObject({ rest: "- [[zzfez]] ", tags: ["famille"] });
  });

  it("takes @tag and #tags after the link for the task", () => {
    const res = linkLineEdit("- [[Untitled task]] @tag Eejip #notes", today)!;
    expect(res).toMatchObject({ rest: "- [[Untitled task]] ", tags: ["notes"] });
    expect(res.found!.when.tags).toEqual(["Eejip"]);
    expect(linkLineEdit("- [[Untitled task]] #Eejip", today)).toMatchObject({ rest: "- [[Untitled task]] ", found: null, tags: ["Eejip"] });
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
    expect(plan("Préparer démo @lun 14h @tag olera")).toEqual({
      title: "Préparer démo",
      due: "2026-10-19T14:00",
      repeat: null,
      blocks: [],
      tags: ["olera"],
      priority: null,
      parent: null,
      body: "",
    });
  });

  it("gives the task a priority, and it goes into the note", () => {
    const p = plan("Rapport @priorité haute @demain")!;
    expect(p).toMatchObject({ title: "Rapport", priority: "high", due: "2026-10-16" });
    expect(plannedFrontmatter(p, (x) => x)).toMatchObject({ priority: "high" });
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

  it("gives the task its @tags and #tags, once each, out of the title", () => {
    expect(plan("Appeler mamie @tag famille @demain @tag urgent")).toMatchObject({ title: "Appeler mamie", tags: ["famille", "urgent"] });
    expect(plan("Ranger #maison le garage @demain")).toMatchObject({ title: "Ranger le garage", tags: ["maison"] });
    expect(plan("Appeler mamie @demain #Famille @tag famille #urgent")).toMatchObject({ title: "Appeler mamie", tags: ["famille", "urgent"] });
    // Not tags: a number alone, a # inside a word.
    expect(plan("Payer la facture #2026 de C#")).toMatchObject({ title: "Payer la facture 2026 de C", tags: [] });
  });

  it("takes no tags from where it is written: only the line's", () => {
    expect(plan("Envoyer le CR", "Réunions/Point 14-10.md")!.tags).toEqual([]);
  });

  it("makes a sub-task when written in a task note, without its tags", () => {
    expect(plan("Faire le plan @demain", "Tâches/Préparer slides.md")).toMatchObject({ parent: "Tâches/Préparer slides.md", tags: [] });
  });

  it("gives up when nothing is left for a title", () => {
    expect(plan("@demain @tag famille #notes")).toBeNull();
  });

  it("writes the frontmatter of the new note", () => {
    const p = plan("Faire le plan @demain @tag cours", "Tâches/Préparer slides.md")!;
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

  it("keeps a renamed parent's children, before Obsidian rewrites their link (not a new parent)", () => {
    const index = new TaskIndex(vault);
    vault.add("Tâches/Réserver salle.md", { type: "task", done: false, parent: "[[Préparer slides]]" });
    index.rebuild();
    void vault.rename("Tâches/Préparer slides.md", "Tâches/Slides.md");
    vault.files.get("Tâches/Réserver salle.md")!.fm!.parent = "[[Préparer slides]]"; // not rewritten yet
    index.rename("Tâches/Préparer slides.md", "Tâches/Slides.md");
    expect(index.get("Tâches/Réserver salle.md")!.parentPath).toBe("Tâches/Slides.md");
    expect(index.childrenOf("Tâches/Slides.md").map((t) => t.basename)).toEqual(["Réserver salle"]);
  });

  it("detaches a sub-task whose line left its parent's note, and attaches it again if the line comes back", () => {
    const index = new TaskIndex(vault);
    const P = "Tâches/Préparer slides.md";
    const kid = "Tâches/Réserver salle.md";
    vault.add(kid, { type: "task", done: false, parent: "[[Préparer slides]]" });
    vault.add("Tâches/Faire le plan.md", { type: "task", done: false, parent: "[[Préparer slides]]" }); // never listed
    vault.add("Tâches/Autre.md", { type: "task", done: false }); // a link, not a sub-task
    vault.files.get(P)!.body = "- [[Réserver salle]] \n- [[Autre]] \n";
    index.rebuild();
    const listed = index.get(P)!;
    expect(listed.links).toEqual([kid, "Tâches/Autre.md"]);
    vault.files.get(P)!.body = "Plus rien.\n";
    index.refresh(P);
    const emptied = index.get(P)!;
    const get = (p: string) => index.get(p);
    expect(listingChanges(listed, emptied, get, new Map())).toEqual({ detach: [kid], attach: [] });

    index.patch(kid, { parentPath: null });
    const detached = new Map([[kid, P]]);
    expect(listingChanges(emptied, listed, get, detached)).toEqual({ detach: [], attach: [kid] });
    expect(listingChanges(emptied, listed, get, new Map()).attach).toEqual([]); // only those detached that way
    index.patch(kid, { parentPath: "Tâches/Autre.md" }); // given another parent meanwhile: it stays there
    expect(listingChanges(emptied, listed, get, detached).attach).toEqual([]);
  });
});
