import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";

describe("mergeSettings", () => {
  it("gives the defaults when nothing is saved", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid saved values", () => {
    const saved = { ...DEFAULT_SETTINGS, tasksFolder: "Tâches", projectTag: "projet", syncIntervalMinutes: 15 };
    expect(mergeSettings(saved)).toEqual(saved);
  });

  it("normalizes what the user types", () => {
    const s = mergeSettings({
      tasksFolder: " /Tâches/ ",
      projectTag: "#projet",
      syncIntervalMinutes: "10",
      myAddresses: " Me@Example.com , mailto:me@school.edu, not-an-address ",
    });
    expect(s.tasksFolder).toBe("Tâches");
    expect(s.projectTag).toBe("projet");
    expect(s.syncIntervalMinutes).toBe(10);
    expect(s.myAddresses).toEqual(["me@example.com", "me@school.edu"]);
  });

  it("falls back to defaults for invalid values", () => {
    const s = mergeSettings({ eventsFolder: "", projectTag: "#", syncIntervalMinutes: 0, reminderNoteLink: "yes" });
    expect(s.eventsFolder).toBe(DEFAULT_SETTINGS.eventsFolder);
    expect(s.projectTag).toBe(DEFAULT_SETTINGS.projectTag);
    expect(s.syncIntervalMinutes).toBe(DEFAULT_SETTINGS.syncIntervalMinutes);
    expect(s.reminderNoteLink).toBe(true);
  });

  it("never keeps the vault root as a folder or a file (what an emptied field becomes)", () => {
    const s = mergeSettings({ tasksFolder: "/", eventsFolder: "/", taskBaseFile: "/" });
    expect([s.tasksFolder, s.eventsFolder, s.taskBaseFile]).toEqual(["Tasks", "Calendar", "Tasks.base"]);
  });
});
