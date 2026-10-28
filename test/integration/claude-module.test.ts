import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCalendarModule, type CalendarServices } from "../../src/claude/module";
import type { ContextProvider, ToolDef, WorkspaceModule } from "../../src/claude/workspace-api";
import type * as Mcp from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as McpClient from "@modelcontextprotocol/sdk/client/index.js";
import type * as McpMemory from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The module served by claude-workspace's own MCP SDK (with its own zod copy), the way its McpHost does it:
 * schemas cross zod instances, descriptions go through zod's shared registry. Needs ../claude-workspace.
 */
const CW = new URL("../../../claude-workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
const available = existsSync(new URL("server/mcp.js", CW));

const services: CalendarServices = {
  connected: () => true,
  tz: () => "Europe/Paris",
  folders: () => ({ tasks: "Tâches", events: "Calendrier", taskBase: "Tâches.base", eventNoteExample: "13-10-2026 Title" }),
  calendars: () => [{ url: "https://c/perso/", name: "Perso", readOnly: false, components: ["VEVENT"] }],
  occurrences: () => [
    {
      id: "x",
      kind: "event",
      uid: "ev-1",
      recurrenceId: null,
      itemUrl: "https://c/perso/ev-1.ics",
      calendarUrl: "https://c/perso/",
      title: "Point Olera",
      allDay: false,
      start: "2026-10-16T10:00",
      end: "2026-10-16T11:00",
      location: null, meeting: null,
      recurring: false,
      done: false,
      taskUid: null,
      invitation: null,
    },
  ],
  tasks: () => [],
  syncState: () => "synced",
  createEvent: async () => ({ uid: "new" }),
  updateEvent: async () => undefined,
  deleteEvent: async () => undefined,
  rsvp: async () => {
    throw new Error("You're not among this event's attendees (or it doesn't exist).");
  },
  createTask: async (t) => `Tâches/${t.title}.md`,
  setTaskDone: async (t) => t,
  setTaskDates: async (t) => t,
  noteFor: async () => "Calendrier/2026-10-16 Point Olera.md",
  findTask: () => null,
  calendarViewRange: () => null,
  noteInfo: () => null,
};

describe.skipIf(!available)("Claude module through claude-workspace's MCP SDK", () => {
  it("lists the tools with their schemas, runs them and validates input", async () => {
    const tools: ToolDef[] = [];
    const providers: ContextProvider[] = [];
    const skills: { name: string; markdown: string }[] = [];
    await createCalendarModule(services).onload({
      app: {} as never,
      registerTool: (def) => tools.push(def),
      registerContextProvider: (p) => providers.push(p),
      registerSkill: (s) => skills.push(s),
      onDispose: () => undefined,
    });
    expect(tools.every((t) => t.name.startsWith("calendar_"))).toBe(true);
    expect(providers.map((p) => p.id)).toEqual(["calendar-view", "note"]);
    expect(skills[0]!.markdown).toContain("`Tâches/`");
    // Enough to make a view of the tasks: the base, the properties, how to sort by priority.
    expect(skills[0]!.markdown).toContain("`Tâches.base`");
    expect(skills[0]!.markdown).toContain("`Calendrier/13-10-2026 Title.md`");
    expect(skills[0]!.markdown).toMatch(/\| `priority` \| text \|/);
    expect(skills[0]!.markdown).toContain("urgency: 'if(priority ==");

    const { McpServer } = (await import(new URL("server/mcp.js", CW).href)) as typeof Mcp;
    const { Client } = (await import(new URL("client/index.js", CW).href)) as typeof McpClient;
    const { InMemoryTransport } = (await import(new URL("inMemory.js", CW).href)) as typeof McpMemory;
    const server = new McpServer({ name: "obsidian", version: "test" }, { capabilities: { tools: {} } });
    // Same call as claude-workspace's McpHost; typed loosely because the schemas come from another zod copy.
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: object,
      cb: (args: Record<string, unknown>) => Promise<unknown>,
    ) => void;
    for (const def of tools) {
      register(
        def.name,
        { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
        async (args: Record<string, unknown>) => {
          const out = await def.handler(args, { signal: new AbortController().signal });
          return out && typeof out === "object" && "content" in out
            ? out
            : { content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out) }] };
        },
      );
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const listed = await client.listTools();
    const list = listed.tools.find((t) => t.name === "calendar_list")!;
    expect(list.inputSchema.required).toEqual(["from", "to"]);
    expect(JSON.stringify(list.inputSchema)).toContain("local time");
    expect(listed.tools.find((t) => t.name === "calendar_delete_event")!.annotations?.destructiveHint).toBe(true);

    const res = await client.callTool({ name: "calendar_list", arguments: { from: "2026-10-12", to: "2026-10-19" } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({
      timeZone: "Europe/Paris",
      items: [{ title: "Point Olera", start: "2026-10-16T10:00", calendar: "Perso", uid: "ev-1" }],
    });

    const bad = await client.callTool({ name: "calendar_list", arguments: { from: "16/10", to: "2026-10-19" } });
    expect(bad.isError).toBe(true);

    const refused = await client.callTool({ name: "calendar_rsvp", arguments: { uid: "x", answer: "accepted" } });
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not among") }] });

    await client.close();
  });
});

/** claude-workspace's own module registry (its source), what `plugin.api.registerModule` adds to. */
const REGISTRY = new URL("../../../claude-workspace/src/core/ModuleRegistry.ts", import.meta.url);

interface Registry {
  add(mod: WorkspaceModule): () => void;
  start(): Promise<void>;
  list(): { id: string; status: string; origin: { kind: string }; plugin?: { id: string; name?: string; version?: string } }[];
  getTools(): { def: { name: string } }[];
  getSkills(): { name: string }[];
}

describe.skipIf(!existsSync(REGISTRY))("Claude module in claude-workspace's registry", () => {
  it("loads under this plugin's name, and registers again once its previous copy has left", async () => {
    const { ModuleRegistry } = (await import(REGISTRY.href)) as { ModuleRegistry: new (host: object) => Registry };
    const registry = new ModuleRegistry({
      app: {}, // the module uses neither
      plugin: {},
      platform: "desktop",
      isDebug: () => false,
      isModuleEnabled: () => undefined,
      setModuleEnabled: async () => undefined,
      loadModuleData: () => undefined,
      saveModuleData: async () => undefined,
      getActiveContext: async () => ({ activeFile: null, providers: {}, openTabs: [] }),
      getActiveView: () => null,
      notifyContextChanged: () => undefined,
      getPlugin: (id: string) => (id === "calendar-tasks" ? { id, name: "Calendar & Tasks", version: "0.2.0" } : null),
    });
    await registry.start();
    const off = registry.add(createCalendarModule(services));
    await vi.waitFor(() =>
      expect(registry.list()[0]).toMatchObject({
        id: "calendar",
        status: "loaded",
        origin: { kind: "plugin" },
        plugin: { id: "calendar-tasks", name: "Calendar & Tasks", version: "0.2.0" }, // its section: "Calendar & Tasks 0.2.0"
      }),
    );
    expect(registry.getTools().map((t) => t.def.name)).toContain("calendar_list");
    expect(registry.getSkills().map((s) => s.name)).toEqual(["calendar-tasks"]);

    // This plugin reloaded (an update): its new copy comes while the old one is still leaving, and is refused;
    // `watchClaudeWorkspace` tries again 2 s later.
    off();
    expect(() => registry.add(createCalendarModule(services))).toThrow(/already registered/);
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
    registry.add(createCalendarModule(services));
    await vi.waitFor(() => expect(registry.list()[0]?.status).toBe("loaded"));
  });
});
