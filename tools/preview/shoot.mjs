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
import { fullcalendarPatch } from "../fullcalendar-patch.mjs";

const here = import.meta.dirname;
const repo = resolve(here, "../..");
const cache = join(here, ".cache");
const out = join(here, "out");
mkdirSync(cache, { recursive: true });
mkdirSync(out, { recursive: true });

const SCENARIOS = [
  ["calendar-week", 1200, 820],
  ["calendar-month", 1600, 900],
  // Narrow, busy days: each day's lines one under the other, then "+N more" right under them.
  ["calendar-month-narrow", 1000, 800],
  // In a tab beside a sidebar, as in Obsidian: what's dragged in the month stays under the pointer, the day it
  // lands on is outlined, and it lands there.
  ["calendar-month-drag", 1600, 900],
  // Drags a task from the panel, then clicks an empty slot: the form must open beside the selection, which stays.
  ["calendar-interact", 1200, 820],
  // Drags an event, a work session and a deadline (written as the plugin writes them): nothing moves until "Move"
  // is on, then each lands where it's dropped, to the 5 minutes, and stays.
  ["calendar-drag", 1200, 820],
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
  // The agenda on Thursday 15 at 11:00 (the clock is set): a heading per day with Today and Tomorrow, one mark per
  // line in one column, a deadline's time after a flag, what's over faded; narrow as on a phone (its first view).
  ["calendar-list", 1200, 820],
  ["calendar-list-narrow", 400, 820],
  // At 125 % and 150 % (Windows scaling), read from the pixels: every dotted bar has the same dots, every bar the
  // same width, the key's too, a work session's side its dashes all alike (2026-10-20: dots fell between pixels,
  // unequal).
  ["calendar-marks-month-125", 1600, 900, 1.25],
  ["calendar-marks-month-150", 1600, 900, 1.5],
  ["calendar-marks-week-125", 1200, 820, 1.25],
  ["calendar-marks-week-150", 1200, 820, 1.5],
  ["calendar-marks-list-125", 1200, 820, 1.25],
  ["calendar-marks-list-150", 1200, 820, 1.5],
  ["task-links", 760, 520],
  // A real editor: an `@` typed is a field labelled with its keyword, a block once it has its value; Backspace
  // selects a block, then deletes it; a click on one opens its field. On a task already made, Backspace takes its
  // chips off one by one, and a click on the deadline chip opens its field in its place.
  ["task-fields", 760, 300],
  ["settings", 760, 2000],
  ["date-suggest", 2540, 560],
  ["new-task", 760, 760],
  // A tag being typed in the form: the vault's tags that match, under the field.
  ["new-task-tags", 760, 760],
  ["edit-task", 760, 740],
  ["edit-task-menu", 760, 760],
  ["new-event", 760, 520],
  // The task form's day preview: the slot typed among the day's events; dragging on it picks another.
  ["task-preview", 1100, 760],
  ["confirm-delete", 760, 420],
  ["date-picker", 520, 640],
  ["slot-picker", 520, 640],
  ["task-note", 900, 600],
  ["task-note-short", 900, 300],
  // Done: when, by its checkbox. Repeating: the last time it was done; a click lists every time.
  ["task-note-done", 900, 300],
  ["task-note-repeat", 900, 300],
  ["task-note-repeat-narrow", 600, 300],
  // An event note's header; a click on its time shows the event in the calendar.
  ["event-note", 900, 300],
  // Declined: hidden from the calendar, the answer kept to change it; nothing to show in the calendar.
  ["event-note-declined", 900, 300],
  // Its event deleted: says so, nothing to show in the calendar, a button deletes the note.
  ["event-note-deleted", 900, 300],
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
    fullcalendarPatch(),
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

/** Drags what's at `from` by (dx, dy), in steps as a hand does; `shot` names a screenshot taken mid-drag. */
async function dragBy(page, from, dx, dy, shot) {
  await page.mouse.move(from.x + from.width / 2, from.y + Math.min(8, from.height / 2));
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + dx, from.y + Math.min(8, from.height / 2) + dy, { steps: 12 });
  if (shot) await page.screenshot({ path: shot });
  await page.mouse.up();
}

/**
 * Turns move mode on (events only move when dragged then), and checks it shows all over: the button says "Done",
 * the grid is framed, the hint replaces the key, what can't move is faded.
 */
async function moveMode(page, errors) {
  await page.locator(".ct-cal-action:has-text('Déplacer')").click();
  await page.waitForTimeout(150);
  if (!(await page.locator(".ct-cal-action.is-active:has-text('Terminé')").count())) errors.push("on, the Move button should say Done");
  const frame = await page.locator(".ct-calendar-grid").evaluate((el) => getComputedStyle(el).outlineStyle);
  if (frame !== "solid") errors.push("in move mode the grid should be framed");
  if (!(await page.locator(".ct-move-hint").count()) || (await page.locator(".ct-key").count())) errors.push("in move mode the hint should replace the key");
  const fixed = await page.locator(".fc-event.ct-ev-pending").first().evaluate((el) => getComputedStyle(el).opacity).catch(() => null);
  if (fixed !== null && Number(fixed) > 0.5) errors.push(`an invitation (can't move) should fade in move mode, opacity ${fixed}`);
}

/** Types in the `task-fields` editor, checking what the line shows at each step (see SCENARIOS). */
async function taskFields(page, errors, theme) {
  const line = (n) => page.evaluate((n) => window.__view.state.doc.line(n).text, n);
  const selected = () => page.evaluate(() => { const s = window.__view.state; return s.sliceDoc(s.selection.main.from, s.selection.main.to); });
  const cursorAt = (n) => page.evaluate((n) => { const v = window.__view; v.dispatch({ selection: { anchor: v.state.doc.line(n).to } }); v.focus(); }, n);
  const text = (sel) => page.locator(sel).first().textContent().catch(() => null);
  const count = (sel) => page.locator(sel).count();
  const fields = () => page.evaluate(() => window.__fields);
  const shot = (step) => page.screenshot({ path: join(out, `task-fields-${step}-${theme}.png`) });

  await cursorAt(2);
  await page.keyboard.type("@deadline dem");
  if (!(await count(".ct-field"))) errors.push("an @ being typed should be a field");
  if ((await text(".ct-field-label")) !== "Deadline") errors.push(`the field's label reads "${await text(".ct-field-label")}", not Deadline`);
  await shot("typing");
  await page.keyboard.type("ain pour");
  if (await count(".ct-field")) errors.push("the field should close once the title goes on");
  if (!/Demain/.test((await text(".ct-field-block.ct-chip-due")) ?? "")) errors.push(`no deadline block reading Demain (${await text(".ct-field-block")})`);
  await page.keyboard.type(" @tag fam");
  if ((await text(".ct-field-label.is-tag")) !== "#") errors.push("a tag's field should be labelled #");
  await shot("tag");
  await page.keyboard.type("ille");
  await page.keyboard.press("Escape");
  if ((await text(".ct-field-block.ct-chip-tags")) !== "#famille") errors.push(`no #famille block after Escape (${await line(2)})`);
  await page.keyboard.press("Backspace");
  if (!(await count(".ct-field-block.ct-chip-tags.is-selected"))) errors.push("a first Backspace should select the block");
  await shot("selected");
  await page.keyboard.press("Backspace");
  if ((await line(2)) !== "- [ ] Appeler mamie @deadline demain pour") errors.push(`the second Backspace should delete the block: "${await line(2)}"`);
  await page.locator(".ct-field-block.ct-chip-due").click();
  if (!(await count(".ct-field")) || (await selected()) !== "demain") errors.push(`a click on a block should open its field, value selected ("${await selected()}")`);
  await page.keyboard.type("ven");
  if ((await line(2)) !== "- [ ] Appeler mamie @deadline ven pour") errors.push(`typing should replace the value: "${await line(2)}"`);
  await page.keyboard.press("Escape");

  await cursorAt(3);
  // The cursor at the line's end is drawn after the chips, as after text.
  const after = await page.evaluate(() => window.getSelection().getRangeAt(0).comparePoint(document.querySelector(".ct-task-chips"), 0) < 0);
  if (!after) errors.push("the cursor at the line's end is drawn before the chips");
  await page.keyboard.press("Backspace");
  if ((await page.locator(".ct-task-chips .ct-chip.is-selected").getAttribute("data-key").catch(() => null)) !== "tag:urgent") errors.push("Backspace after a task's link should select its last chip");
  await page.keyboard.press("Backspace");
  // At once, before the note is read again.
  if ((await fields()).removed.join() !== "tag:urgent" || (await count(".ct-task-chips [data-key='tag:urgent']"))) errors.push(`the second Backspace should take #urgent off at once (${(await fields()).removed})`);
  if ((await line(3)) !== "- [[Rapport]] ") errors.push(`the task's line should stay as it is: "${await line(3)}"`);
  await page.locator(".ct-task-chips .ct-chip-due").first().click();
  if ((await line(3)) !== "- [[Rapport]] @deadline 16/10/2026 9h30") errors.push(`a click on the deadline chip should open its field: "${await line(3)}"`);
  if ((await selected()) !== "16/10/2026 9h30") errors.push(`the chip's value should be selected ("${await selected()}")`);
  // In the chip's place: after the priority, before #famille.
  const place = await page.evaluate(() => {
    const x = (sel) => document.querySelectorAll(".cm-line")[2].querySelector(sel)?.getBoundingClientRect();
    return { priority: x(".ct-chip-priority")?.right, label: x(".ct-field-label")?.left, end: x(".ct-field")?.right, tag: x(".ct-chip-tags")?.left, due: !!x(".ct-task-chips .ct-chip-due") };
  });
  if (place.due || !(place.priority < place.label && place.end < place.tag)) errors.push(`the field should stand in the chip's place: ${JSON.stringify(place)}`);
  await page.keyboard.type("lun");
  await shot("chip");
  await page.keyboard.press("Escape");
  const closed = (await fields()).closed;
  if (closed.at(-1) !== "- [[Rapport]] @deadline lun|due") errors.push(`Escape should hand the field to the task, in the chip's place (${closed})`);
  await page.waitForTimeout(50);
  if ((await line(3)) !== "- [[Rapport]] " || !/19 oct/.test((await text(".ct-task-chips .ct-chip-due")) ?? "")) errors.push(`the new deadline should be the chip's: "${await line(3)}", ${await text(".ct-task-chips .ct-chip-due")}`);
  // A chip's field emptied (its value, then its label): the value goes from the task, as two Backspaces would.
  await page.locator(".ct-task-chips .ct-chip-due").first().click();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(50);
  if ((await fields()).removed.join() !== "tag:urgent,due") errors.push(`emptying the deadline's field should take the deadline off (${(await fields()).removed})`);
  if ((await line(3)) !== "- [[Rapport]] " || (await count(".cm-line:nth-child(3) .ct-chip-due"))) errors.push(`the line should be back to its link, without the deadline: "${await line(3)}"`);
  // A line from before (no space after the link): a click past its chips gives it its space, the cursor after it.
  const last = await page.evaluate(() => { const r = document.querySelectorAll(".cm-line")[4].querySelector(".ct-task-chips").getBoundingClientRect(); return { x: r.right + 40, y: r.top + r.height / 2 }; });
  await page.mouse.click(last.x, last.y);
  const head = await page.evaluate(() => window.__view.state.selection.main.head === window.__view.state.doc.length);
  if ((await line(5)) !== "- [[Rapport]] " || !head) errors.push(`a click past an old line's chips should give it its space, cursor at its end: "${await line(5)}"`);
  // The priority's chip too (2026-10-27, asked): `@priorité moyenne`, its level selected.
  await page.locator(".ct-task-chips .ct-chip-priority").first().click();
  if ((await line(3)) !== "- [[Rapport]] @priorité moyenne" || (await selected()) !== "moyenne") errors.push(`a click on the priority chip should open its field: "${await line(3)}" ("${await selected()}")`);
  if ((await text(".ct-field-label")) !== "Priorité") errors.push(`the priority's field is labelled "${await text(".ct-field-label")}"`);
  await page.keyboard.type("haute");
  await page.keyboard.press("Escape");
  if ((await fields()).closed.at(-1) !== "- [[Rapport]] @priorité haute|priority") errors.push(`Escape should hand the priority to the task (${(await fields()).closed.at(-1)})`);
  if ((await fields()).form.length) errors.push(`no chip should open the form now (${(await fields()).form})`);
}

/** Moves an event, a work session and a deadline, and checks where each one is drawn after its data changed. */
async function drag(page, errors, theme) {
  const box = async (sel) => (await page.locator(sel).first().boundingBox()) ?? errors.push(`missing ${sel}`);
  const col = async (day) => box(`.fc-timegrid-col[data-date='${day}']`);
  const lane = async (time) => box(`.fc-timegrid-slot-lane[data-time='${time}']`);
  const [wed, thu, fri] = [await col("2026-10-14"), await col("2026-10-15"), await col("2026-10-16")];
  const dayW = thu.x - wed.x;
  const hourH = (await lane("10:00:00")).y - (await lane("09:00:00")).y;
  // Read in one go in the page: between two Playwright calls a redraw may be replacing the element.
  const where = async (sel) => {
    const [css, text] = [sel.replace(/:has-text\('[^']*'\)/, ""), sel.match(/:has-text\('([^']*)'\)/)[1]];
    const at = await page.evaluate(([css, text]) => {
      const el = [...document.querySelectorAll(css)].find((e) => e.textContent.includes(text) && !e.classList.contains("fc-event-mirror"));
      const top = document.querySelector(".fc-timegrid-slot-lane[data-time='00:00:00']")?.getBoundingClientRect().top;
      return el && top !== undefined ? { day: el.closest("[data-date]")?.dataset.date ?? "?", y: el.getBoundingClientRect().top - top } : null;
    }, [css, text]);
    if (!at) return "gone";
    const minutes = Math.round(((at.y / hourH) * 60) / 5) * 5;
    return `${at.day} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  };
  // Locked (as the calendar opens): a drag moves nothing.
  const seminar = ".fc-timegrid-event.ct-ev-event:has-text('Séminaire')";
  await dragBy(page, await box(seminar), dayW, 0);
  await page.waitForTimeout(100);
  if (await page.evaluate(() => window.__moved)) errors.push("a drag shouldn't move anything until Move is on");
  if ((await where(seminar)) !== "2026-10-14 09:00") errors.push(`locked, the event should stay at Wednesday 09:00, is at ${await where(seminar)}`);
  await page.keyboard.press("Escape");
  await moveMode(page, errors);
  const cases = [
    ["an event", ".fc-timegrid-event.ct-ev-event:has-text('Séminaire')", dayW, 0, "2026-10-15 09:00"],
    ["a work session", ".fc-timegrid-event.ct-ev-timeblock:has-text('Préparer slides')", 0, -3 * hourH, "2026-10-15 13:00"],
    ["a deadline", ".fc-timegrid-event.ct-ev-deadline:has-text('Préparer slides')", dayW, -8 * hourH, "2026-10-16 10:00"],
  ];
  for (const [what, sel, dx, dy, want] of cases) {
    const el = await box(sel);
    const before = await where(sel);
    await dragBy(page, el, dx, dy, join(out, `calendar-drag-${what.replace(/ /g, "-")}-${theme}.png`));
    const seen = [];
    // Sampled right after the drop, after the redraw from elsewhere (100 ms), and once it's all settled.
    for (const wait of [50, 150, 400, 1400]) {
      await page.waitForTimeout(wait);
      seen.push(await where(sel));
    }
    console.log(`${what}: ${before} → ${seen.join(" → ")} (want ${want}) moved=${await page.evaluate(() => window.__moved)}`);
    if (seen.some((s) => s !== want)) errors.push(`${what} should land at ${want} and stay there, was at ${seen.join(", then ")}`);
  }
  // Week and day: what can be stretched shows its grip.
  const grip = await page.locator(".fc-timegrid-event.fc-event-draggable .fc-event-resizer-end").first().evaluate((el) => getComputedStyle(el).display).catch(() => "none");
  if (grip === "none") errors.push("in move mode, what can be stretched should show its grip");
  await page.screenshot({ path: join(out, `calendar-drag-mode-${theme}.png`) });
  // Right after a move, its redraws come while the next one is held: the original stays hidden (it showed again
  // beside the one in hand), and the redraws happen once it's dropped.
  await dragBy(page, await box(seminar), dayW, 0); // Thursday → Friday, then at once:
  // Measured in the page: the redraw right after the drop may be replacing it (Playwright then measures nothing).
  const cafe = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".fc-timegrid-event.ct-ev-event")].find((e) => e.textContent.includes("Café avec Léa"));
    const r = el?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!cafe) return errors.push("missing Café avec Léa");
  await page.mouse.move(cafe.x + cafe.width / 2, cafe.y + 8);
  await page.mouse.down();
  const shown = new Set();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cafe.x + cafe.width / 2 - (dayW * i) / 20, cafe.y + 8);
    await page.waitForTimeout(40);
    shown.add(await page.evaluate(() => [...document.querySelectorAll(".fc-timegrid-event")].filter((e) => e.textContent.includes("Café avec Léa") && !e.classList.contains("fc-event-mirror")).map((e) => getComputedStyle(e).visibility).join(",")));
  }
  await page.mouse.up();
  if ([...shown].some((v) => v !== "hidden")) errors.push(`what's dragged should leave no copy behind while redraws come in (its original was ${[...shown].join(", then ")})`);
  await page.waitForTimeout(800);
  if ((await where(seminar)) !== "2026-10-16 09:00") errors.push(`the event moved just before should be on Friday 09:00, is at ${await where(seminar)}`);
  // Escape ends move mode: the key is back, the button says Move again.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  if ((await page.locator(".ct-move-hint").count()) || !(await page.locator(".ct-cal-action:not(.is-active):has-text('Déplacer')").count())) errors.push("Escape should end move mode");
  if ((await where(".fc-timegrid-event.ct-ev-event:has-text('Café avec Léa')")) !== "2026-10-15 15:45") errors.push(`the event held during redraws should land on Thursday 15:45, is at ${await where(".fc-timegrid-event.ct-ev-event:has-text('Café avec Léa')")}`);
}

/** Drags a work session to the next day in the month, inside a tab: the copy in hand stays under the pointer. */
async function monthDrag(page, errors, theme) {
  await moveMode(page, errors);
  // Friday's work session (one on a busy day is under "+N more") onto Wednesday the 21st.
  const sel = ".fc-daygrid-event.ct-ev-timeblock:has-text('Rédiger le mémoire')";
  const from = await page.locator(`.fc-daygrid-day[data-date='2026-10-16'] ${sel}`).first().boundingBox();
  const to = await page.locator(".fc-daygrid-day[data-date='2026-10-21']").boundingBox();
  if (!from || !to) return errors.push("missing the work session or Wednesday's cell");
  const start = { x: from.x + 30, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await page.waitForTimeout(100);
  const copy = await page.locator(".fc-event-dragging").first().boundingBox();
  if (!copy) errors.push("no copy follows the pointer");
  else if (Math.abs(copy.x + 30 - end.x) > 3 || Math.abs(copy.y + copy.height / 2 - end.y) > 3) {
    errors.push(`the copy should stay where it was grabbed, under the pointer (${end.x}, ${end.y}); it's at (${copy.x}, ${copy.y})`);
  }
  if (!(await page.locator(".fc-daygrid-day[data-date='2026-10-21'] .fc-highlight").count())) errors.push("the day it lands on should be outlined");
  await page.screenshot({ path: join(out, `calendar-month-drag-held-${theme}.png`) });
  await page.mouse.up();
  await page.waitForTimeout(700);
  if (!(await page.locator(`.fc-daygrid-day[data-date='2026-10-21'] ${sel}`).count())) errors.push("the work session should land on Wednesday the 21st");
}

/**
 * Each day of the month: its lines one under the other, then "+N more" right under them (2026-10-20: FullCalendar
 * left a hidden line's room empty, a shorter one below it; see tools/fullcalendar-patch.mjs). Between kinds (the
 * bars, the day's deadlines, its work sessions, what has a time), a little room (asked the same day): 6px more
 * there, and only there, in that order.
 */
async function packedDays(page, errors) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll(".fc-daygrid-day")].flatMap((day) => {
      const shown = [...day.querySelectorAll(".fc-daygrid-event-harness > .fc-event")].filter((e) => getComputedStyle(e).visibility !== "hidden");
      const link = day.querySelector(".fc-daygrid-more-link");
      const lines = [...shown, ...(link ? [link] : [])]
        .map((el) => {
          const kind = el.classList.contains("fc-daygrid-dot-event") ? 3 : ["ct-ev-event", "ct-ev-deadline", "ct-ev-timeblock"].findIndex((c) => el.classList.contains(c));
          return { kind: el.matches("a.fc-daygrid-more-link") ? 9 : kind, r: el.getBoundingClientRect() };
        })
        .sort((a, b) => a.r.top - b.r.top);
      return lines.slice(1).map((line, i) => ({
        day: day.dataset.date,
        order: line.kind >= lines[i].kind,
        apart: line.kind !== 9 && line.kind !== lines[i].kind,
        gap: Math.round(line.r.top - lines[i].r.bottom),
      }));
    }),
  );
  const wrong = found.filter((f) => !f.order || (f.apart ? f.gap < 5 || f.gap > 10 : f.gap > 4));
  if (wrong.length) errors.push(`a day's lines should follow one another by kind (a little room between kinds), then "+N more": ${wrong.map((f) => `${f.day} ${f.gap}px${f.order ? "" : " out of order"}`).join(", ")}`);
  if (!found.some((f) => f.apart)) errors.push("no day with lines of two kinds, to check the room between them");
}

/**
 * The marks read from the screenshot's pixels (see SCENARIOS). A pixel is ink when it differs from the background
 * by more than half the most any pixel there does; runs of ink and gaps down a column give a bar's dots.
 */
async function evenMarks(page, errors, scale) {
  const png = (await page.screenshot()).toString("base64");
  const found = await page.evaluate(
    async ([png, scale]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const at = (x, y) => [...data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
      const away = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      // Ink and gaps down column x, from y0 to y1 (device pixels), against the background bg: "■2 ·2 ■2".
      const runs = (x, y0, y1, bg, half) => {
        const out = [];
        for (let y = y0; y < y1; y++) {
          const ink = away(at(x, y), bg) > half;
          const last = out[out.length - 1];
          if (last && last.ink === ink) last.n++;
          else out.push({ ink, n: 1 });
        }
        return out;
      };
      // Its box in device pixels, and `pad` CSS pixels around (the key's bars are no wider than their ink; a line's bar
      // has room around it, and the line above is close).
      const box = (el, pad = 0) => {
        const r = el.getBoundingClientRect();
        return { x0: Math.floor((r.left - pad) * scale), x1: Math.ceil((r.right + pad) * scale), y0: Math.floor((r.top - pad) * scale), y1: Math.ceil((r.bottom + pad) * scale) };
      };
      // The calendar's bars wholly on screen (not those under "+2 more", nor scrolled away) and the key's.
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        return [r.top + 0.5, r.top + r.height / 2, r.bottom - 0.5].every((y) => el.contains(document.elementFromPoint(r.left + r.width / 2, y)));
      };
      const marks = [...document.querySelectorAll(".ct-ev-bar, .ct-key.is-lines .ct-key-swatch:not(.is-deadline)")];
      const bars = marks.filter(shown).map((el) => {
        const b = box(el, el.matches(".ct-key-swatch") ? 2 : 0);
        const bg = at(b.x0, b.y0);
        let most = 0;
        for (let x = b.x0; x < b.x1; x++) for (let y = b.y0; y < b.y1; y++) most = Math.max(most, away(at(x, y), bg));
        const columns = [];
        for (let x = b.x0; x < b.x1; x++) if (runs(x, b.y0, b.y1, bg, most / 2).some((r) => r.ink)) columns.push(x);
        const middle = columns[Math.floor(columns.length / 2)] ?? b.x0;
        const dots = runs(middle, b.y0, b.y1, bg, most / 2);
        while (dots.length && !dots[0].ink) dots.shift();
        while (dots.length && !dots[dots.length - 1].ink) dots.pop();
        const name = el.closest(".fc-event")?.querySelector(".ct-ev-title")?.textContent ?? "the key";
        // As many dots as the bar is tall: what must be alike is each dot and each gap.
        const alike = (ink) => [...new Set(dots.filter((r) => r.ink === ink).map((r) => r.n))];
        const [inks, gaps] = [alike(true), alike(false)];
        const even = inks.length === 1 && gaps.length <= 1 ? `■${inks[0]} ·${gaps[0] ?? "-"}` : dots.map((r) => `${r.ink ? "■" : "·"}${r.n}`).join(" ");
        return { name, dashed: el.matches(".is-dashed, .is-block"), width: columns.length, dots: even };
      });
      // A work session's side: its dashes away from the rounded corners, against its tint just inside.
      const sides = [...document.querySelectorAll(".fc-timegrid-event.ct-ev-timeblock")].map((el) => {
        const b = box(el);
        const x = b.x0 + 1;
        const [y0, y1] = [b.y0 + Math.ceil(6 * scale), b.y1 - Math.ceil(6 * scale)];
        const bg = at(x + Math.ceil(4 * scale), y0);
        const dashes = runs(x, y0, y1, bg, away(at(x, b.y0 + Math.ceil(6 * scale)), bg) / 2 || 40).slice(1, -1);
        return { ink: [...new Set(dashes.filter((r) => r.ink).map((r) => r.n))], gaps: [...new Set(dashes.filter((r) => !r.ink).map((r) => r.n))] };
      });
      return { bars, sides };
    },
    [png, scale],
  );
  const kinds = (dashed) => found.bars.filter((b) => b.dashed === dashed);
  for (const dashed of [false, true]) {
    const widths = [...new Set(kinds(dashed).map((b) => b.width))];
    const named = widths.map((w) => `${w} (${kinds(dashed).find((b) => b.width === w).name})`);
    if (widths.length > 1) errors.push(`${dashed ? "dotted" : "solid"} bars should all be as wide, are ${named.join(", ")} device px`);
  }
  const dots = [...new Set(kinds(true).map((b) => b.dots))];
  const named = dots.map((d) => `${d} (${kinds(true).find((b) => b.dots === d).name})`);
  if (dots.length > 1 || dots.some((d) => !/^■\d+ ·\d+$/.test(d))) errors.push(`dotted bars should all have the same dots, whole and evenly apart: ${named.join(" | ")}`);
  for (const side of found.sides) {
    if (side.ink.length > 1 || side.gaps.length > 1) errors.push(`a work session's dashes should all be alike: dashes ${side.ink.join("/")}, gaps ${side.gaps.join("/")} device px`);
  }
}

/** The agenda reads as a list of days: see SCENARIOS. */
async function agenda(page, errors) {
  const days = await page.locator(".fc-list-day .ct-ld").allTextContents();
  if (days[0] !== "Lundi 12 octobre") errors.push(`a day's heading should read "Lundi 12 octobre", reads "${days[0]}"`);
  if (!days.includes("Jeudi 15 octobreAujourd'hui") || !days.includes("Vendredi 16 octobreDemain")) errors.push(`today and tomorrow should say so: ${days.join(" | ")}`);
  // One mark per line, all in one column: every title starts at the same place.
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".fc-list-event")].map((row) => ({
      marks: row.querySelectorAll(".ct-ev-mark").length + row.querySelectorAll(".ct-ev-title .ct-ev-check").length,
      x: Math.round(row.querySelector(".ct-ev-title")?.getBoundingClientRect().left ?? -1),
    })),
  );
  if (rows.some((r) => r.marks !== 1)) errors.push("each line should have one mark (a solid bar, a dashed one or the checkbox)");
  if (new Set(rows.map((r) => r.x)).size !== 1) errors.push(`titles should all start at the same place, start at ${[...new Set(rows.map((r) => r.x))].join(", ")}`);
  const due = page.locator(".fc-list-event.ct-ev-deadline:has-text('Préparer slides') .fc-list-event-time");
  if (!(await due.locator(".ct-ev-due-icon").count()) || (await due.textContent()) !== "18:00") errors.push("a deadline's time should follow a flag");
  const over = await page.locator(".fc-list-event.ct-ev-event:has-text('Point Olera')").first().evaluate((el) => Number(getComputedStyle(el).opacity));
  const ahead = await page.locator(".fc-list-event.ct-ev-event:has-text('Jury de projet')").first().evaluate((el) => Number(getComputedStyle(el).opacity));
  if (!(over < 1) || ahead !== 1) errors.push(`what's over should fade, not what's ahead (opacity ${over}, ${ahead})`);
  if (!(await page.locator(".ct-key.is-lines").count()) && page.viewportSize().width > 600) errors.push("the key should draw the agenda's marks");
}

/** Real mouse input on the calendar: drag a task from the "To plan" panel, then click an empty slot. */
async function interact(page, errors) {
  const box = async (sel) => (await page.locator(sel).first().boundingBox()) ?? errors.push(`missing ${sel}`);
  const tue = await box(".fc-timegrid-col[data-date='2026-10-13']");
  const fri = await box(".fc-timegrid-col[data-date='2026-10-16']");
  const at15 = await box(".fc-timegrid-slot-lane[data-time='15:00:00']");
  const at13 = await box(".fc-timegrid-slot-lane[data-time='13:00:00']");
  const item = await box(".ct-plan-item");
  if (!tue || !fri || !at15 || !at13 || !item) return;
  // A task dropped from the panel turns Move on, so what's placed stretches at once (2026-10-20, asked).
  const task = await page.locator(".ct-plan-item").first().getAttribute("data-title");
  await page.mouse.move(item.x + 20, item.y + 10);
  await page.mouse.down();
  await page.mouse.move(tue.x + tue.width / 2, at15.y + 5, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  if (!(await page.locator(".ct-calendar.is-moving").count())) errors.push("a task dropped from the panel should turn Move on");
  const placed = await page.locator(`.fc-timegrid-col[data-date='2026-10-13'] .fc-timegrid-event.ct-ev-timeblock:has-text("${task}")`).boundingBox();
  if (!placed) errors.push(`"${task}" dropped on Tuesday should be drawn there as a work session`);
  else {
    // Its bottom edge pulled an hour down.
    const grip = { x: placed.x + placed.width / 2, y: placed.y + placed.height - 2 };
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x, grip.y + at15.height * 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const moved = (await page.evaluate(() => window.__moved)) ?? "";
    const [from, to] = moved.split("-").map((hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)));
    if (!(to - from >= 100)) errors.push(`the session just placed should stretch to about two hours, got "${moved}"`);
  }
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
  // A click beside the events while a menu is open only closes the menu (2026-10-25, asked): no new event.
  await page.locator(".fc-timegrid-event:has-text('Point Olera')").first().click({ button: "right" });
  await page.waitForTimeout(100);
  if (!(await page.locator(".menu").count())) errors.push("no menu on a right-click");
  await page.mouse.click(fri.x + fri.width / 2, at13.y + at13.height / 2);
  await page.waitForTimeout(300);
  if (await page.locator(".menu").count()) errors.push("a click elsewhere should close the menu");
  if (await page.locator(".ct-popover, .fc-event-mirror").count()) {
    errors.push("the click that closed a menu started a new event");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
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
  // A menu of the form (its collection), closed by a click in the grid: the form and its selection stay.
  await page.locator(".ct-popover .ct-select").first().click();
  await page.waitForTimeout(100);
  if (!(await page.locator(".menu").count())) errors.push("the form's collection should open a menu");
  await page.mouse.click(tue.x + tue.width / 2, at13.y + at13.height / 2);
  await page.waitForTimeout(300);
  if (await page.locator(".menu").count()) errors.push("a click in the grid should close the form's menu");
  if (!(await page.locator(".ct-popover").count()) || !(await page.locator(".fc-event-mirror").count())) errors.push("the click that closed the form's menu closed the form");
  typed = (await page.locator(".fc-event-mirror").first().textContent()) ?? "";
  if (!typed.includes("13:37")) errors.push(`the click that closed the form's menu moved the selection: "${typed}"`);
}

/**
 * An event's pencil opens its form filled in, beside it (a series' occurrence stays in its collection), and saving
 * changes it; a work session's pencil opens its own form, its task line the task's; a deadline's pencil opens its
 * task's form. No card has a "…" (it only repeated the card): each action is there once, the trash asks again.
 */
async function editing(page, errors, theme) {
  await page.keyboard.press("Escape");
  const card = async (text, cls) => {
    await page.keyboard.press("Escape");
    await page.locator(`.fc-timegrid-event.${cls}:has-text('${text}')`).first().click();
    await page.waitForTimeout(200);
    return page.locator(".ct-popover.ct-card .ct-card-tools button:has(.lucide-pencil)");
  };
  let pencil = await card("Café avec Léa", "ct-ev-event");
  if ((await pencil.getAttribute("aria-label").catch(() => "")) !== "Modifier") errors.push("no Modifier pencil in an event's card");
  else {
    await pencil.click();
    await page.waitForTimeout(200);
    const form = page.locator(".ct-popover-edit");
    const title = await form.locator(".ct-task-title-input").inputValue().catch(() => "");
    const times = await form.locator(".ct-when-time").evaluateAll((els) => els.map((e) => e.value).join(" "));
    if (title !== "Café avec Léa" || times !== "15h45 16h30") errors.push(`the form should be filled in with the event, got "${title}" ${times}`);
    if (!(await form.locator(".ct-form-name:has-text('Collection')").count())) errors.push("an event's form should offer its collection");
    if (!(await page.locator(".fc-event.is-active:has-text('Café avec Léa')").count())) errors.push("the event should stay marked while its form is open");
    await form.locator(".ct-task-title-input").fill("Café avec Léa et Sam");
    await form.locator(".ct-when-time").nth(1).fill("17h");
    await form.locator(".ct-form-text").fill("Le Bistrot");
    await page.screenshot({ path: join(out, `calendar-card-edit-${theme}.png`) });
    await form.locator(".mod-cta").click();
    await page.waitForTimeout(200);
    const saved = (await page.locator(".fc-timegrid-event:has-text('Café avec Léa et Sam')").first().textContent().catch(() => "")) ?? "";
    if (!saved.includes("15:45 – 17:00 · Le Bistrot")) errors.push(`saving the form should change the event, shows "${saved}"`);
  }
  pencil = await card("Point Olera", "ct-ev-event");
  await pencil.click().catch(() => errors.push("no pencil on an occurrence of a series"));
  await page.waitForTimeout(200);
  if (await page.locator(".ct-popover-edit .ct-form-name:has-text('Collection')").count()) errors.push("an occurrence of a series can't change collection alone");
  const tools = () => page.locator(".ct-popover.ct-card .ct-card-tools button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")).join(", "));
  // A work session: its pencil is its own form; the line of its task, the task's.
  await page.evaluate(() => (window.__editTask = ""));
  pencil = await card("Préparer slides", "ct-ev-timeblock");
  let label = await tools();
  if (label !== "Modifier la session, Supprimer, Annuler") errors.push(`a work session's card tools: "${label}"`);
  const taskLine = page.locator(".ct-popover.ct-card .ct-card-row.is-editable:has-text('Session pour')");
  await page.screenshot({ path: join(out, `calendar-card-session-${theme}.png`) });
  await taskLine.click().catch(() => errors.push("no task line to edit in a work session's card"));
  if ((await page.evaluate(() => window.__editTask)) !== "t1") errors.push("a work session's task line should open its task's form");
  pencil = await card("Préparer slides", "ct-ev-timeblock");
  await pencil.click().catch(() => undefined);
  await page.waitForTimeout(200);
  const session = await page.locator(".ct-popover-edit .ct-task-title-input").inputValue().catch(() => "");
  if (session !== "Préparer slides") errors.push(`a work session's pencil should open its own form, got "${session}"`);
  // A deadline: its task's form, and a session to plan.
  await page.evaluate(() => ((window.__editTask = ""), (window.__pickSlot = "")));
  pencil = await card("Préparer slides", "ct-ev-deadline");
  label = await tools();
  if (label !== "Modifier la tâche, Planifier une session, Annuler") errors.push(`a deadline's card tools: "${label}"`);
  await page.screenshot({ path: join(out, `calendar-card-deadline-${theme}.png`) });
  await pencil.click().catch(() => undefined);
  if ((await page.evaluate(() => window.__editTask)) !== "t1") errors.push("a deadline's pencil should open its task's form");
  await card("Préparer slides", "ct-ev-deadline");
  await page.locator(".ct-popover.ct-card .ct-card-tools button:has(.lucide-calendar-plus)").click().catch(() => undefined);
  if ((await page.evaluate(() => window.__pickSlot)) !== "t1") errors.push("a deadline's Planifier une session should ask for a slot");
  // The trash asks again under it: an event, then a series (this occurrence or all of it).
  for (const [text, items, pick, removed] of [
    ["Café avec Léa et Sam", "Supprimer", 0, "Café avec Léa et Sam|all"],
    ["Point Olera", "Supprimer cette occurrence, Supprimer toute la série", 0, "Point Olera|one"],
  ]) {
    await page.evaluate(() => (window.__removed = ""));
    await card(text, "ct-ev-event");
    if (await page.locator(".ct-popover.ct-card .lucide-more-horizontal").count()) errors.push(`"${text}"'s card still has a "…"`);
    await page.locator(".ct-popover.ct-card .ct-card-tools button:has(.lucide-trash-2)").click().catch(() => errors.push(`no trash on "${text}"`));
    await page.waitForTimeout(100);
    const shown = await page.locator(".menu .menu-item-title").evaluateAll((els) => els.map((e) => e.textContent).join(", "));
    if (shown !== items) errors.push(`"${text}"'s trash offers "${shown}"`);
    if (text === "Point Olera") await page.screenshot({ path: join(out, `calendar-card-delete-${theme}.png`) });
    if (await page.evaluate(() => window.__removed)) errors.push("the trash deleted before its choice");
    await page.locator(".menu .menu-item").nth(pick).click().catch(() => undefined);
    if ((await page.evaluate(() => window.__removed)) !== removed) errors.push(`"${text}"'s trash removed "${await page.evaluate(() => window.__removed)}"`);
    await page.evaluate(() => document.querySelectorAll(".menu").forEach((m) => m.remove()));
  }
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
const launch = (args = []) => chromium.launch({ executablePath: findChromium(), args: ["--lang=fr-FR", ...args], env: { ...process.env, LANG: "fr_FR.UTF-8", LANGUAGE: "fr" } });
const browser = await launch();
// Windows scaling as Chrome does it there: laid out in device pixels, so every edge falls on one. The emulated scale
// (`deviceScaleFactor`) lays out in CSS pixels and scales the paint: it blurred bars Windows draws sharp, and passed
// dashes Windows drew unequal (2026-10-20). So a browser per scale, the screen's own, with only the size emulated.
const scaled = new Map();
async function open(width, height, scale) {
  // French, like the harness: native date and time fields follow the locale (13:37, not 01:37 PM).
  if (scale === 2) return browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale, locale: "fr-FR" });
  if (!scaled.has(scale)) scaled.set(scale, await launch([`--force-device-scale-factor=${scale}`]));
  const page = await scaled.get(scale).newPage({ viewport: null, locale: "fr-FR" });
  // deviceScaleFactor 0: the screen's.
  await (await page.context().newCDPSession(page)).send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: false });
  return page;
}
for (const [name, width, height, scale = 2] of run) {
  for (const theme of ["light", "dark"]) {
    const page = await open(width, height, scale);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Obsidian's bundled fonts aren't extracted; ignore those 404s.
    page.on("console", (m) => m.type() === "error" && !m.text().includes("ERR_FILE_NOT_FOUND") && errors.push(m.text()));
    if (name.startsWith("calendar-list") || name === "task-fields") await page.clock.setFixedTime(new Date(2026, 9, 15, 11, 0));
    await page.goto(`file://${join(cache, "index.html")}?scenario=${name}&theme=${theme}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 }).catch(() => errors.push("timed out"));
    await page.waitForTimeout(150);
    if (name === "calendar-interact") await interact(page, errors);
    if (name === "task-fields") await taskFields(page, errors, theme);
    if (name === "calendar-drag") await drag(page, errors, theme);
    if (name === "calendar-month-drag") await monthDrag(page, errors, theme);
    if (name === "calendar-card") {
      // Ticking a task in the calendar ticks it, without opening its card.
      const check = page.locator(".fc-timegrid-event.ct-ev-timeblock .ct-ev-check").first();
      await check.click();
      await page.waitForTimeout(150);
      if (!(await check.evaluate((el) => el.classList.contains("is-checked")))) errors.push("a checkbox click didn't tick");
      if (await page.locator(".ct-popover").count()) errors.push("a checkbox click opened the card");
      await check.click();
      // An event with its note offers to open it; one without, to create it (event notes are lazy).
      await page.locator(".fc-timegrid-event.ct-ev-event:not(.ct-ev-pending)").first().click();
      await page.waitForTimeout(200);
      const opened = await page.locator(".ct-popover.ct-card .ct-card-open").textContent().catch(() => "");
      if (opened !== "Ouvrir la note") errors.push(`an event with a note shows "${opened}"`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      await page.locator(".fc-timegrid-event.ct-ev-pending").first().click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".ct-popover.ct-card").count())) errors.push("no card after clicking an event");
      const created = await page.locator(".ct-popover.ct-card .ct-card-open").textContent().catch(() => "");
      if (created !== "Créer la note") errors.push(`an event without a note shows "${created}"`);
      // An answer keeps the card open and says where it stands: on its way, then saved once pushed.
      await page.locator(".ct-popover.ct-card .ct-card-rsvp button:has-text('Peut-être')").click();
      await page.waitForTimeout(150);
      const sending = await page.locator(".ct-popover.ct-card .ct-card-status").textContent().catch(() => "");
      if (sending !== "Envoi de ta réponse au serveur…") errors.push(`right after an answer the card says "${sending}"`);
      await page.waitForTimeout(500);
      const saved = await page.locator(".ct-popover.ct-card .ct-card-status").textContent().catch(() => "");
      if (saved !== "Réponse enregistrée.") errors.push(`once pushed the card says "${saved}"`);
      if (!(await page.locator(".ct-popover.ct-card .ct-card-rsvp button.is-active:has-text('Peut-être')").count())) errors.push("the answer isn't shown as chosen");
      if (!(await page.locator(".fc-event.is-active").count())) errors.push("the event lost its highlight when drawn again");
      // A meeting shows its camera on the event, and its card joins it (Teams from Outlook's description; Zoom as the
      // place, which then isn't shown as a place).
      await page.keyboard.press("Escape");
      if (!(await page.locator(".fc-timegrid-event:has-text('Point Olera') .ct-ev-meeting").count())) errors.push("no camera on a Teams meeting");
      const call = page.locator(".fc-timegrid-event:has-text('Appel Paul')").first();
      if (!(await call.locator(".ct-ev-meeting").count())) errors.push("no camera on a Zoom meeting");
      if ((await call.textContent()).includes("zoom.us")) errors.push("a Zoom link shown as a place");
      await page.evaluate(() => {
        window.__opened = [];
        window.open = (url) => (window.__opened.push(url), null);
      });
      await page.locator(".fc-timegrid-event:has-text('Point Olera')").first().click();
      await page.waitForTimeout(200);
      const joinRow = page.locator(".ct-popover.ct-card .ct-card-row.is-link:has-text('Rejoindre Teams')");
      if (!(await joinRow.count())) errors.push("no Join Teams in a Teams meeting's card");
      else {
        await page.screenshot({ path: join(out, `${name}-meeting-${theme}.png`) });
        await joinRow.click();
        const opened = await page.evaluate(() => window.__opened[0] ?? "");
        if (!opened.startsWith("https://teams.microsoft.com/l/meetup-join/")) errors.push(`Join Teams opened "${opened}"`);
      }
      await editing(page, errors, theme);
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
      // What starts right after an event sits beside it (drawn over it, it hid its title); what starts well below
      // still sits over its lower part, so the event keeps its width.
      const at = (sel) => page.locator(sel).first().boundingBox();
      const [course, sheets] = [await at(".fc-timegrid-event:has-text('Cours réseau')"), await at(".fc-timegrid-event:has-text('Imprimer les grilles')")];
      if (!course || !sheets || sheets.x < course.x + course.width) errors.push("a deadline starting right after an event should sit beside it, not over its title");
      const [seminar, wed] = [await at(".fc-timegrid-event:has-text('Séminaire')"), await at(".fc-timegrid-col[data-date='2026-10-14']")];
      if (!seminar || !wed || seminar.width < wed.width * 0.8) errors.push("an event with a deadline near its end should keep its width");
      // The panel says a task's time blocks in words (a clock and a number read as nothing).
      if (!(await page.locator(".ct-plan-blocks:has-text('2 sessions')").count())) errors.push("the panel should say \"2 sessions\" for a task with two work sessions");
      // As in Apple Calendar: a day's header opens that day, the week's tab (top left) that week.
      await page.locator(".fc-col-header-cell-cushion").nth(2).click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".fc-timeGridDay-view").count())) errors.push("a day's header should open its day (with hours)");
      await page.screenshot({ path: join(out, `${name}-day-${theme}.png`) });
      await page.locator("a.fc-timegrid-axis-cushion").first().click();
      await page.waitForTimeout(200);
      if (!(await page.locator(".fc-timeGridWeek-view").count())) errors.push("the week's tab should open its week");
      // An event too short for two lines says its start and end on the title's line; in a week column, too narrow
      // for both beside its title, its start alone.
      const short = () =>
        page.evaluate(() => {
          const call = [...document.querySelectorAll(".fc-timegrid-event")].find((e) => e.textContent.includes("Appel Paul"));
          const content = call?.querySelector(".ct-ev-content");
          return content ? `${getComputedStyle(content).flexDirection} ${content.querySelector(".ct-ev-time").innerText}` : "missing";
        });
      const inWeek = await short();
      if (inWeek !== "row 10:35") errors.push(`a short event in a week column should show its start on its title's line, got "${inWeek}"`);
      await page.locator(".fc-col-header-cell[data-date='2026-10-15'] .fc-col-header-cell-cushion").click();
      await page.waitForTimeout(200);
      const inDay = await short();
      if (inDay !== "row 10:35 – 10:50") errors.push(`a short event with room should show its start and end on its title's line, got "${inDay}"`);
      await page.screenshot({ path: join(out, `${name}-short-${theme}.png`) });
      await page.locator("a.fc-timegrid-axis-cushion").first().click();
      await page.waitForTimeout(200);
      // Shown from its note: the event blinks.
      const target = page.locator(".fc-timegrid-event[data-occ]").first();
      const id = await target.getAttribute("data-occ");
      await page.evaluate((occ) => window.__reveal(occ, "2026-10-12T10:00"), id);
      if (!(await target.evaluate((el) => el.classList.contains("ct-ev-reveal")))) errors.push("a revealed event should blink");
    }
    if (name.startsWith("calendar-list")) await agenda(page, errors);
    if (name.startsWith("calendar-marks")) await evenMarks(page, errors, scale);
    if (name === "calendar-month" || name === "calendar-month-narrow") await packedDays(page, errors);
    if (name === "calendar-month") {
      // Every line looks alike, whatever it is: a work session all day isn't a block (it was, under its line's mark),
      // and the dashes are whole pixels, the same in every bar (fitted to the height, some looked thicker).
      const allDay = page.locator(".fc-daygrid-block-event.ct-ev-timeblock:has-text('Relire le chapitre 2')");
      const look = await allDay.evaluate((el) => getComputedStyle(el).backgroundImage + getComputedStyle(el).backgroundColor).catch(() => "missing");
      if (look !== "nonergba(0, 0, 0, 0)") errors.push(`a work session all day should be a line in the month, not a block (${look})`);
      // A line's bar is no taller than its text (14px); one along a start and its end, seven dots (26px).
      const bars = await page.evaluate(() => [...document.querySelectorAll(".ct-ev-bar")].map((b) => [b.classList.contains("is-tall"), b.getBoundingClientRect().height]));
      if (!bars.length || bars.some(([tall, h]) => h !== (tall ? 26 : 14))) errors.push(`the line bars should be 14px tall, 26px along two lines: ${[...new Set(bars.map(([, h]) => h))].join(", ")}`);
      // What lasts shows its start over its end; a deadline, a moment, one time on one line.
      const lines = await page.evaluate(() => {
        const at = (text) => [...document.querySelectorAll(".fc-daygrid-event")].find((e) => e.textContent.includes(text));
        const olera = at("Point Olera");
        const [start, end] = [olera?.querySelector(".ct-ev-start"), olera?.querySelector(".ct-ev-end")];
        const sheets = at("Imprimer les grilles");
        return {
          olera: start && end ? `${start.textContent}/${end.textContent}/${end.getBoundingClientRect().top > start.getBoundingClientRect().bottom - 2}` : "",
          heights: [olera, sheets].map((e) => Math.round(e?.getBoundingClientRect().height ?? 0)),
        };
      });
      if (lines.olera !== "10:00/11:00/true") errors.push(`an event should show its start over its end, shows ${lines.olera || "nothing"}`);
      if (!(lines.heights[1] > 0 && lines.heights[0] > lines.heights[1] * 1.5)) errors.push(`an event should take two lines, a deadline one: ${lines.heights.join(" vs ")}px`);
    }
    if (name === "calendar-zoom") await zoom(page, errors, theme);
    if (name === "new-task-tags") {
      // "#olera #f": the vault's tags with an "f", less the one already typed; a pick completes the word.
      const offered = await page.locator(".suggestion-container .suggestion-item").allTextContents();
      if (offered.join(" ") !== "#famille #projets/factures") errors.push(`the tags field should offer #famille #projets/factures, offers "${offered.join(" ")}"`);
      await page.screenshot({ path: join(out, `${name}-${theme}.png`) });
      await page.locator(".suggestion-container .suggestion-item").first().dispatchEvent("mousedown");
      const value = await page.locator(".ct-task-tags-input").inputValue();
      if (value !== "#olera #famille ") errors.push(`picking #famille should complete the field, reads "${value}"`);
      if (await page.locator(".suggestion-container").count()) errors.push("the suggestions should close once one is picked");
    }
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
    if (name === "task-note" || name === "task-note-short") {
      // The creation date shows only in the room left on the line: never a line of its own, never cut.
      const r = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const date = document.querySelector(".ct-task-header-created");
        const tools = document.querySelector(".ct-task-header-tools");
        const state = document.querySelector(".ct-task-header-state");
        const area = box(date.parentElement);
        const shown = box(date).top >= area.top - 1 && box(date).bottom <= area.bottom + 1;
        return { oneLine: Math.abs(box(tools).top - box(state).top) < 8, shown, whole: box(date).left >= area.left - 1 };
      });
      if (!r.oneLine) errors.push("the creation date pushed the tools to another line");
      if (name === "task-note-short" && !(r.shown && r.whole)) errors.push("the creation date should show whole when there's room");
      if (name === "task-note" && r.shown) errors.push("the creation date should hide when the header is full");
    }
    if (name === "task-note-done") {
      const word = (await page.locator(".ct-task-header-state").textContent()) ?? "";
      if (word.trim() !== "Faite hier") errors.push(`a done task should say when it was ticked, says "${word}"`);
    }
    if (name === "task-note-repeat" || name === "task-note-repeat-narrow") {
      // The days done, newest first, as many as fit whole on the bar's line; the oldest go first, then nothing cut.
      const r = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const area = box(document.querySelector(".ct-task-header-faint"));
        const inside = (el) => box(el).top >= area.top - 1 && box(el).bottom <= area.bottom + 1 && box(el).right <= area.right + 1;
        const days = [...document.querySelectorAll(".ct-task-header-done-day")].map((el) => ({ text: el.textContent, shown: inside(el) }));
        const created = document.querySelector(".ct-task-header-created");
        const tools = document.querySelector(".ct-task-header-tools");
        const state = document.querySelector(".ct-task-header-state");
        return { days, created: created ? inside(created) : false, oneLine: Math.abs(box(tools).top - box(state).top) < 8 };
      });
      const shown = r.days.filter((d) => d.shown).length;
      if (!r.oneLine) errors.push("the days done pushed the tools to another line");
      if (r.days.slice(0, shown).some((d) => !d.shown) || r.days.slice(shown).some((d) => d.shown)) errors.push("the days shown should be the newest ones, in order");
      if (name === "task-note-repeat" && shown < 3) errors.push(`only ${shown} days done shown with room for more`);
      if (name === "task-note-repeat-narrow" && (shown === 0 || shown === r.days.length)) errors.push(`a narrow bar should show some days, not all: ${shown}`);
      if (r.created && shown < r.days.length) errors.push("the creation date shows while days done are hidden");
      await page.locator(".ct-task-header-done-day").first().click().catch(() => errors.push("no days done in a repeating task's header"));
      await page.waitForTimeout(100);
      const listed = await page.locator(".menu .menu-item-title").evaluateAll((els) => els.map((e) => e.textContent).join(" | "));
      if (!listed.startsWith("lundi 26 octobre") || listed.split(" | ").length !== 6) errors.push(`the history menu shows "${listed}"`);
      await page.screenshot({ path: join(out, `${name}-menu-${theme}.png`) });
    }
    if (name === "event-note") {
      if ((await page.locator(".ct-event-header .ct-task-header-item").count()) < 5) errors.push("the event header should show when, repetition, meeting, place and collection");
      if (!(await page.locator(".ct-event-header button.ct-task-header-item.is-link:has-text('Rejoindre Teams')").count())) errors.push("no Join Teams in the event note's header");
      await page.locator(".ct-event-when").click();
      if (!(await page.evaluate(() => window.__revealed))) errors.push("a click on the time should show the event in the calendar");
    }
    if (name === "event-note-declined" || name === "event-note-deleted") {
      const header = (await page.locator(".ct-event-header").textContent()) ?? "";
      const says = name === "event-note-declined" ? "Refusée : masquée du calendrier" : "Événement supprimé du calendrier";
      if (!header.includes(says)) errors.push(`the header should say "${says}", says "${header}"`);
      if (await page.locator(".ct-task-header-tools .clickable-icon").count() !== 1) errors.push("only the properties button should be left: nothing to show in the calendar");
      await page.locator(".ct-event-when").click();
      if (await page.evaluate(() => window.__revealed)) errors.push("the time shouldn't open the calendar on an event not in it");
      const rsvp = page.locator(".ct-event-rsvp button.is-active");
      if (name === "event-note-declined" && (await rsvp.textContent()) !== "Refuser") errors.push("a declined invitation should keep its answer, to change it");
      const del = page.locator(".ct-event-delete-note");
      if (name === "event-note-declined" && (await del.count())) errors.push("a declined invitation's note isn't offered for deletion: its event is still there");
      if (name === "event-note-deleted") {
        if ((await del.textContent()) !== "Supprimer la note") errors.push("a deleted event's note should offer to delete it");
        await del.click();
        if (!(await page.evaluate(() => window.__deleted))) errors.push("the button should delete the note");
      }
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
    } else if (!["calendar-time", "calendar-new", "task-preview", "new-task-tags", "slot-picker", "date-picker", "new-event"].includes(name)) await page.screenshot({ path: file });
    console.log(`${errors.length ? "✗" : "✓"} ${name}-${theme}${errors.length ? `  ${errors.join(" | ")}` : ""}`);
    await page.close();
  }
}
await browser.close();
for (const other of scaled.values()) await other.close();
console.log(`Screenshots in ${out}`);
