import { normalizePath, PluginSettingTab } from "obsidian";
import type { App, Plugin, SettingDefinitionItem } from "obsidian";
import { EVENT_DATE_FORMATS, noteDate, type EventDateFormat } from "./calendar/event-notes";
import { t } from "./i18n";

/**
 * Persisted settings (`data.json`, which syncs with the vault: never put a secret here; the CalDAV password goes in
 * Obsidian's keychain). Settings cover names and connections, not the data model (spec §2.5).
 */
export interface CalendarTasksSettings {
  serverUrl: string;
  username: string;
  /** Name of the secret in Obsidian's keychain (`app.secretStorage`); the password itself is never stored here. */
  passwordSecret: string;
  /** URL of the calendar new tasks go to; empty = automatic. */
  /** The collection new tasks and events go to when nothing else says (URL; "" = the first by name). */
  defaultCalendar: string;
  tasksFolder: string;
  eventsFolder: string;
  /** The day in event note names: "13-10-2026" by default. */
  eventDateFormat: EventDateFormat;
  taskBaseFile: string;
  /** Without the leading `#`. */
  projectTag: string;
  syncIntervalMinutes: number;
  reminderNoteLink: boolean;
  /** Lowercase. Fallback when the server doesn't advertise `calendar-user-address-set`. */
  myAddresses: string[];
  /** The task list base file was written once (never recreated, even if deleted). */
  taskBaseCreated: boolean;
  /** Calendar URLs hidden in the calendar view. */
  hiddenCalendars: string[];
  /** Last calendar picked for a new event. */
  /** The calendar view's "To plan" panel is open. */
  planPanelOpen: boolean;
  /** The task panel shows only tasks with no time block. */
  planUnplannedOnly: boolean;
  /** Task notes show their properties under the task header (hidden by default: the header says it all). */
  showTaskProperties: boolean;
  /** The calendar view last shown ("timeGridWeek"…). */
  calendarView: string;
}

export const DEFAULT_SETTINGS: CalendarTasksSettings = {
  serverUrl: "",
  username: "",
  passwordSecret: "",
  defaultCalendar: "",
  tasksFolder: "Tasks",
  eventsFolder: "Calendar",
  eventDateFormat: "DD-MM-YYYY",
  taskBaseFile: "Tasks.base",
  projectTag: "project",
  syncIntervalMinutes: 5,
  reminderNoteLink: true,
  myAddresses: [],
  taskBaseCreated: false,
  hiddenCalendars: [],
  planPanelOpen: false,
  planUnplannedOnly: false,
  showTaskProperties: false,
  calendarView: "",
};

/** Saved data (any shape, from any version) → valid settings. Unknown or invalid values fall back to defaults. */
export function mergeSettings(saved: unknown): CalendarTasksSettings {
  const s = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>;
  const str = (k: keyof CalendarTasksSettings | "taskCalendar" | "eventCalendar"): string | undefined =>
    typeof s[k] === "string" ? s[k].trim() : undefined;
  // normalizePath turns "" into "/" (the vault root), which is never a valid choice here.
  const path = (k: "tasksFolder" | "eventsFolder" | "taskBaseFile"): string => {
    const p = normalizePath(str(k) ?? "");
    return p === "/" ? DEFAULT_SETTINGS[k] : p;
  };
  const interval = Number(s.syncIntervalMinutes);
  const addresses = Array.isArray(s.myAddresses)
    ? s.myAddresses
    : typeof s.myAddresses === "string"
      ? s.myAddresses.split(",")
      : [];
  const url = str("serverUrl") ?? "";
  return {
    serverUrl: url && !/^https?:\/\//i.test(url) ? `https://${url}` : url,
    username: str("username") ?? "",
    passwordSecret: str("passwordSecret") ?? "",
    // Before collections held both, there was one for tasks and the last one used for events.
    defaultCalendar: str("defaultCalendar") ?? (str("taskCalendar") || str("eventCalendar") || ""),
    tasksFolder: path("tasksFolder"),
    eventsFolder: path("eventsFolder"),
    eventDateFormat: EVENT_DATE_FORMATS.find((f) => f === s.eventDateFormat) ?? DEFAULT_SETTINGS.eventDateFormat,
    taskBaseFile: path("taskBaseFile"),
    projectTag: str("projectTag")?.replace(/^#+/, "") || DEFAULT_SETTINGS.projectTag,
    syncIntervalMinutes:
      Number.isFinite(interval) && interval >= 1 ? Math.round(interval) : DEFAULT_SETTINGS.syncIntervalMinutes,
    reminderNoteLink: typeof s.reminderNoteLink === "boolean" ? s.reminderNoteLink : DEFAULT_SETTINGS.reminderNoteLink,
    myAddresses: addresses
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim().toLowerCase().replace(/^mailto:/, ""))
      .filter((a) => a.includes("@")),
    taskBaseCreated: s.taskBaseCreated === true,
    hiddenCalendars: Array.isArray(s.hiddenCalendars) ? s.hiddenCalendars.filter((u): u is string => typeof u === "string") : [],
    planPanelOpen: s.planPanelOpen === true,
    planUnplannedOnly: s.planUnplannedOnly === true,
    showTaskProperties: s.showTaskProperties === true,
    calendarView: str("calendarView") ?? "",
  };
}

export interface SettingsHost extends Plugin {
  settings: CalendarTasksSettings;
  saveSettings(): Promise<void>;
  testConnection(): Promise<void>;
  regenerateTaskBase(): void;
  /** Writable collections, URL → name, by name. */
  collections(): Record<string, string>;
}

type Key = keyof CalendarTasksSettings;

/** Declarative settings (Obsidian 1.13+): Obsidian renders them and indexes them for settings search. */
export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private host: SettingsHost,
  ) {
    super(app, host);
  }

  override getSettingDefinitions(): SettingDefinitionItem<Key>[] {
    const collections = this.host.collections();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // None chosen yet (or deleted): the one used, the first by name.
    const settings = this.host.settings;
    if (!(settings.defaultCalendar in collections)) settings.defaultCalendar = Object.keys(collections)[0] ?? "";
    return [
      {
        type: "group",
        heading: t("settings.server"),
        items: [
          {
            name: t("settings.serverUrl"),
            desc: t("settings.serverUrl.desc"),
            control: { type: "text", key: "serverUrl", placeholder: "https://cal.example.com/dav/" },
          },
          { name: t("settings.username"), control: { type: "text", key: "username" } },
          { name: t("settings.password"), desc: t("settings.password.desc"), control: { type: "secret", key: "passwordSecret" } },
          {
            name: t("settings.testConnection"),
            desc: t("settings.testConnection.desc"),
            action: () => void this.host.testConnection(),
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.tasks"),
        items: [
          {
            name: t("settings.defaultCalendar"),
            desc: t("settings.defaultCalendar.desc"),
            control: {
              type: "dropdown",
              key: "defaultCalendar",
              options: Object.keys(collections).length ? collections : { "": "—" },
            },
          },
          {
            name: t("settings.tasksFolder"),
            desc: t("settings.tasksFolder.desc"),
            control: { type: "folder", key: "tasksFolder", placeholder: DEFAULT_SETTINGS.tasksFolder },
          },
          {
            name: t("settings.taskBaseFile"),
            desc: t("settings.taskBaseFile.desc"),
            control: { type: "text", key: "taskBaseFile", placeholder: DEFAULT_SETTINGS.taskBaseFile },
          },
          {
            name: t("settings.regenerateBase"),
            desc: t("settings.regenerateBase.desc"),
            action: () => this.host.regenerateTaskBase(),
          },
          {
            name: t("settings.projectTag"),
            desc: t("settings.projectTag.desc"),
            control: { type: "text", key: "projectTag", placeholder: DEFAULT_SETTINGS.projectTag },
          },
          {
            name: t("settings.reminderNoteLink"),
            desc: t("settings.reminderNoteLink.desc"),
            control: { type: "toggle", key: "reminderNoteLink" },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.events"),
        items: [
          {
            name: t("settings.eventsFolder"),
            desc: t("settings.eventsFolder.desc"),
            control: { type: "folder", key: "eventsFolder", placeholder: DEFAULT_SETTINGS.eventsFolder },
          },
          {
            name: t("settings.eventDateFormat"),
            desc: t("settings.eventDateFormat.desc"),
            control: {
              type: "dropdown",
              key: "eventDateFormat",
              // Shown as an example: today's date, written each way.
              options: Object.fromEntries(EVENT_DATE_FORMATS.map((f) => [f, noteDate(today, f)])),
            },
          },
          {
            name: t("settings.syncInterval"),
            desc: t("settings.syncInterval.desc"),
            control: { type: "number", key: "syncIntervalMinutes", min: 1, step: 1 },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.invitations"),
        items: [
          {
            name: t("settings.myAddresses"),
            desc: t("settings.myAddresses.desc"),
            control: { type: "text", key: "myAddresses", placeholder: "you@example.com, you@school.edu" },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    const value = this.host.settings[key as Key];
    return Array.isArray(value) ? value.join(", ") : value;
  }

  /** Every change goes through `mergeSettings`, so what's saved is always valid. */
  override async setControlValue(key: string, value: unknown): Promise<void> {
    this.host.settings = mergeSettings({ ...this.host.settings, [key]: value });
    await this.host.saveSettings();
    this.refreshDomState(); // `visible` predicates (the "Add an account" row)
  }
}
