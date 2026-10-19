import { describe, expect, it } from "vitest";
import { linkpathOf, normalizeDue, readNote, sanitizeTitle, titleMatches } from "../src/tasks/notes";
import { taskBaseFile } from "../src/tasks/base-file";

describe("task note frontmatter", () => {
  it("reads a task note and ignores other notes", () => {
    expect(
      readNote({ type: "task", done: true, due: "2026-10-15 14:00", repeat: "every week", project: "[[Olera]]", caldav_uid: "u", collection: " Pro " }),
    ).toEqual({
      done: true,
      due: "2026-10-15T14:00",
      repeat: "FREQ=WEEKLY",
      priority: null,
      project: "Olera",
      parent: null,
      uid: "u",
      collection: "Pro",
    });
    expect(readNote({ type: "note" })).toBeNull();
    expect(readNote(null)).toBeNull();
  });

  it("reads the priority in English or French; anything else is left alone", () => {
    const priority = (v: unknown) => readNote({ type: "task", priority: v })!.priority;
    expect(priority("high")).toBe("high");
    expect(priority(" Moyenne ")).toBe("medium");
    expect(priority("basse")).toBe("low");
    expect(priority("")).toBeNull();
    expect(priority(undefined)).toBeNull();
    expect(priority("urgent")).toBeUndefined();
    expect(priority(2)).toBeUndefined();
  });

  it("accepts YAML dates as Obsidian may hand them over", () => {
    expect(normalizeDue(new Date(Date.UTC(2026, 9, 15)))).toBe("2026-10-15");
    expect(normalizeDue(new Date(Date.UTC(2026, 9, 15, 14, 30)))).toBe("2026-10-15T14:30");
    expect(normalizeDue("tomorrow")).toBeNull();
  });

  it("reads link paths in every shape", () => {
    expect(linkpathOf("[[Projets/Olera|Olera]]")).toBe("Projets/Olera");
    expect(linkpathOf("[[Olera#Plan]]")).toBe("Olera");
    expect(linkpathOf(["[[Olera]]"])).toBe("Olera");
    expect(linkpathOf("Olera")).toBe("Olera");
    expect(linkpathOf(3)).toBeNull();
  });
});

describe("titles", () => {
  it("makes file-safe titles", () => {
    expect(sanitizeTitle("Rapport: v2/final? #urgent")).toBe("Rapport v2 final urgent");
    expect(sanitizeTitle("   ")).toBe("Untitled task");
    expect(sanitizeTitle("x".repeat(200))).toHaveLength(120);
  });

  it("recognizes a note named after a summary, duplicates included", () => {
    expect(titleMatches("Rapport: v2", "Rapport v2")).toBe(true);
    expect(titleMatches("Courses", "Courses (2)")).toBe(true);
    expect(titleMatches("Courses (bio)", "Courses (bio)")).toBe(true);
    expect(titleMatches("Courses", "Courses bio")).toBe(false);
  });
});

describe("taskBaseFile", () => {
  it("filters task notes and has the three views", () => {
    const yaml = taskBaseFile({
      task: "Tâche",
      due: "Deadline",
      repeat: "Répétition",
      priority: "Priorité",
      todo: "À faire",
      byProject: "Par projet",
      done: "Terminées",
    });
    expect(yaml).toContain(`- 'type == "task"'`);
    expect(yaml).toContain('name: "À faire"');

    expect(yaml).toContain("groupBy:\n      property: project");
    // Sorted by deadline, then the most urgent: priority is text, so through a number.
    expect(yaml).toContain(`urgency: 'if(priority == "high" || priority == "haute", 1, if(`);
    expect(yaml).toContain("- property: formula.urgency");
    expect(yaml).toContain("- 'done == true'");
  });
});
