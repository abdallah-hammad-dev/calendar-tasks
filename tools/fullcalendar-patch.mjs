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

/** A press held this long, in ms, is no click: what it selects shows. Longer than a slow click, short enough to wait for. */
const HOLD_MS = 300;

/**
 * Whether a selection of time is still only a press: a mouse, on the step it went down on, not held yet. Runs in
 * FullCalendar's module on its `DateSelecting`, given the hit under the pointer. A finger's long press stays drawn: it
 * says the press took. A day too: pressed or clicked, it's the same day.
 */
function stillPressed(selecting, hit) {
  return !selecting.held && !hit.dateSpan.allDay && !selecting.dragging.pointer.isTouchDragging && isHitsEqual(selecting.hitDragging.initialHit, hit);
}

/** From a press: once it has lasted `HOLD_MS`, what it selects is drawn. A new press takes over from the last one's wait. */
function holdPress(selecting) {
  selecting.held = false;
  clearTimeout(selecting.holdTimer);
  selecting.holdTimer = setTimeout(() => {
    selecting.held = true;
    if (selecting.dragSelection) selecting.component.context.dispatch({ type: "SELECT_DATES", selection: selecting.dragSelection });
  }, HOLD_MS);
}

/**
 * Up to here, in pixels, a drag is a shaky hand: it neither goes up nor turns back. Not more: at 12 a start moved up 10
 * minutes didn't count (2026-10-31).
 */
const TURN_PX = 6;
/** The event a new event's time is drawn as (`DRAFT_ID` in src/calendar/selection.ts). */
const DRAFT_ID = "ct-draft";
/** How close to the grid's edge, in pixels, a drag scrolls it. FullCalendar's 50 is an hour of a phone's day. */
const SCROLL_EDGE_PX = 24;

/**
 * The hits a selection of time runs between, given the one under the pointer. FullCalendar always runs it from the step
 * pressed, so a start dragged up came back down with the pointer (2026-10-31, the user: "on est bloque exactement la ou
 * on a clique niveau heure de debut"). Dragged up then back, the start stays as high as it went and the end follows the
 * pointer; until it's clearly on its way back, nothing moves. Runs in FullCalendar's module on its `DateSelecting`.
 */
function dragEnds(selecting, hit) {
  const start = (h) => h.dateSpan.range.start.getTime();
  const anchor = (selecting.anchor ??= selecting.hitDragging.initialHit);
  if (hit.dateSpan.allDay || Math.floor(start(hit) / 86400000) !== Math.floor(start(anchor) / 86400000)) {
    selecting.top = null;
    return [anchor, hit];
  }
  const y = selecting.hitDragging.pointerY;
  selecting.anchorY ??= y;
  selecting.topY = Math.min(selecting.topY ?? y, y);
  if (start(hit) < start(selecting.top ?? anchor)) selecting.top = hit;
  const { top, topY, anchorY } = selecting;
  if (!top || anchorY - topY < TURN_PX) return [anchor, hit];
  if (y - topY < TURN_PX) return [anchor, top];
  Object.assign(selecting, { anchor: top, anchorY: topY, top: null, topY: y });
  return [top, hit];
}

/** From a drag's start: what `dragEnds` remembers goes, and one of time keeps to the grid (`insideGrid`), scrolling past its edge too. */
function freshSelection(selecting) {
  Object.assign(selecting, { anchor: null, anchorY: null, top: null, topY: null });
  const timed = !selecting.hitDragging.initialHit.dateSpan.allDay;
  selecting.hitDragging.keepInGrid = timed;
  selecting.dragging.autoScroller.pastEdges = timed;
}

/**
 * Where a selection of time looks for its hit: past the top or bottom of the hours, at their edge. FullCalendar found
 * nothing there, and dropped hours selected 10px over the line (2026-10-31). Runs on its `HitDragging`, given `y`,
 * which it keeps for `dragEnds`: the pointer's own record isn't set yet on a drag's first step.
 */
function insideGrid(hitDragging, y) {
  hitDragging.pointerY = y;
  const grid = hitDragging.keepInGrid ? hitDragging.offsetTrackers[hitDragging.initialHit.componentId] : null;
  const box = grid?.scrollCaches[0]?.clientRect;
  if (!box) return y;
  const top = grid.computeTop();
  return Math.min(Math.max(y, box.top + 1, top), box.bottom - 1, top + grid.origRect.bottom - grid.origRect.top - 1);
}

/**
 * A second finger: a pinch, so the press under way is no long press, and a drag under way stops where it started, as
 * if nothing had been aimed at (`pinched`): a new event's time moves at the first touch, and a pinch over it moved it
 * (2026-10-31). Runs in FullCalendar's module on a `FeaturefulElementDragging`, given the press or the move that shows it.
 */
function secondFinger(dragging, ev) {
  if (!dragging.isInteracting || !(ev.origEvent.touches?.length > 1)) return false;
  if (dragging.isDragging) {
    dragging.pinched = true;
    dragging.emitter.trigger("dragmove", ev);
    dragging.pinched = false;
    dragging.setMirrorIsVisible(false);
    dragging.setMirrorNeedsRevert(false);
    dragging.onPointerUp(ev);
    return true;
  }
  clearTimeout(dragging.delayTimeoutId);
  dragging.delayTimeoutId = null;
  dragging.isInteracting = false;
  allowSelection(document.body);
  allowContextMenu(document.body);
  return true;
}

/**
 * A stretch past the event's other end stops at the last step before it: FullCalendar gave up there and the event went
 * back to what it was when pressed (2026-11-01, the user: "sa se resnap en 1h d'event"). `hit0`'s span is one step.
 * Runs in FullCalendar's module; returns where `hit1` stands for the stretch.
 */
function stopShort(hit0, hit1, isFromStart, range) {
  const { start, end } = hit0.dateSpan.range;
  const room = (end - start) * Math.floor((range.end - range.start - 1) / (end - start));
  const date1 = hit1.dateSpan.range.start;
  return new Date(isFromStart ? Math.min(date1, start.valueOf() + room) : Math.max(date1, start.valueOf() - room));
}

/** What's changed in FullCalendar: each line must be there once, or the build fails, so an update can't drop a fix silently. */
const PATCHES = [
  {
    // FullCalendar aims a dragged event from the middle of the slot row it was grabbed in ("useEventCenter"), but
    // reads the start under the pointer to 5 minutes (`snapDuration`): with 30-minute rows the event jumped up to
    // 15 minutes as soon as it moved, even sideways (2026-10-19). The drag follows the pointer instead.
    // And a click showed 5 minutes from the press, then its hour on release (2026-10-31, the user: "un peu beug"): a
    // selection isn't drawn until it leaves the step pressed or the press is held, while the release still reports
    // it, and `isClick` (src/calendar/selection.ts) tells which it was. Nothing at all while held wasn't better (asked
    // the same day: a long press showed nothing, and no way to book 5 minutes). `selectMinDistance` would leave a dead
    // click: a press moved 2px over a step is neither a selection nor a `dateClick`.
    // And each finger of a pinch starts its own wait for a long press, in the one variable, so the first was never
    // cleared: it ran out with no finger down, the drag "started" and never ended, and every press was ignored from then
    // on, the hours sliding under the finger (2026-10-31, on the user's iPhone). It takes free time under the fingers
    // and a pinch that scrolls nothing, as at the end of the zoom.
    module: /@fullcalendar[\\/]interaction[\\/]index\.c?js$/,
    // And selecting: see `dragEnds`, `insideGrid` and SCROLL_EDGE_PX (2026-10-31, the user: "ca s'arrete de monter a un
    // moment et ensuite sa glisse mais vers le haut": the grid scrolled an hour from its edge, the block held under the
    // pointer). `pastEdges`: the pointer past the grid, it goes on scrolling, for selections of time only (dragging an
    // event up to the all-day row would scroll the hours away).
    prepend: [`const HOLD_MS = ${HOLD_MS};`, `const TURN_PX = ${TURN_PX};`, stillPressed, holdPress, secondFinger, stopShort, dragEnds, freshSelection, insideGrid],
    replace: [
      ["hitDragging.useSubjectCenter = settings.useEventCenter;", "hitDragging.useSubjectCenter = false;"],
      // A finger moves and stretches what's being set at once, no long press: it's there for that.
      [
        "(ev.isTouch && eventInstanceId !== component.props.eventSelection) ?",
        `(ev.isTouch && eventInstanceId !== component.props.eventSelection && eventRange.def.publicId !== "${DRAFT_ID}") ?`,
      ],
      [
        "(ev.isTouch && this.component.props.eventSelection !== eventRange.instance.instanceId));",
        `(ev.isTouch && this.component.props.eventSelection !== eventRange.instance.instanceId && eventRange.def.publicId !== "${DRAFT_ID}"));`,
      ],
      [
        "let date1 = hit1.dateSpan.range.start;\n    let delta = diffDates(date0, date1, dateEnv, hit0.largeUnit);",
        "let date1 = stopShort(hit0, hit1, isFromStart, instanceRange);\n    if (date1.valueOf() === date0.valueOf()) return null;\n    let delta = diffDates(date0, date1, dateEnv, hit0.largeUnit);",
      ],
      // And at the first pixel: past that, the browser has started scrolling, and the drag is over.
      [
        "this.dragging.minDistance = component.context.options.eventDragMinDistance;",
        "this.dragging.minDistance = ev.isTouch ? 0 : component.context.options.eventDragMinDistance;",
      ],
      // (Nor selected: it would be drawn as a touched event, with dots for grips.)
      [
        "if (eventInstanceId !== this.component.props.eventSelection) {\n                    initialContext.dispatch({ type: 'SELECT_EVENT', eventInstanceId });",
        `if (eventInstanceId !== this.component.props.eventSelection && eventRange.def.publicId !== "${DRAFT_ID}") {\n                    initialContext.dispatch({ type: 'SELECT_EVENT', eventInstanceId });`,
      ],
      ["this.onPointerDown = (ev) => {\n            if (!this.isDragging) {", "this.onPointerDown = (ev) => {\n            if (!secondFinger(this, ev) && !this.isDragging) {"],
      ["this.onPointerMove = (ev) => {\n            if (this.isInteracting) {", "this.onPointerMove = (ev) => {\n            if (!secondFinger(this, ev) && this.isInteracting) {"],
      ["this.component.context.calendarApi.unselect(ev); // unselect previous selections", "this.component.context.calendarApi.unselect(ev); // unselect previous selections\n            holdPress(this);\n            freshSelection(this);"],
      ["dragSelection = joinHitsIntoSelection(initialHit, hit, context.pluginHooks.dateSelectionTransformers);", "dragSelection = joinHitsIntoSelection(...dragEnds(this, hit), context.pluginHooks.dateSelectionTransformers);"],
      ["let hit = this.queryHitForOffset(ev.pageX + this.coordAdjust.left, ev.pageY + this.coordAdjust.top);\n        if (forceHandle", "let hit = this.dragging.pinched ? null : this.queryHitForOffset(ev.pageX + this.coordAdjust.left, insideGrid(this, ev.pageY + this.coordAdjust.top));\n        if (forceHandle"],
      ["this.edgeThreshold = 50; // pixels", `this.edgeThreshold = ${SCROLL_EDGE_PX}; // pixels`],
      ["let topDist = top - rect.top;", "let topDist = this.pastEdges ? Math.max(0, top - rect.top) : top - rect.top;"],
      ["let bottomDist = rect.bottom - top;", "let bottomDist = this.pastEdges ? Math.max(0, rect.bottom - top) : rect.bottom - top;"],
      [
        "context.dispatch({ type: 'SELECT_DATES', selection: dragSelection });",
        "context.dispatch(stillPressed(this, hit) ? { type: 'UNSELECT_DATES' } : { type: 'SELECT_DATES', selection: dragSelection });",
      ],
    ],
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
