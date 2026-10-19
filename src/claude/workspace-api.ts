import type { App, View, TFile } from "obsidian";
import type * as z from "zod/mini";

/** A tool's input schema: zod v4 (mini) schemas by parameter name. */
export type Shape = Record<string, z.ZodMiniType>;

/**
 * The slice of claude-workspace's Module API (its src/core/module-api.ts) this extension uses, declared here so
 * the two plugins share no code. Structurally compatible with the real types.
 */
export interface ToolResultLike {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDef<S extends Shape = Shape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: S;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler(args: z.infer<z.ZodMiniObject<S>>, extra: { signal: AbortSignal }): Promise<unknown>;
}

export interface ContextProvider {
  id: string;
  viewTypes: string[];
  priority?: number;
  collect(view: View, file: TFile | null): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  render?(data: Record<string, unknown>): string[];
  chip?(data: Record<string, unknown>): string | null;
}

export interface ModuleContext {
  readonly app: App;
  registerTool<S extends Shape>(def: ToolDef<S>): void;
  registerContextProvider(provider: ContextProvider): void;
  registerSkill(skill: { name: string; markdown: string }): void;
  onDispose(fn: () => void): void;
}

export interface WorkspaceModule {
  id: string;
  name: string;
  description?: string;
  platforms?: ("desktop" | "mobile")[];
  isAvailable?(app: App): boolean;
  enabledByDefault?: boolean;
  onload(ctx: ModuleContext): void | Promise<void>;
  onunload?(): void | Promise<void>;
}

interface ClaudeWorkspaceApi {
  readonly version: number;
  registerModule(mod: WorkspaceModule): () => void;
}

/**
 * claude-workspace's public API (`app.plugins.plugins["claude-workspace"].api`). `app.plugins` is undocumented,
 * so this is the only place that touches it; null when the plugin is missing, disabled or an unknown version.
 */
export function claudeWorkspaceApi(app: App): ClaudeWorkspaceApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: ClaudeWorkspaceApi }> } }).plugins;
  const api = plugins?.plugins?.["claude-workspace"]?.api;
  return api && api.version === 1 && typeof api.registerModule === "function" ? api : null;
}
