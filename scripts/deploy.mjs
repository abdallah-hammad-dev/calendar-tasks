// Build the plugin and deploy it into a test vault.
//
//   TEST_VAULT=/mnt/c/Users/<you>/Documents/ct-test-vault npm run deploy
//
// Defaults to ./test-vault. Seeds the vault from ./test-vault on first deploy
// and refuses to touch any non-empty folder without the test-vault marker, so it
// can never write into a real vault.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MARKER = ".calendar-tasks-test-vault";
const repo = resolve(import.meta.dirname, "..");
const vault = resolve(process.env.TEST_VAULT ?? join(repo, "test-vault"));

if (existsSync(vault) && readdirSync(vault).length && !existsSync(join(vault, MARKER))) {
  console.error(`Refusing to deploy: ${vault} is not empty and has no ${MARKER} marker. Is it a real vault?`);
  process.exit(1);
}

if (!process.argv.includes("--no-build")) execSync("npm run build", { cwd: repo, stdio: "inherit" });

if (vault !== join(repo, "test-vault")) {
  // Seed notes, but never overwrite what you changed in the deployed vault.
  cpSync(join(repo, "test-vault"), vault, { recursive: true, force: false, errorOnExist: false });
}
writeFileSync(join(vault, MARKER), "This folder is a disposable test vault for calendar-tasks.\n");

const pluginDir = join(vault, ".obsidian", "plugins", "calendar-tasks");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, f), join(pluginDir, f));
// Hot Reload plugin (if installed) reloads us when main.js changes.
writeFileSync(join(pluginDir, ".hotreload"), "");

console.log(`Deployed to ${pluginDir}`);
