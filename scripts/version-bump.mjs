// Runs from `npm version <patch|minor|major|x.y.z>` (the "version" script): copies the new
// package.json version into manifest.json and records its minAppVersion in versions.json,
// so the git tag npm creates matches what Obsidian and BRAT expect.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!version) throw new Error("Run through `npm version`, not directly.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`manifest.json and versions.json → ${version} (minAppVersion ${manifest.minAppVersion})`);
