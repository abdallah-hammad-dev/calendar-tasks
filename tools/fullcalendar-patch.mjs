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

/**
 * Month: once a day has hidden something behind its "+N more", nothing after it shows there. Runs in FullCalendar's
 * module on a row's `DayGridSegHierarchy`. When `entry` reaches a closed day, its parts there are hidden and the
 * rest placed as usual (an event over several days still shows where there's room); returns whether it did.
 */
function hideInClosedDays(hierarchy, entry, hidden) {
  const closed = (day) => hierarchy.closedDays?.has(day) ?? false;
  const { start, end } = entry.span;
  if (!inClosedDays(hierarchy, entry)) return false;
  for (let from = start; from < end; ) {
    let to = from + 1;
    while (to < end && closed(to) === closed(from)) to += 1;
    const part = { ...entry, span: { start: from, end: to } };
    if (closed(from)) hidden.push(part);
    else hierarchy.insertEntry(part, hidden);
    from = to;
  }
  return true;
}

/** Whether `entry` reaches a day closed by `closeDays`. */
function inClosedDays(hierarchy, entry) {
  for (let day = entry.span.start; day < entry.span.end; day += 1) if (hierarchy.closedDays?.has(day)) return true;
  return false;
}

/**
 * The room a day's "+N more" link takes (FullCalendar's CSS: .85em, line-height 1, 2px padding, 1px margin), at
 * the font of a row's events. FullCalendar hid the line above whatever didn't fit to make room for the link, even
 * a line on two (2026-10-20: a day showed one thing, then "+4 more"); now only when the link wouldn't fit.
 */
function moreLinkRoom(eventsEl) {
  const style = (eventsEl.ownerDocument.defaultView ?? window).getComputedStyle(eventsEl);
  return Math.ceil((parseFloat(style.fontSize) || 13) * 0.85 + 5);
}

/** Closes the days of what was just hidden (see `hideInClosedDays`). */
function closeDays(hierarchy, hidden) {
  hierarchy.closedDays ??= new Set();
  for (const entry of hidden) for (let day = entry.span.start; day < entry.span.end; day += 1) hierarchy.closedDays.add(day);
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
  {
    // Month, with lines of two heights (2026-10-20: events on two, deadlines on one). FullCalendar hid the line
    // above whatever didn't fit, to make room for "+N more", even when there was room; and it kept that line's
    // place and went on: a deadline further down still fit, under an empty gap. Now the line above goes only if
    // the link doesn't fit (`moreLinkRoom`), and once a day shows "+N more", nothing after it shows there.
    module: /@fullcalendar[\\/]daygrid[\\/]internal\.c?js$/,
    prepend: ["const moreLink = { room: 20 };", moreLinkRoom, hideInClosedDays, inClosedDays, closeDays],
    replace: [
      ["        let fcContainerEl = this.fgElRefs.currentMap[firstKey];", "        let fcContainerEl = this.fgElRefs.currentMap[firstKey];\n        moreLink.room = moreLinkRoom(fcContainerEl);"],
      ["        if (this.hiddenConsumes && touchingEntry) {", "        if (this.hiddenConsumes && touchingEntry && this.maxCoord - insertion.levelCoord < moreLink.room) {"],
      [
        "    handleInvalidInsertion(insertion, entry, hiddenEntries) {\n        const { entriesByLevel, forceHidden } = this;",
        "    isInsertionValid(insertion, entry) {\n        return !inClosedDays(this, entry) && super.isInsertionValid(insertion, entry);\n    }\n    handleInvalidInsertion(insertion, entry, hiddenEntries) {\n        if (hideInClosedDays(this, entry, hiddenEntries)) return;\n        const hiddenBefore = hiddenEntries.length;\n        const { entriesByLevel, forceHidden } = this;",
      ],
      [
        "        super.handleInvalidInsertion(insertion, entry, hiddenEntries);\n    }\n}",
        "        super.handleInvalidInsertion(insertion, entry, hiddenEntries);\n        closeDays(this, hiddenEntries.slice(hiddenBefore));\n    }\n}",
      ],
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
          const prepend = [patch.prepend ?? []].flat().map((fn) => `${fn}\n`).join("");
          return { contents: `${prepend}${source}`, loader: "js" };
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
