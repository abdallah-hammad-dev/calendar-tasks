import { describe, expect, it } from "vitest";
import { categoriesFor, findTags, isTag, sameTags, tagOfCategory, tagsFromCategories, tagsOf, withoutTag, withTags } from "../src/tasks/tags";

describe("tags", () => {
  it("follows Obsidian's rule: letters, digits, _ - /, not only digits", () => {
    expect(["famille", "projets/maison", "à_faire", "2026-bis", "Été"].every(isTag)).toBe(true);
    expect(["2026", "", "a b", "a#b", "a.b"].some(isTag)).toBe(false);
  });

  it("reads the property as a list or a string, with or without #, once each", () => {
    expect(tagsOf(["famille", "#urgent", "Famille", 2026, "a b"])).toEqual(["famille", "urgent"]);
    expect(tagsOf("famille, #urgent maison")).toEqual(["famille", "urgent", "maison"]);
    expect(tagsOf(null)).toEqual([]);
  });

  it("finds #tags in a line, and where they are", () => {
    const text = "#famille Appeler mamie #urgent, pas C# ni #2026";
    const found = findTags(text);
    expect(found.tags).toEqual(["famille", "urgent"]);
    expect(found.spans.map((s) => text.slice(s.start, s.end))).toEqual(["#famille", "#urgent"]);
  });

  it("turns categories into tags and back without losing the reminder's spelling", () => {
    expect(tagOfCategory("Work stuff")).toBe("Work-stuff");
    expect(tagOfCategory("2026")).toBeNull();
    expect(tagsFromCategories(["Work stuff", "Famille", "famille", "2026"])).toEqual(["Work-stuff", "Famille"]);
    expect(categoriesFor(["work-stuff", "urgent"], ["Work stuff", "Famille", "2026"])).toEqual(["Work stuff", "2026", "urgent"]);
    expect(categoriesFor([], ["Famille"])).toEqual([]);
  });

  it("adds tags to the property, keeping what's there as written", () => {
    expect(withTags(["famille", "#vieux"], ["Urgent", "famille"])).toEqual(["famille", "#vieux", "Urgent"]);
    expect(withTags("famille", ["urgent"])).toEqual(["famille", "urgent"]);
    expect(withTags(undefined, ["Eejip"])).toEqual(["Eejip"]);
    expect(withTags(["Famille"], ["famille"])).toBeNull();
  });

  it("takes one tag off the property, in any case, the others kept as written", () => {
    expect(withoutTag(["famille", "#Urgent", 3], "urgent")).toEqual(["famille", 3]);
    expect(withoutTag("famille, urgent", "Famille")).toEqual(["urgent"]);
    expect(withoutTag(undefined, "x")).toEqual([]);
  });

  it("compares tags in any order and case", () => {
    expect(sameTags(["a", "B"], ["b", "A"])).toBe(true);
    expect(sameTags(["a"], ["a", "b"])).toBe(false);
  });
});
