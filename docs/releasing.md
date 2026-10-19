# Releasing

A release is what BRAT users and manual installs download, so pushing a version tag is the whole job.
GitHub Actions builds, tests and publishes the release (`.github/workflows/release.yml`).

## Cut a release

```sh
git switch main && git pull           # release from an up-to-date, green main
npm version patch                     # or: minor, major, 1.2.3
git push --follow-tags
```

`npm version`:
- bumps `package.json`;
- copies the version into `manifest.json` and records it in `versions.json` (`scripts/version-bump.mjs`);
- commits that change and creates the tag `X.Y.Z`.

Pushing the tag starts the **Release** workflow. It runs these steps, and any failure stops the release:
1. Checks that tag = `manifest.json` version = `package.json` version.
2. Runs `npm run lint`, `npm test`, `npm run build` and `npm run check:mobile`.
3. Publishes the GitHub release `X.Y.Z` with `main.js`, `manifest.json` and `styles.css` attached, and
   auto-generated notes.

Follow it with `gh run watch`, or in the repository's Actions tab. BRAT users get the new version the next time
Obsidian starts.

## Rules

- **Tags have no `v` prefix** (`0.2.0`, not `v0.2.0`). Obsidian and BRAT match the tag against
  `manifest.json`. `.npmrc` sets this for `npm version`.
- **Don't edit `version` in `manifest.json` by hand, and don't create tags by hand.** Always go through
  `npm version`.
- **If a release went wrong, release a new patch** instead of deleting or moving a published tag: BRAT users may
  already have it.
- **Bump `minAppVersion` first** in `manifest.json` if the plugin starts relying on a newer Obsidian API. Then run
  `npm version`, which records it in `versions.json`.

## Pre-releases

```sh
npm version prerelease --preid beta   # 0.2.0-beta.0, 0.2.0-beta.1, …
git push --follow-tags
```

Tags with a `-` are published as GitHub pre-releases. Note that BRAT's **Latest version** picks the highest
version *including* pre-releases. Anyone who installed through BRAT gets betas too, unless they pinned a version
when adding the plugin.

## Before releasing (local checks CI can't run)

CI has no CalDAV server and no Obsidian install, so before a release that touches sync or UI:

```sh
TEST_VAULT=… npm run deploy   # then try it in a test vault against the local Davis bench
```

## What runs where

| | CI (every push to `main` / PR) | Release (tag push) | Local only |
|---|---|---|---|
| lint, unit tests, build, mobile-load check | ✓ | ✓ | |
| tag = manifest = package version | | ✓ | |
| publish GitHub release (3 files) | | ✓ | |
| real CalDAV server, Obsidian test vault | | | ✓ |
