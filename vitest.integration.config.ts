import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Tests against the local Davis bench (~/organisation/calendar/davis). Not run in CI. */
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)) },
  },
  test: { include: ["test/integration/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
