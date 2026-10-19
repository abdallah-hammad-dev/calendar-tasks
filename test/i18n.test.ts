import { afterEach, describe, expect, it } from "vitest";
import { language } from "./stubs/obsidian";
import { t } from "../src/i18n";

describe("t", () => {
  afterEach(() => {
    language.current = "en";
  });

  it("uses English by default and French when Obsidian is in French", () => {
    expect(t("settings.tasks")).toBe("Tasks");
    language.current = "fr";
    expect(t("settings.tasks")).toBe("Tâches");
  });
});

describe("placeholders", () => {
  it("fills {name} from vars and leaves unknown ones", () => {
    expect(t("sync.done", { calendars: 3, changes: 2 })).toBe("Synced 3 calendars (2 changes).");
    expect(t("sync.failed")).toBe("Calendar sync failed: {error}");
  });
});
