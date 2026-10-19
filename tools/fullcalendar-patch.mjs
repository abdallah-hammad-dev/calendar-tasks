import { readFile } from "node:fs/promises";

/** In the week and day views, what starts this close below an event's top (in pixels) would cover its title and time. */
const HEADING_PX = 48;
/** The width an event behind others keeps beside them, against 1 for each one side by side (1 behind 1: a fifth). */
const BEHIND_WIDTH = 0.25;

/**
 * Marks each event in a day whose overlaps all start well below its top: it's drawn behind them (they leave its
 * title and time readable). Runs in FullCalendar's module, given its events' pixel spans (some may be missing).
 */
function markBehind(spans, headingPx) {
  for (const span of spans) {
    if (!span) continue;
    const later = spans.filter((s) => s && s !== span && s.start >= span.start && s.start < span.end && s.end > span.start);
    span.behind = later.length > 0 && later.every((s) => s.start - span.start >= headingPx);
  }
  return spans;
}

/** What's changed in FullCalendar: each line must be there once, or the build fails, so an update can't drop a fix silently. */
const PATCHES = [
  {
    // FullCalendar aims a dragged event from the middle of the slot row it was grabbed in ("useEventCenter"), but
    // reads the start under the pointer to 5 minutes (`snapDuration`): with 30-minute rows the event jumped up to
    // 15 minutes as soon as it moved, even sideways (2026-10-19). The drag follows the pointer instead.
    module: /@fullcalendar[\\/]interaction[\\/]index\.c?js$/,
    replace: [["hitDragging.useSubjectCenter = settings.useEventCenter;", "hitDragging.useSubjectCenter = false;"]],
  },
  {
    // What's at the same time, as in Google Calendar. FullCalendar drew the later one over the earlier from its
    // middle: a deadline at 14:05 covered the title of the event at 14:00, and two over a long event were squeezed
    // into thirds (2026-10-19). What starts together sits side by side; what starts well below an event sits over
    // its lower part, a little in from its left edge, the event drawn whole behind it. (Side by side always, as in
    // Apple Calendar, halved a 3-hour event for a deadline at its end.) Only with `slotEventOverlap`.
    module: /@fullcalendar[\\/]timegrid[\\/]internal\.c?js$/,
    prepend: markBehind,
    replace: [
      [
        "computeFgSegPlacements(segs, segVCoords, eventOrderStrict, eventMaxStack);",
        `computeFgSegPlacements(segs, this.context.options.slotEventOverlap ? markBehind(segVCoords, ${HEADING_PX}) : segVCoords, eventOrderStrict, eventMaxStack);`,
      ],
      ["thickness: 1,", `thickness: vcoords.behind ? ${BEHIND_WIDTH} : 1,`],
      ["let shouldOverlap = options.slotEventOverlap;", "let shouldOverlap = options.slotEventOverlap && Boolean(segHCoords.span.behind);"],
      ["farCoord = Math.min(1, nearCoord + (farCoord - nearCoord) * 2);", "farCoord = 1;"],
    ],
  },
];

/** esbuild plugin applying PATCHES to FullCalendar as it's bundled. */
export function fullcalendarPatch() {
  return {
    name: "fullcalendar-patches",
    setup(build) {
      const applied = new Set();
      build.onStart(() => applied.clear());
      for (const patch of PATCHES) {
        build.onLoad({ filter: patch.module }, async (args) => {
          let source = await readFile(args.path, "utf8");
          for (const [from, to] of patch.replace) {
            if (source.split(from).length !== 2) throw new Error(`FullCalendar changed: "${from}" isn't there once (tools/fullcalendar-patch.mjs)`);
            source = source.replace(from, to);
          }
          applied.add(patch);
          return { contents: `${patch.prepend ? `${patch.prepend}\n` : ""}${source}`, loader: "js" };
        });
      }
      build.onEnd((result) => {
        const missed = PATCHES.filter((p) => !applied.has(p));
        if (!result.errors.length && missed.length) {
          return { errors: missed.map((p) => ({ text: `FullCalendar wasn't bundled from the file patched for "${p.replace[0][0]}": the fix didn't apply (tools/fullcalendar-patch.mjs)` })) };
        }
      });
    },
  };
}
