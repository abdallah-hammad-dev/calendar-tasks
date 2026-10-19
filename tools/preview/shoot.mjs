// Screenshot the calendar, task links and settings with Obsidian's real stylesheet.
//
//   npm run ui:preview                       # all scenarios, light + dark
//   npm run ui:preview -- calendar-week settings # only these
//
// Needs Obsidian installed (its stylesheet is read from obsidian.asar) and a Chromium:
//   OBSIDIAN_ASAR=/path/to/obsidian.asar   (auto-detected on Windows/WSL, macOS, Linux)
//   CHROMIUM_PATH=/path/to/chrome          (default: Playwright's cache)
// Output: tools/ui-preview/out/<scenario>-<theme>.png
import { extractFile } from "@electron/asar";
import esbuild from "esbuild";
import { existsSync, globSync, mkdirSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const here = import.meta.dirname;
const repo = resolve(here, "../..");
const cache = join(here, ".cache");
const out = join(here, "out");
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

const SCENARIOS = [
  ["calendar-week", 1200, 820],
  ["calendar-month", 1600, 900],
  // Drags a task from the panel, then clicks an empty slot: the form must open beside the selection, which stays.
  ["calendar-interact", 1200, 820],
  // Clicks an event: its card opens beside it.
  ["calendar-card", 1200, 820],
  // Clicks the marker of close deadlines: their list opens beside it.
  ["calendar-group", 1600, 900],
  // Right-clicks the task list's chip: its card (name, color, shown) opens under it.
  ["calendar-edit", 1600, 900],
  // "+" after the collections: a new one's card (name, a color not used yet); it holds events and tasks.
  ["calendar-new", 1600, 900],
  // Clicks an event's time in its card and types a new start: Save moves it there.
  ["calendar-time", 1200, 820],
  // Ctrl + wheel on the hours: taller hours, quarter-hour lines.
  ["calendar-zoom", 1200, 820],
  ["calendar-list", 1200, 820],
  ["task-links", 760, 520],
  ["settings", 760, 2000],
  ["date-suggest", 1700, 560],
  ["new-task", 760, 760],
  ["edit-task", 760, 740],
  ["edit-task-menu", 760, 760],
  ["new-event", 760, 520],
  // The task form's day preview: the slot typed among the day's events; dragging on it picks another.
  ["task-preview", 1100, 760],
  ["confirm-delete", 760, 420],
  ["date-picker", 520, 640],
  ["slot-picker", 520, 640],
  ["task-note", 900, 600],
  // An event note's header; a click on its time shows the event in the calendar.
  ["event-note", 900, 300],
];
const wanted = process.argv.slice(2);
const run = SCENARIOS.filter(([name]) => !wanted.length || wanted.includes(name));

function findAsar() {
  if (process.env.OBSIDIAN_ASAR) return process.env.OBSIDIAN_ASAR;
  const candidates = [
    ...globSync("/mnt/c/Users/*/AppData/Local/Programs/Obsidian/resources/obsidian.asar"),
    join(homedir(), "AppData/Local/Programs/Obsidian/resources/obsidian.asar"),
    "/Applications/Obsidian.app/Contents/Resources/obsidian.asar",
    "/opt/Obsidian/resources/obsidian.asar",
  ];
  return candidates.find((p) => existsSync(p));
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(homedir(), ".cache/ms-playwright");
  for (const dir of existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse() : []) {
    for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      if (existsSync(join(base, dir, rel))) return join(base, dir, rel);
    }
  }
  throw new Error("No Chromium found. Set CHROMIUM_PATH or run `npx playwright install chromium`.");
}

const asar = findAsar();
if (!asar) throw new Error("Obsidian's obsidian.asar not found. Set OBSIDIAN_ASAR.");
writeFileSync(join(cache, "app.css"), extractFile(asar, "app.css"));
copyFileSync(join(repo, "styles.css"), join(cache, "styles.css"));

const stub = (name) => join(here, name);
await esbuild.build({
  entryPoints: [join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: join(cache, "harness.js"),
  logLevel: "warning",
  alias: {
    obsidian: stub("obsidian-browser.ts"),
  },
  plugins: [
    {
      name: "node-builtins",
      setup(b) {
        b.onResolve({ filter: /^node:/ }, () => ({ path: "node-stub", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const spawn = () => { throw new Error('no processes in preview'); }; export const EditorView = { updateListener: { of: () => ({}) } }; export default {};" }));
      },
    },
  ],
});

writeFileSync(
  join(cache, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css"><link rel="stylesheet" href="styles.css">
<style>
  html, body { height: 100%; margin: 0; }
  .workspace { height: 100vh; }
  .workspace-split.mod-right-split { width: 100%; height: 100%; }
  .workspace-tabs, .workspace-tab-container, .workspace-leaf { height: 100%; }
  .cw-preview-settings { position: static; width: 100%; max-width: none; height: auto; max-height: none; border-radius: 0; overflow: visible; }
  .cw-preview-settings .vertical-tab-content-container, .cw-preview-settings .vertical-tab-content { height: auto; max-height: none; overflow: visible; padding: 24px 32px; }
</style></head><body><script src="harness.js"></script></body></html>`,
);

/** Real mouse input on the calendar: drag a task from the "To plan" panel, then click an empty slot. */
async function interact(page, errors) {
  const box = async (sel) => (await page.locator(sel).first().boundingBox()) ?? errors.push(`missing ${sel}`);
  const tue = await box(".fc-timegrid-col[data-date='2026-10-13']");
  const fri = await box(".fc-timegrid-col[data-date='2026-10-16']");
  const at15 = await box(".fc-timegrid-slot-lane[data-time='15:00:00']");
  const at13 = await box(".fc-timegrid-slot-lane[data-time='13:00:00']");
  const item = await box(".ct-plan-item");
  if (!tue || !fri || !at15 || !at13 || !item) return;
  await page.mouse.move(item.x + 20, item.y + 10);
  await page.mouse.down();
  await page.mouse.move(tue.x + tue.width / 2, at15.y + 5, { steps: 10 });
  await page.mouse.up();
  // Dragging an event lands on 5-minute steps, and its card shows where (25 px ≈ 30 min down, give or take a step).
  const olera = page.locator(".fc-timegrid-event:has-text('Point Olera')").first();
  const ob = await olera.boundingBox();
  if (ob) {
    await page.mouse.move(ob.x + ob.width / 2, ob.y + 10);
    await page.mouse.down();
    await page.mouse.move(ob.x + ob.width / 2, ob.y + 10 + 19, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const time = (await olera.locator(".ct-ev-time").textContent()) ?? "";
    if (!/^10:(05|10|15|20|25)/.test(time)) errors.push(`a dragged event didn't land on a 5-minute step: "${time}"`);
  } else errors.push("missing Point Olera");
  await page.mouse.click(fri.x + fri.width / 2, at13.y + at13.height / 2);
  await page.waitForTimeout(300);
  if (!(await page.locator(".ct-popover").count())) errors.push("no new event form after clicking a slot");
  if (!(await page.locator(".fc-event-mirror").count())) errors.push("the selection went away behind its form");
  const selected = (await page.locator(".fc-event-mirror").first().textContent()) ?? "";
  if (!selected.includes("13:00") || !selected.includes("14:00")) errors.push(`a click should select an hour from 13:00, got "${selected}"`);
  // The start's time typed to the minute moves the selection, its length kept; then the end's.
  await page.locator(".ct-popover .ct-when-time").first().fill("13h37");
  await page.waitForTimeout(100);
  let typed = (await page.locator(".fc-event-mirror").first().textContent()) ?? "";
  if (!typed.includes("13:37") || !typed.includes("14:37")) errors.push(`a typed start should move the selection to 13:37 – 14:37, got "${typed}"`);
  await page.locator(".ct-popover .ct-when-time").nth(1).fill("14h10");
  await page.waitForTimeout(100);
  typed = (await page.locator(".fc-event-mirror").first().textContent()) ?? "";
  if (!typed.includes("14:10")) errors.push(`a typed end should end the selection at 14:10, got "${typed}"`);
  if (!(await page.locator(".ct-popover").count())) errors.push("typing a time closed the form");
}

/** Events whose box cuts what's in it (a title or a time line hidden by the box's bottom or side). */
async function clipped(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".fc-timegrid-event .ct-ev-content")]
      // A line can shrink inside the box (overflow: hidden lets it), so each one is looked at too.
      .filter((c) => [c, ...c.children].some((e) => e.scrollHeight > e.clientHeight + 1))
      .map((c) => `${c.textContent} (${c.clientHeight}px)`),
  );
}

/** Ctrl + wheel up: the hours get taller (quarter hours drawn), the time under the pointer stays put. */
async function zoom(page, errors, theme) {
  const slot = page.locator(".fc-timegrid-slot-lane").first();
  const before = (await slot.boundingBox())?.height ?? 0;
  const lane = await page.locator(".fc-timegrid-slot-lane[data-time='10:00:00']").first().boundingBox();
  if (!lane) return errors.push("missing the 10:00 line");
  await page.mouse.move(lane.x + 200, lane.y);
  await page.keyboard.down("Control");
  // One notch: half hours of ~32px, where a 30-minute session used to be cut.
  for (const step of [1, 2]) {
    await page.mouse.wheel(0, step === 1 ? -100 : -40);
    await page.waitForTimeout(80);
    const cut = await clipped(page);
    if (cut.length) errors.push(`cut after zooming a little: ${cut.join(" | ")}`);
    if (step === 2) await page.screenshot({ path: join(out, `calendar-zoom-a-little-${theme}.png`) });
  }
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  const after = await page.locator(".fc-timegrid-slot-lane[data-time='10:00:00']").first().boundingBox();
  if (!(await page.locator(".fc-timegrid-slot-lane[data-time='10:15:00']").count())) errors.push("no quarter-hour lines once zoomed in");
  const quarter = (await slot.boundingBox())?.height ?? 0;
  if (quarter * 2 <= before * 1.2) errors.push(`the hours didn't get taller: ${before}px per half hour, now ${quarter}px per quarter`);
  if (after && Math.abs(after.y - lane.y) > 12) errors.push(`zooming moved the time under the pointer by ${Math.round(after.y - lane.y)}px`);
  const olera = await page.locator(".fc-timegrid-event:has-text('Point Olera')").first().boundingBox();
  const line = await page.locator(".fc-timegrid-slot-lane[data-time='10:00:00']").first().boundingBox();
  if (olera && line && Math.abs(olera.y - line.y) > 3) errors.push(`events don't follow the zoom: Point Olera at ${olera.y}, 10:00 at ${line.y}`);
}

// Native date and time fields follow the system language, like Obsidian on a French system (13:37, not 01:37 PM).
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--lang=fr-FR"], env: { ...process.env, LANG: "fr_FR.UTF-8", LANGUAGE: "fr" } });
for (const [name, width, height] of run) {
  for (const theme of ["light", "dark"]) {
    // French, like the harness: native date and time fields follow the locale (13:37, not 01:37 PM).
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, locale: "fr-FR" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Obsidian's bundled fonts aren't extracted; ignore those 404s.
    page.on("console", (m) => m.type() === "error" && !m.text().includes("ERR_FILE_NOT_FOUND") && errors.push(m.text()));
    await page.goto(`file://${join(cache, "index.html")}?scenario=${name}&theme=${theme}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 }).catch(() => errors.push("timed out"));
    await page.waitForTimeout(150);
    if (name === "calendar-interact") await interact(page, errors);
    if (name === "calendar-card") {
      // Ticking a task in the calendar ticks it, without opening its card.
      const check = page.locator(".fc-timegrid-event.ct-ev-timeblock .ct-ev-check").first();
      await check.click();
      await page.waitForTimeout(150);
      if (!(await check.evaluate((el) => el.classList.contains("is-checked")))) errors.push("a checkbox click didn't tick");
      if (await page.locator(".ct-popover").count()) errors.push("a checkbox click opened the card");
      await check.click();
      await page.locator(".fc-timegrid-event.ct-ev-pending").first().click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".ct-popover.ct-card").count())) errors.push("no card after clicking an event");
    }
    if (name === "calendar-edit") {
      await page.locator(".ct-legend-item:has-text('Rappels')").click({ button: "right" });
      await page.waitForTimeout(200);
      if ((await page.locator(".ct-popover.ct-cal-card .ct-cal-color").count()) !== 8) errors.push("no calendar card with its colors");
      await page.locator(".ct-cal-color").nth(1).click();
      await page.waitForTimeout(100);
      if (!(await page.locator(".ct-popover.ct-cal-card").count())) errors.push("picking a color closed the card");
      if (!(await page.locator(".ct-popover.ct-cal-card .mod-warning").count())) errors.push("no Delete in a collection's card");
    }
    if (name === "calendar-week") {
      const cut = await clipped(page);
      if (cut.length) errors.push(`cut: ${cut.join(" | ")}`);
      // As in Apple Calendar: a day's header opens that day, the week's tab (top left) that week.
      await page.locator(".fc-col-header-cell-cushion").nth(2).click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".fc-timeGridDay-view").count())) errors.push("a day's header should open its day (with hours)");
      await page.screenshot({ path: join(out, `${name}-day-${theme}.png`) });
      await page.locator("a.fc-timegrid-axis-cushion").first().click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".fc-timeGridWeek-view").count())) errors.push("the week's tab should open its week");
      // Shown from its note: the event blinks.
      const target = page.locator(".fc-timegrid-event[data-occ]").first();
      const id = await target.getAttribute("data-occ");
      await page.evaluate((occ) => window.__reveal(occ, "2026-10-12T10:00"), id);
      if (!(await target.evaluate((el) => el.classList.contains("ct-ev-reveal")))) errors.push("a revealed event should blink");
    }
    if (name === "calendar-zoom") await zoom(page, errors, theme);
    if (name === "task-preview") {
      const day = (await page.locator(".ct-day-preview-day").textContent()) ?? "";
      if (!/jeudi 22 octobre/i.test(day)) errors.push(`the preview should show the typed slot's day, shows "${day}"`);
      if ((await page.locator(".ct-day-preview .ct-ev-placed").count()) !== 1) errors.push("the typed slot isn't drawn in the preview");
      if (!(await page.locator(".ct-day-preview .fc-event:has-text('Réunion d')").count())) errors.push("the day's events aren't in the preview");
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      const at13 = await page.locator(".ct-day-preview .fc-timegrid-slot-lane[data-time='13:00:00']").boundingBox();
      const at14 = await page.locator(".ct-day-preview .fc-timegrid-slot-lane[data-time='14:00:00']").boundingBox();
      // Fields: title; deadline day, time; time block day, from, to.
      const fields = page.locator(".ct-task-form input[type=text], .ct-task-form input:not([type])");
      const typedSlot = async () => `${await fields.nth(3).inputValue()} ${await fields.nth(4).inputValue()}-${await fields.nth(5).inputValue()}`;
      const lane = (time) => page.locator(`.ct-day-preview .fc-timegrid-slot-lane[data-time='${time}']`).boundingBox();
      const drag = async (a, b) => {
        await page.mouse.move(a.x + a.width / 2, a.y + 3);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2, b.y - 3, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(150);
      };
      // Dragged on the preview: straight into the list, drawn there, the fields left as they were.
      if (at13 && at14) {
        await drag(at13, at14);
        // The preview scrolls to what was placed: measure again.
        const [at15, at16] = [await lane("15:00:00"), await lane("16:00:00")];
        if (at15 && at16) await drag(at15, at16);
        const rows = await page.locator(".ct-slot.is-new .ct-slot-when").allTextContents();
        if (rows.join(" | ") !== "jeu. 22 oct. 13:00–14:00 | jeu. 22 oct. 15:00–16:00") errors.push(`two drags should give two rows, got "${rows.join(" | ")}"`);
        if ((await page.locator(".ct-day-preview .ct-ev-placed").count()) !== 3) errors.push("the preview should draw the two rows and the slot typed");
        if ((await typedSlot()) !== "22/10/2026 10h-11h30") errors.push(`a drag shouldn't touch the fields, they hold "${await typedSlot()}"`);
        await page.screenshot({ path: join(out, `${name}-dragged-${theme}.png`) });
        await page.locator(".ct-slot.is-new .clickable-icon").first().click();
        if ((await page.locator(".ct-slot.is-new").count()) !== 1 || (await page.locator(".ct-day-preview .ct-ev-placed").count()) !== 2) errors.push("✕ should take the slot off the list and the preview");
      } else errors.push("no 13:00 / 16:00 lines in the preview");
      // Two slots added on other days, then a click on the first one, then in the deadline: each shows its day.
      const shown = async () => ((await page.locator(".ct-day-preview-day").textContent()) ?? "").toLowerCase();
      for (const [day, from, to] of [["25/10/2026", "1h10", "3h05"], ["30/10/2026", "9h05", "11h45"]]) {
        await fields.nth(3).fill(day);
        await fields.nth(4).fill(from);
        await fields.nth(5).fill(to);
        await fields.nth(5).press("Enter");
      }
      await page.waitForTimeout(100);
      if ((await page.locator(".ct-slot.is-new").count()) !== 3) errors.push("Enter in the slot fields should add the slot");
      if (!(await shown()).includes("30 octobre")) errors.push(`after adding a slot the preview should show its day, shows "${await shown()}"`);
      await page.locator(".ct-slot.is-new").nth(1).click();
      await page.waitForTimeout(100);
      if (!(await shown()).includes("25 octobre")) errors.push(`clicking a slot should show its day, shows "${await shown()}"`);
      if (!(await page.locator(".ct-slot.is-new").nth(1).evaluate((el) => el.classList.contains("is-shown")))) errors.push("the slot shown isn't outlined");
      await page.screenshot({ path: join(out, `${name}-slots-${theme}.png`) });
      await fields.nth(1).click();
      await page.waitForTimeout(100);
      if (!(await shown()).includes("23 octobre")) errors.push(`clicking in the deadline should show its day, shows "${await shown()}"`);
      await page.screenshot({ path: join(out, `${name}-deadline-${theme}.png`) });
      // Each field holds one thing: a time in the day field is marked, as is an end before the start.
      await fields.nth(1).fill("ven 14h");
      if (!(await fields.nth(1).evaluate((el) => el.classList.contains("mod-warning")))) errors.push("a time in the deadline's day field should be marked");
      await fields.nth(1).fill("23/10/2026");
      await fields.nth(3).fill("24/10/2026");
      await fields.nth(4).fill("16h");
      await fields.nth(5).fill("15h");
      if (!(await fields.nth(5).evaluate((el) => el.classList.contains("mod-warning")))) errors.push("an end before the start should be marked");
      await page.screenshot({ path: join(out, `${name}-wrong-${theme}.png`) });
    }
    if (name === "event-note") {
      if ((await page.locator(".ct-event-header .ct-task-header-item").count()) < 4) errors.push("the event header should show when, repetition, place and collection");
      await page.locator(".ct-event-when").click();
      if (!(await page.evaluate(() => window.__revealed))) errors.push("a click on the time should show the event in the calendar");
    }
    if (name === "date-picker") {
      // The day and the time, each in its field: typed, clicked or quick.
      const [day, time] = [page.locator(".ct-dp-fields input").nth(0), page.locator(".ct-dp-fields input").nth(1)];
      const summary = async () => (await page.locator(".ct-dp-summary").textContent()) ?? "";
      if ((await day.inputValue()) !== "23/10/2026" || (await time.inputValue()) !== "14h") errors.push(`should open on 23/10/2026 and 14h, shows "${await day.inputValue()}" / "${await time.inputValue()}"`);
      if (!(await day.evaluate((el) => el === document.activeElement))) errors.push("the day should be ready to type in");
      if (!(await page.locator(".ct-dp-foot button:has-text('Pas de deadline')").count())) errors.push("a deadline set should be removable");
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await day.fill("15/11/2026");
      const month = (await page.locator(".ct-dp-title").textContent()) ?? "";
      if (!/novembre 2026/i.test(month)) errors.push(`a day typed should show its month, shows "${month}"`);
      if ((await page.locator(".ct-dp-day.is-selected").textContent()) !== "15") errors.push("a day typed should be selected");
      if (!/15 novembre 14:00/.test(await summary())) errors.push(`should read 15 novembre 14:00, reads "${await summary()}"`);
      await page.locator(".ct-dp-day:not(.is-other-month)", { hasText: /^20$/ }).click();
      if ((await day.inputValue()) !== "20/11/2026" || (await time.inputValue()) !== "14h") errors.push("a day clicked should fill the day only");
      await page.locator(".ct-dp-quick-time:has-text('18h')").click();
      if ((await time.inputValue()) !== "18h") errors.push(`a quick time should fill the time, gives "${await time.inputValue()}"`);
      await time.fill("");
      if (/\d:\d/.test(await summary())) errors.push(`no time should read so, reads "${await summary()}"`);
      await day.fill("ven 14h");
      if (!(await day.evaluate((el) => el.classList.contains("mod-warning")))) errors.push("a time in the day field should be marked");
      await day.fill("15/20/2000");
      if (!(await day.evaluate((el) => el.classList.contains("mod-warning")))) errors.push("a day not understood should be marked");
      await time.fill("25h");
      await page.screenshot({ path: join(out, `${name}-wrong-${theme}.png`) });
      await page.locator(".ct-dp-foot .mod-cta").click();
      if (!(await page.locator(".ct-date-picker").count())) errors.push("OK shouldn't pick what isn't understood");
    }
    if (name === "new-event") {
      // A task picked names the event; a title typed stays.
      const title = page.locator(".ct-task-title-input");
      const pick = async (n) => {
        await page.locator(".ct-select").last().click();
        await page.locator(".menu-item").nth(n).click();
        await page.evaluate(() => document.querySelectorAll(".menu").forEach((m) => m.remove()));
      };
      await pick(1);
      const named = await title.inputValue();
      if (!named) errors.push("picking a task should name the event");
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await pick(2);
      if ((await title.inputValue()) === named) errors.push("picking another task should rename the event it named");
      await title.fill("Révisions");
      await pick(1);
      if ((await title.inputValue()) !== "Révisions") errors.push("a title typed should stay when a task is picked");
    }
    if (name === "slot-picker") {
      // The day, from, to: a quick range fills both hours; none is the whole day; an end before the start is marked.
      const inputs = page.locator(".ct-dp-fields input");
      const [day, from, to] = [inputs.nth(0), inputs.nth(1), inputs.nth(2)];
      const summary = async () => (await page.locator(".ct-dp-summary").textContent()) ?? "";
      const shown = async () => `${await day.inputValue()} ${await from.inputValue()}-${await to.inputValue()}`;
      if ((await shown()) !== "25/10/2026 14h-16h") errors.push(`should open on 25/10/2026 14h-16h, shows "${await shown()}"`);
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await page.locator(".ct-dp-quick-time:has-text('18h–20h')").click();
      if ((await shown()) !== "25/10/2026 18h-20h") errors.push(`a quick range should fill from and to, gives "${await shown()}"`);
      await from.fill("");
      await to.fill("");
      if (!/toute la journée/.test(await summary())) errors.push(`no hours should read the whole day, reads "${await summary()}"`);
      await from.fill("16h");
      if (!/16:00–17:00/.test(await summary())) errors.push(`a start alone should last an hour, reads "${await summary()}"`);
      await to.fill("15h");
      if (!(await to.evaluate((el) => el.classList.contains("mod-warning")))) errors.push("an end before the start should be marked");
      await page.screenshot({ path: join(out, `${name}-wrong-${theme}.png`) });
    }
    if (name === "calendar-new") {
      await page.locator(".ct-legend-add").click();
      await page.waitForTimeout(150);
      const create = page.locator(".ct-popover .ct-card-foot .mod-cta");
      if (!(await create.isDisabled())) errors.push("Create should wait for a name");
      await page.keyboard.type("Pro");
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await create.click();
      await page.waitForTimeout(100);
      const made = await page.evaluate(() => window.__created);
      if (made !== "Pro|#E5484D|VEVENT,VTODO") errors.push(`Create should make a collection of events and tasks in the first free color, got ${made}`);
      if (await page.locator(".ct-popover").count()) errors.push("the card stayed open after Create");
    }
    if (name === "calendar-time") {
      await page.locator(".fc-timegrid-event:has-text('Point Olera')").first().click();
      await page.waitForTimeout(200);
      await page.locator(".ct-popover .ct-card-row.is-editable").click();
      await page.waitForTimeout(100);
      // Day and time for the start, then for the end.
      const inputs = page.locator(".ct-popover .ct-when-pair input");
      if ((await inputs.count()) !== 4) errors.push("no start and end fields (day, time) after clicking the time");
      else {
        if (await page.locator(".ct-popover .ct-card-foot").isVisible()) errors.push("the card's own button should go while the time changes");
        if ((await inputs.first().inputValue()) !== "12/10/2026" || (await inputs.nth(1).inputValue()) !== "10h") errors.push("the start should read 12/10/2026, 10h");
        await inputs.nth(1).fill("10h37");
        await page.waitForTimeout(50);
        const end = `${await inputs.nth(2).inputValue()} ${await inputs.nth(3).inputValue()}`;
        if (end !== "12/10/2026 11h37") errors.push(`moving the start should keep the length, end is ${end}`);
        await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
        await page.locator(".ct-popover .ct-card-when-buttons .mod-cta").click();
        await page.waitForTimeout(100);
        const moved = await page.evaluate(() => window.__moved);
        if (moved !== "10:37-11:37") errors.push(`Save should move the event to 10:37-11:37, got ${moved}`);
      }
    }
    if (name === "calendar-group") {
      await page.locator(".ct-ev-group").first().click();
      await page.waitForTimeout(200);
      if ((await page.locator(".ct-popover .ct-card-task").count()) !== 3) errors.push("the group's card doesn't list its 3 tasks");
    }
    const file = join(out, `${name}-${theme}.png`);
    if (name.startsWith("settings")) {
      // Only what's in the viewport gets painted: grow it to the whole settings page first.
      const settings = page.locator(".cw-preview-settings");
      const box = await settings.boundingBox();
      if (box) await page.setViewportSize({ width, height: Math.max(height, Math.ceil(box.y + box.height)) });
      await settings.screenshot({ path: file });
    } else if (!["calendar-time", "calendar-new", "task-preview", "slot-picker", "date-picker", "new-event"].includes(name)) await page.screenshot({ path: file });
    console.log(`${errors.length ? "✗" : "✓"} ${name}-${theme}${errors.length ? `  ${errors.join(" | ")}` : ""}`);
    await page.close();
  }
}
await browser.close();
console.log(`Screenshots in ${out}`);
