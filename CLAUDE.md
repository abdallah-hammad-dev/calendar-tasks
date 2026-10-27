# calendar-tasks — notes for Claude

Obsidian extension: CalDAV calendar and tasks, a note per event and per task, a calendar view, a Bases task list,
and a module for claude-workspace. Founding spec: `docs/SPEC.md` (read it). Milestones: spec §10; stop and show the
user at each one.

## Commands
- `npm test` (Vitest) · `npm run lint` · `npm run typecheck` · `npm run build` (tsc + esbuild → `main.js`)
- `npm run check:mobile` — loads `main.js` the way Obsidian mobile does (no Node). Run after every build.
- `npm run test:integration` — the engine against the real local servers (Davis, and Radicale if running);
  creates and deletes a throwaway calendar. Run after touching `src/caldav/` or `src/sync/`. Not in CI.
- `npm run ui:preview [scenario…]` — renders the calendar (week, month), task links and settings with Obsidian's
  real app.css in headless Chromium → `tools/preview/out/*.png`, light + dark. **Look at them after any UI
  change.** Scenarios in `tools/preview/harness.ts`; browser stand-in for `obsidian` in
  `tools/preview/obsidian-browser.ts` (copied from claude-workspace, plus `getLanguage`, global `createEl`…).
- `npm run deploy` — build + copy into `./test-vault`; `TEST_VAULT=/mnt/c/Users/abdal/Documents/ct-test-vault`
  for a vault Windows Obsidian can open. Refuses non-empty folders without the `.calendar-tasks-test-vault` marker.
- Release: `npm version patch|minor|major` then `git push --follow-tags` (`docs/releasing.md`). Never hand-edit the
  manifest version or hand-create tags.

## Test servers (`~/organisation/calendar-backend/`, private repo; see `bench/TESTS.md`)
- After a reboot: `~/organisation/calendar-backend/start.sh` starts both servers.
- **Davis** (the chosen server): `davis/run.sh` (rootless Podman), `http://127.0.0.1:9000/dav/`, users `abd` /
  `orga`, password `x`; iPhone over Tailscale Serve on port 8443 (URL in `bench/TESTS.md`).
- `bench/push-fixtures.sh` / `bench/check.sh` push and read test items over HTTP. Radicale (`radicale/`) is kept
  only as a reference.

## Hard rules
- Never write to the user's real vault (`C:\Users\abdal\Documents\aaa`). Only `test-vault/` or a marked test vault.
- **No Node APIs in `src/`**: the extension runs on Obsidian mobile. HTTP only through `requestUrl`. ESLint blocks
  Node imports; `check:mobile` checks the bundle. (The Claude module, M7, is desktop-only but needs no Node either.)
- **Pure CalDAV client: never call the Go backend.** Everything from the backend arrives as CalDAV data.
- Secrets never in `data.json` (it syncs with the vault): the CalDAV password goes in `app.secretStorage`.
- Never log passwords, note contents or calendar contents.
- Edit CalDAV items in place, never regenerate them (keep `VALARM`, `X-APPLE-*`, unknown properties). Times are
  written with `TZID` + `VTIMEZONE`, never UTC (spec §6.2).
- Property names live in `src/constants.ts` and are not settings (spec §2.5).

## Layout
- `src/main.ts` — plugin entry: settings, the `SyncEngine` (rebuilt when connection settings change), commands
  (Sync now, Rebuild cache), auto-sync (startup, interval, window focus with a 30 s gap).
- `src/settings.ts` — persisted shape, defaults, `mergeSettings` (pure, tested), declarative settings tab (1.13+:
  `getSettingDefinitions`, values go through `mergeSettings` in `setControlValue`).
- `src/caldav/` — `transport.ts` (`requestUrl` wrapper, Basic auth), `xml.ts` (namespace-aware multistatus parsing
  over any DOM), `client.ts` (`CalDavClient`: discovery, calendars, sync-collection, multiget, conditional
  PUT/DELETE; `CalDavApi` is what the engine depends on), `ical.ts` (UID/kind via ical.js).
- `src/sync/` — `store.ts` (cache snapshot + pending queue; `IdbStore` in IndexedDB, `MemoryStore` for tests),
  `engine.ts` (`SyncEngine`: push queue with `If-Match`, then pull with sync tokens / ctag / etag listing).
- `src/tasks/` — `vtodo.ts` (read/write the owned VTODO fields in place with ical.js, `taskLink`), `notes.ts`
  (frontmatter ↔ state, titles), `tags.ts` (tag rule, `#tags` in a line, tags ↔ categories, `withTags`), `TaskSync.ts` (notes ↔ VTODOs; depends on `VaultPort`, not on Obsidian),
  `obsidian-vault.ts` (`VaultPort` on documented APIs: `processFrontMatter`, `fileManager.renameFile`…),
  `base-file.ts` (the `Tasks.base` YAML).
- `src/editor/` — `date-token.ts` (day words: `15/10`, `demain`, `lun`…), `when.ts` (the `@` grammar: one
  keyword + value per `@`, deadline / time block / repeat; suggestions; RRULE helpers),
  `convert.ts` (pure: task line → planned task: `@` words and `#tags` cut from the title), `converter.ts` (creates the task note,
  returns `- [[Task]]`), `chips.ts`
  (pure chip model: due label/overdue, tags, progress, sync state), `render.ts` (DOM), `live-preview.ts`
  (CM6 ViewPlugin decorations + "cursor left a line" listener, also on a blur inside Obsidian;
  `refreshTaskDecorations()`), `left-lines.ts` (pure: which task lines an update left, pasted lines included;
  `cursorTaskLine` for a blur), `fields-state.ts` (pure CM state of the fields: the open field, blocks,
  Backspace / Delete, padding, a chip's field `chipFieldText` / `openChipField`), `fields-view.ts` (draws them:
  label and block widgets, atomic ranges, the keymap), `date-suggest.ts` (the `@` assistant, an
  `EditorSuggest` on `suggestAt`; also after the link of a converted line, to change that task; its rows, like
  `RepeatPickerModal`'s, are `.ct-date-suggestion`: a subgrid of the list, `:has()` making Obsidian's `.suggestion`
  / `.prompt-results` two columns, so labels and readings line up; an `AtItem.hint` is drawn "ex. …"),
  `date-picker.ts` (month-view date picker modal, replaces the system one), `reading-view.ts` (post-processor).
  `src/tasks/task-index.ts` — every task note's state, read by the decorations. `src/tasks/modals.ts` — the task
  form (`TaskModal`: new, or `edit` from a chip click) and the day / slot pickers (`dayChoices` / `parseDate` in
  `when.ts`).
- `src/calendar/` — `expand.ts` (pure: items → occurrences in a range; recurrences, exceptions, deadlines,
  time blocks, invitations; `findOccurrence` by RECURRENCE-ID; `pickOccurrence`), `event-notes.ts` (one note per
  occurrence, follows moves/renames one way), `catalog.ts` (uid → item), `CalendarView.ts` (FullCalendar v6 for
  layout and dragging; our toolbar, `eventContent`, `dayHeaderContent` and popovers; drag/resize/select/right-click
  go to the host), `event-card.ts` (an event's card: popover or phone modal), `vevent.ts` (VEVENT edits in
  place: new event, `editEvent` (what the form changed; move / rename go through it) on an occurrence as an
  exception, EXDATE, `setPartstat`, `isMirror`, `endSeries`), `modals.ts` (`renderEventForm` / `EventModal`: the
  event form, new or edit; `ConfirmModal`), `calendars.ts` (the colors offered).
- `src/ical/write.ts` (`setDateProp`, `ensureVTimezone`, `touch`) and `src/ical/zones.ts` (`registerZones`, `ridOf`),
  shared by tasks and events.
- `src/ical/time.ts` — zones through Intl (no tz database): wall clock ↔ instant, local value strings,
  generated `VTIMEZONE` (nth/last-weekday rules).
- `src/i18n.ts` — every UI string, English + French, `t(key)` follows Obsidian's language.
- `src/constants.ts` — frontmatter property names, note types, protocol action, the backend's properties
  (`BACKEND_PROP`: the whole contract with it, spec §4.7).
- `test/stubs/obsidian.ts` — runtime stub aliased as `obsidian` in Vitest (copied from claude-workspace).
- `test/support/` — `FakeServer` (in-memory CalDAV with tokens/etags/preconditions), xmldom parser, fetch
  transport. `test/fixtures/` — real Davis and Radicale responses.

## Decisions
- **Cache in IndexedDB, per device** (`calendar-tasks/<vault name>`), never in the vault: sync tokens describe one
  client's state, so a synced cache file would mix devices. Holds calendars, items (raw iCalendar + etag) and the
  queue of unpushed changes.
- **Changes and refused pushes are reported once every calendar is read** (refused pushes first), not calendar by
  calendar (2026-10-17): a reminder moved to another list (same UID, new URL — the phone does it, and so did the
  migration to our own "Tâches" list) was told as "deleted" before its new place was read, so TaskSync marked the
  note done and unlinked it, then made a duplicate. Now `TaskSync` looks the UID up in every list (`findItem`)
  before calling anything deleted, both for a removal and for a push refused because the item left.
- **Engine events are for server-side changes only.** `putItem`/`deleteItem` update the cache optimistically and
  don't emit `onChange` (so note ↔ CalDAV updates can't loop). A refused push (412) emits `onConflict`, and the
  cache keeps the server's version; merging is the caller's job (M2).
- **Edit-during-push**: a newer queued op for the same URL gets the fresh etag as its base, so it doesn't conflict.
- **sabre/dav (Davis) quirk**: an unknown sync token with sabre's own prefix gets "no changes" + the same token back
  instead of a 403. The engine treats "token echoed while the server's current token differs" as invalid and does
  a full resync (unit + integration tested).
- Davis/sabre returns `ETag` on PUT when it stored what we sent; without one, the engine reads the item back.
  **Reading one item back is a multiget on its collection, never a GET** (`CalDavClient.get`, 2026-10-22): Davis's
  Caddy compresses answers over 512 bytes for clients that ask (Node's fetch does; Obsidian's Electron and iOS
  stacks very likely too, not checked) and then appends `-gzip` to the `ETag` header, which If-Match refuses (412).
  ETags in multistatus bodies are untouched. The integration test "even over 512 bytes" fails with a GET.
- **Task sync rules** (TaskSync): tasks already completed when first seen get no note; a VTODO deleted on the
  server leaves its note `done: true` without `caldav_uid`; a whole calendar vanishing leaves notes alone; deleting
  a task note deletes its VTODO; a refused push is merged field by field against `baseData` (server wins where
  both sides changed a field, with a notice). Every write is equality-checked, so echoes are no-ops.
- **Startup order**: load cache → push local note edits (made while closed) → sync → pull every VTODO into notes →
  write `Tasks.base` once (`taskBaseCreated` flag, never recreated). The settings' *Regenerate the task list*
  (`main.regenerateTaskBase`, 2026-10-21) rewrites it with the default views after a `ConfirmModal`, so new
  default views (e.g. *No deadline*) reach an existing file.
- **`created`** (2026-10-21, the user: find the small undated tasks jotted down today): the reminder's `CREATED` as
  a local date-time, written only into a note that has none (an unreadable value is left alone), never pushed; a
  note made here gives its reminder `CREATED` (its own `created` if it has one). Bench fixtures and integration
  items have no `CREATED`, so no `created`. The task header shows it faint before the tools (`createdLabel` in
  chips.ts); `.ct-task-header-created` has `flex-basis: 0`, one line of height and `overflow: hidden`, with an empty
  `::before` as first flex item, so a date with no room wraps under it out of sight instead of wrapping the bar.
- **Before every sync, note edits still in their 800 ms debounce are queued** (`flushNoteChanges`): the engine never
  pulls over a queued change, and a refused push is merged. Without this, ticking a task right before a sync that
  brings a phone edit of the same reminder lost the tick.
- **Connection settings restart the engine 1.5 s after typing stops** (`scheduleRestart`), not on every keystroke
  (a half-typed URL is another account: empty cache, lost pending ops).
- **An empty full listing for a calendar we hold items for is believed only on the second sync in a row**
  (`emptySeen`): otherwise one bad server answer marks every task note done and unlinked.
- **Known limitation**: a brand-new task note reaching a second device through vault sync before its `caldav_uid` was
  written can get a second VTODO there (documented in the README; not handled).
- **When a task was ticked** (2026-10-25, asked: the last time it was ticked, right after an untick and a tick; for a
  repeating one, the list, not a count): `completed` ↔ `COMPLETED` (`TaskFields.completed`, local minute; the VTODO
  gets the note's time in UTC), only while done. Ticks here go through `setDone` (notes.ts: `done` and `completed`
  in one write); a `done` changed elsewhere (Bases, the properties) gets it in `TaskSync.pushNote`: now if the
  reminder isn't done yet, else the reminder's time, and never a guess (`pushAll` passes every note at startup:
  an old done note must not read "done today"). Repeating tasks: `moveOn(…, at)` appends to `completions` (note
  only; `at` = the phone's `COMPLETED` when it ticked there). `applyItem` skips `ensureLink` after moving on: it
  put back the ticked copy it was given (only when our link was missing), and the next pull moved on a second time.
  The header shows "Faite hier" by the checkbox; a repeating task's days done go faint in `.ct-task-header-faint`
  (with the creation date after them, so the days win the room), each day its own flex item that wraps out of sight
  when it doesn't fit, taking its "·" along; a click lists every time (`task-note-done`, `task-note-repeat`,
  `task-note-repeat-narrow` previews). One tick was counted twice in the test vault: a second `pushNote` read the note
  before Obsidian re-parsed `moveOn`'s write; `moveOn` now sees the note already back at that date and counts nothing
  (`FakeVault.lag` / `catchUp` reproduce the re-parse delay).
- **One task date, the deadline** (bench test 6): `due` ↔ `DUE` (Reminders shows only `DUE`; a `DTSTART`-only
  reminder shows no date). Work time is time blocks (events). A note-only "planned day" (`scheduled`) existed
  2026-10-15→16 and was removed at the user's request: it doubled the time blocks.
- **One trigger, `@`, one thing per `@`** (`src/editor/when.ts`). History: `>date`, then a free-form phrase
  after a single `@` ("@ven prévu mar chaque semaine"); the user found both confusing (2026-10-16) and asked for
  separate features. Now each `@` = keyword + value (`parseToken`): `@deadline`, `@session`, `@répéter`,
  `@tâche`; shortcuts `@demain` (deadline) and `@chaque lundi` (repeat). `findWhen`
  combines every `@` of the line. `suggestAt` drives the assistant: features first, then values it keeps only if
  the parser accepts them.
- **Changing a task already made** (asked 2026-10-17: "réediter en remettant arobase ou cliquant"): `@` after the
  link of a `- [[Task]]` line (`parseLinkLine` / `linkLineEdit`) uses the same grammar; `taskEdit` turns it into
  field changes (a repetition alone keeps the deadline, `startOn` moves it to the rule's day; `@deadline jamais` /
  `@répéter jamais` set `When.clear`). Applied on ✓ or when the line is left (`left-lines.ts` watches such lines).
  `@tag x` or `#x` adds a tag (`TaskEdit.tags` and `linkLineEdit`'s `tags`, merged in `main.applyEdit` with
  `withTags`). **A blur leaves the line too** (2026-10-26, the user: "fix the weakness"; a click elsewhere left a
  `#tag` on the line, tagging the note): `focusStayedInObsidian` in live-preview.ts, on CodeMirror's
  `focusChanged` (reported 10 ms after the blur, so the focus is already where it went). Not when the whole window
  lost focus (`document.hasFocus()`: alt-tab mid-line), nor into a `.modal-container` or `.menu` (the `@`
  assistant's date picker is a modal, and the cursor comes back after). Clicking a chip opens `TaskModal` in edit
  mode at that field (now only the priority, the pencil, Reading view, and values the `@` can't say; see Fields).
- **Fields and blocks** (2026-10-26, the user rejected Obsidian's tag menu for a tag chip, "pas vrm effaçable", and
  asked for fields visible on the line that turn into blocks, erasable and editable; then approved: Backspace
  twice, our own tag list): the file keeps the `@` grammar (`lineTokens` in when.ts); `fields-state.ts` holds the
  open field (`openField`: opened by typing in an `@`, a cursor right after one, or `openFieldEffect`; closed once
  the selection leaves its extent, which runs while `suggestAt` reads up to the cursor), `fields-view.ts` draws it
  (`.ct-field` mark, the keyword replaced by a label widget) and every other complete `@` as an atomic block widget
  with the chips' classes. Text stays `@tag` (not `#`): our `EditorSuggest` comes after Obsidian's built-ins, so a
  typed `#` always opens Obsidian's tag menu. A chip click (`main.editChip`) writes `@word ` at the line end with
  `replaces` and `was` (the chip isn't drawn meanwhile, `ChipMarks`; `was` shows faint, `PlaceholderWidget`) and
  asks `DateSuggest.show` for the list (Obsidian's `EditorSuggest.trigger` gives up on a selection, so the value
  isn't selected any more, 2026-10-27), only if the value reads back the same (`chipFieldText`: deadline,
  repetition, priority, a tag), else the form. A single-valued field typed after a task's link that has that value
  gets the same `replaces` / `was` itself (`openField`, `auto`, through `FieldConfig.chipValue`). On a link line a
  pick that leaves only ✓ and "something else" to offer finishes the edit (`DateSuggest.carryOn`). Obsidian's list
  takes Escape before the editor, so `DateSuggest.onEscapeKey` (not in the API) closes the field too; a list opened
  by code (`reopen`) is made the workspace's current one (`editorSuggest.setCurrentSuggest`), else Obsidian never
  closes it when the `@` goes. `applyEdit`
  patches the index before writing (`writeShown` → `TaskIndex.patch`) so chips don't show the old value meanwhile.
  The `.ct-field` mark stops at its value, not the space after it. A field closing on a link line, cursor still there, goes to the task at once
  (`TaskLinkDeps.fieldClosed` → `main.applyField`: only when all its `@` are complete, `#tags` wait for the line);
  a line left goes through `lineLeft` with `replaces` (a tag edited is swapped in `applyEdit`; `DateSuggest`
  reads `replaces` from `editor.cm`). Backspace after the link selects the last chip (`chipSelection`) and the
  second calls `removeChip`. A chip's field deleted by the user (`erased` in live-preview.ts; not the assistant
  cutting it once applied) calls `removeChip` too (2026-10-27, the user: the deadline "impossible à supprimer");
  left with its keyword alone or half typed, `applyField` cuts it and the chip stays. **A task's line ends with a space** (`linkLine`
  in convert.ts: conversion, `linkLineEdit`, `applyField`), which the chips widget replaces (2026-10-27, the user:
  the cursor showed after the title, then jumped; deleting a chip left "un saut de plusieurs espaces"): the line's
  end is then a place after the chips, not against the link, where Obsidian shows the link's brackets for a focused
  cursor and shifts everything. Elsewhere (no space, a link in prose) the chips are a point widget with `side: -1`.
  An old `- [[Task]]` line gets its space on a click past its chips (`clickPastChips`, not in the undo history).
  Chip-Backspace works only with the cursor at the line's end. A chip taken off is hidden at once (`removedChips`,
  cleared by `refreshTaskDecorations`). The cursor's place among the chips is `chipGap` (2026-10-27, asked): the
  real cursor stays at the line's end and the chips are split around it (`ChipMarks.part`: a gap index over those
  drawn, `around` cursor or field), ← → / Backspace / Delete in `moveAmongChips` / `chipKey`; a press in the gap
  reaches the editor because `ChipsWidget.ignoreEvent` lets it (`clickBetweenChips`). Chips standing for the line's space
  (`ChipMarks.spaced`, `.is-spaced`) end with half a gap, so the cursor after them isn't against the last one (the
  user read it as a cursor twice as thick, 2026-10-27); it's padding, as are the halves around a gap: Chrome draws
  the cursor at the end of the box before it, its margin left out (`task-fields` finds the cursor in the pixels). A field opened from a chip
  splits them the same way, those before it after the link, the rest after the field's extent. A field that stood
  for a value (`was`: a chip's or a block's; any field after a task's link) closing without a new one is undone in
  the same transaction (`restoreField`, a transaction filter): a chip's text goes, a block's value comes back. A
  block click opens like a chip's (`openBlockField`, `FieldViewDeps.openList`). The pencil is out of the flow (absolute, hidden on
  the active line), so it leaves no gap. The `task-fields`
  preview has CodeMirror's `defaultKeymap` (`@codemirror/commands`, dev only: Obsidian has its own), without which
  Backspace was the browser's and didn't cross the label widget. `EditorView.findFromDOM` wants the `.cm-editor` element, not one inside it. The
  `task-fields` preview runs our extension in a real CodeMirror (`editorInfoField` stub) and types through it.
- **No system dropdowns in forms** (the user found the blue Windows list ugly, 2026-10-17): `src/ui/menu-select.ts`
  opens Obsidian's `Menu` from a button; `named()` puts an icon before a setting's name. The settings tab keeps
  Obsidian's standard dropdowns (that's what every settings page uses).
- **Two kinds of redraw** (`main.scheduleRedraw(data)`): a note change redraws decorations, task headers and the
  calendar's task lists only (`CalendarView.refreshTasks`); a change of calendar data (a sync that moved something,
  every TaskSync write — it always calls `requestSync`) also re-reads the calendar's events. Re-reading events on a
  note change showed the reminder's old state (a dragged deadline jumped back until its push). A 5-minute tick and
  midnight keep "today" and missed deadlines true.
- **Calendar skin is ours** (2026-10-17): `headerToolbar: false`, events drawn by `eventContent` with the calendar
  color in `--ct-ev-color` (set in `eventDidMount`; a missed deadline keeps it, only its checkbox and time turn red);
  FullCalendar's own colors are transparent. Buttons need a selector stronger than Obsidian's
  `button:not(.clickable-icon)` (0,1,1) to lose its background and shadow.
- **Event shapes say what they are** (2026-10-17, see spec §7.1): event = filled block, task things carry a
  checkbox (`CalendarView.checkbox`, ticks the task in place), session = an event's block with its bar dashed (a background
  under a transparent border, so it lays out as an event), deadline = outlined one-line
  marker (radius as events) with "⚑ time" (a line across the day through it was tried 2026-10-19: the user found
  it ugly). Close deadlines (< 20 min, same day) become one "N tâches" marker in week/day views only
  (`closeDeadlines` in `expand.ts`; `grouped` + a refetch in `datesSet`, since agenda ↔ week keeps the same dates).
  The agenda (2026-10-20, spec §7.1) draws the month's mark (`ct-ev-bar`, `.is-dashed` for sessions, or the checkbox; its height
  is the text's, or the month's lines grow and hide some) inside our content (`.ct-ev-mark`; FullCalendar's
  `.fc-list-event-graphic` dot column is hidden, so titles line up), a deadline's time cell is rewritten in
  `eventDidMount` (flag + time or "Journée"), day headings are `agendaDay` (`dayHeaderContent`, which replaces
  FullCalendar's nav link: its own click opens the day), ranges use `defaultRangeSeparator: " – "`. The key's
  swatches follow the view (`.ct-key.is-lines` outside the week and day; `datesSet` redraws the legend). The
  `calendar-list` previews set the browser clock (`page.clock`) to Thursday 15 at 11:00 for Today / past.
  The checkbox stops `mousedown`/`touchstart`/`pointerdown` (no drag) and prevents mousedown's default: focusing
  the event lays FullCalendar's `.fc-event:focus::before` overlay over it and the release opened the card.
  Snap 5 min (`SNAP_MS`); a click selects one snap, so `select` turns it into an hour from the half hour.
  A press beside the events while a `.menu` is open stops at the grid (capture: pointerdown, mousedown,
  touchstart; 2026-10-25, it started a new event): FullCalendar never sees it (no selection, no unselect of an open
  form), and Obsidian's Menu, which listens on the window, closes on the `click` that follows. `calendar-interact`
  checks both (the harness's `menu` opens a stand-in Menu, which closes as Obsidian's does).
  Times to the minute: `when-fields.ts` (`datetime-local` / `date` inputs, which Obsidian styles; they follow the
  OS language, so the preview launches Chromium in French). The new event form's `preview` moves the selection
  with `calendar.select`, guarded by `reselecting` so `select` doesn't reopen the form. Zoom: `--ct-slot-h` on the
  view + `slotOptions(zoom)`; FullCalendar measures its slats only when it renders and `updateSize()` doesn't
  render, so `setZoom` sets a new `slotLabelClassNames` function to force one. Wheel steps are capped (±20 px of
  `deltaY`): Chromium reports CSS pixels, so a notch is worth less on a dense screen, and a pinch sends small ones.
  `eventContent` reads times from `arg.event` (not the occurrence) so a dragged mirror shows where it lands.
  The deadline marker's time hides through a container query, scoped to `.fc-timegrid-event` (month lines are as
  wide as their text: a size container collapsed them).
  What an event shows follows its box's real height, not its length (2026-10-18: a 30-minute session zoomed in a
  little had its time line cut; FullCalendar's `fc-timegrid-event-short` only starts under 30px, two lines need
  ~2.9em): `.fc-event-main` is a size container; under 2.9em start – end go on the title's line (2026-10-23, the
  user: a thin session showed its start alone), the start alone under 12em wide (a week column in a small window),
  and the title is clamped to the lines left (bands of 1.25em). `calendar-week` checks "Appel Paul" (15 minutes) in
  the week, then in its day. `ui:preview` fails on any event whose box or line is cut
  (`clipped`, each line too: a line with `overflow: hidden` shrinks instead of overflowing the box).
- **Whole device pixels** (2026-10-20, the user on Windows at 125 %: dots and bars "pas uniformes"): 2px is 2.5
  device pixels there, and Chrome lays out in device pixels, so each dot or bar edge snapped to 2 or 3 depending on
  where it fell. `wholeDevicePixels` (`src/calendar/device-pixels.ts`, from `main.onload` and on each `window-open`)
  sets `--ct-2px` / `--ct-3px` on the body: 2 and 3 CSS px rounded down to whole device pixels, followed through a
  `resolution` media query (scaling, Obsidian's zoom). Every bar, dot, dash and key swatch is sized from them
  (`var(--ct-2px, 2px)` …), whole multiples only. Checked from the pixels by the `calendar-marks-*` previews
  (month, week, agenda at 1.25 and 1.5: same width per kind, same dots, a session's dashes alike, the key too).
  Those run in a browser started with `--force-device-scale-factor` (only the size emulated): Playwright's
  `deviceScaleFactor` lays out in CSS pixels and scales the paint, which blurred what Windows draws sharp and passed
  dashes Windows drew unequal.
- **Calendars row** (2026-10-18): every collection looks the same (dot, name, Show/Hide), in the server's order.
  A list icon and per-kind tooltips for task lists were tried and removed: the user read them as hardcoded
  special cases ("c des collections ? pk ils ont des logos différents ?"); what a collection holds, and the
  "changed on the server" note, were dropped from its card too ("textes un peu bêtes"), as was the shape key's
  tooltip. Create / delete (2026-10-18): `SyncEngine.createCalendar` / `deleteCalendar`, on the server first, after
  any sync under way (`idle`). A delete reports its items removed *without* `calendarRemoved` (that flag means a
  calendar vanished, maybe for a moment, and leaves notes alone): on purpose, so TaskSync treats each like a
  deleted reminder. Names are shown as the server has them. A plugin-side "Rappels" for iOS's
  `DEFAULT_TASK_CALENDAR_NAME` list was tried and removed: the user wants a plain CalDAV account that Apple reads,
  nothing specific to one client (rename the collection on the server instead). Name and color edits go through `SyncEngine.updateCalendar` → `CalDavClient.updateCalendar`
  (PROPPATCH, not queued: needs the network; one refused property = error). The calendar card is a third popover
  kind, `"calendar"`, which `refresh()` doesn't close (each edit refreshes the view).
- **FullCalendar mirror events** (the selection while clicking or dragging an empty slot, a task dragged from the
  panel) go through `eventDidMount` without our `extendedProps.occ`: a throw there broke the whole view (it froze
  with the mirror stuck, 2026-10-17). `npm run ui:preview -- calendar-interact` replays a drag and a click with a
  real mouse and fails on any page error.
- **Accent colors**: Obsidian has no `--color-accent-rgb`; use `hsla(var(--accent-h), var(--accent-s),
  var(--accent-l), α)` (`--color-red-rgb` and friends do exist).
- **Task note header** (`src/editor/task-header.ts`, `main.updateTaskHeaders`): prepended to the MarkdownView's
  `contentEl` (above both the source and reading views, outside their scrollers, so it never scrolls and survives
  mode switches and re-renders); `.ct-task-view` makes `.view-content` a flex column. Properties are hidden with
  `--metadata-display-editing/reading: none` on that element (setting `showTaskProperties` turns it off).
- **Two kinds of repetition**: a repeating task (`@répéter`, RRULE on the VTODO, the deadline comes back when
  ticked) and a session that comes back (`@session chaque mardi 14h-16h`, RRULE on the VEVENT, `Block.repeat`).
  A task done for good ends its recurring sessions (`endSeries`: UNTIL = now; deleted if not started), hooked on
  the done transition in `metadataCache.on("changed")`.
- **Collections are contexts, each holding events and tasks** (2026-10-18; the user never wanted a list for tasks
  and a calendar for events): one setting, `defaultCalendar` (migrated from `taskCalendar` / `eventCalendar`),
  and a `collection` property in task notes (by name). `TaskSync.calendarFor`: note's → parent's → default → first by
  name (tags never pick one). Moving = `putItem` in the new collection + `deleteItem` of the old
  (two queued ops, in that order). `TaskSync.known` (uid → the collection the note was last in step with) tells a
  user's change (note names another one: move) from a note that's behind (the phone moved it: the note follows);
  without it, a tick queued while the phone moved the reminder sent it back. A rename anywhere →
  `refreshSettingsIfCalendarsChanged` → `pullAll` renames it in the notes.
- **Task panel, not "To plan"** (2026-10-18): every open task with its number of time blocks (`tasksToPlan`),
  "No time block" filter (`planUnplannedOnly`). The `@` menu's entry for the task alone reads "Créer la tâche", no
  hint (2026-10-25; "la suivre dans tes tâches" read oddly; "Transformer en tâche · sans date pour l'instant" made it sound like a lesser
  task, the user: tracking it is the point). Its keyword is `@tâche` / `@task` (`TASK_WORDS`), which replaced
  `@sans date` (asked the same day); taking the deadline off a task already made is `@deadline jamais`, like
  `@répéter jamais`.
- **Day preview in the task form** (`src/calendar/day-preview.ts`, 2026-10-18): a second FullCalendar
  (`timeGridDay`) wrapped in `.ct-calendar` so the calendar's event styles apply; `TaskModal` feeds it what's being
  placed (`refreshPreview(focus)`: `due`, `block:<i>`, `typed`). A drag adds a row to the slot list
  (`addBlock`); moves go back into the list or the fields (`setDue` / `setTyped`: day, time(s), then an `input`
  event), so hints and validation stay the fields' own.
  `ui:preview -- task-preview` drags a slot on it.
- **Event notes** (2026-10-19): named with the day as set (`eventDateFormat`, default `DD-MM-YYYY`; `noteDate`,
  `eventNoteNames` in event-notes.ts: the time is added when another event of that day has the same title);
  `EventNotes.update` renames them when the setting changes (`main.namedWith`). Their header
  (`editor/event-header.ts`) uses the task header's classes; `updateNoteHeaders` draws either; a click on the time
  calls `CalendarView.reveal(occId, start)` (events carry `data-occ`; `ct-ev-reveal` blinks).
- **Priority** (2026-10-19, the user: none or three levels, "haute moyenne basse"): `priority: high | medium |
  low` in the note (`PRIORITIES`, `PRIORITY_MARK` in constants.ts; `priorityOf` also reads the French words) ↔
  `PRIORITY` 1 / 5 / 9 (read 1–4 / 5 / 6–9), an owned field like `repeat` (an unknown value is left alone on the
  server). Drawn !!! / !! / ! in red / orange / blue on links, the note header, the Tasks panel (same deadline: the
  most urgent first); a row in the form; Claude's create / set-dates tools take it; `@priorité haute` /
  `@priority low` in the `@` grammar (2026-10-27, asked: missing from the assistant; `aucune` / `none` takes it off;
  `When.priority`, `Cleared` "priority", `TaskEdit.priority`, `PlannedTask.priority`), so its chip edits inline. Not on calendar deadlines yet.
- **Compact forms** (2026-10-19): the new event form and an event's times are one `.ct-form-grid` (`formRow` in
  `src/ui/form-row.ts`: icon, name, field); `renderWhenFields` writes day + time fields (`readFields`) into it, not
  `datetime-local`. Inputs that show their name carry no `aria-label`: Obsidian shows it as a tooltip on hover.
- **Editing from the calendar** (2026-10-23, the user: reopen an event to edit it precisely, and the task's edit
  button on deadlines and sessions): the card's pencil (`EventCardInfo.edit`, `CalendarView.editKind`) opens the
  form of what the card shows: the task's for a deadline whose task has a note (`host.editTask`), else the event
  form filled in, a work session's too (`host.editEvent` → `main.editEventOptions`, popover kind `"edit"` at the
  event, `editing` keeps it marked); a work session's task line (`is-editable`, like the time line) opens the
  task's form. **No "…" on the card** (2026-10-24, the user: it repeated the card "sauf 1"): each action is on it
  once, so a trash (`EventCardInfo.remove`; `deleteMenu` under it confirms, a series offers one occurrence or all,
  `host.remove` → `main.removeOccurrence`, shared with the right-click menu) and, on a deadline, "Plan a session"
  (`host.pickSlotFor`). The right-click menu (`host.menu`) keeps everything as the shortcut.
  The menu has "Edit…" / "Edit the session…" (it replaced "Rename…" and `TextModal`) and "Edit the task…" on
  sessions too. `saveEventForm` writes only the fields that changed (a place that was only a meeting link shows
  empty and stays unless something is typed); a series' occurrence has no Collection row (`edit.series`). The
  `calendar-card` preview edits "Café avec Léa" and checks the task pencils.
- **Event cards stay open across a refresh** (2026-10-19): `CalendarView.card` (popover or phone modal) is drawn again
  by `refresh()` from the occurrence found by id (`redrawCard`; closed if gone, left alone while `.ct-card-when` is
  being typed); the event is marked active again in `eventDidMount`. Needed so the RSVP line (`answerStatus`: host
  `syncState` = queued / offline from `syncFailed` / synced, then `X-CALTASKS-RSVP-STATE`) shows after a click.
  `syncNow` also redraws when the sync starts or stops failing with changes queued. `setPartstat` drops
  `X-CALTASKS-RSVP-STATE` when the answer changes. Event notes are lazy: the card and menu say "Create the note" until
  one exists (`openLabel`, host `hasNote`).
- **Dragging in the calendar** (2026-10-19): FullCalendar aims a dragged event from the middle of the slot row
  it was grabbed in (`useEventCenter`), but reads the start under the pointer to `snapDuration` (5 min): with
  30-minute rows the event jumped up to 15 minutes as soon as it moved, even sideways. `tools/fullcalendar-patch.mjs`
  (an esbuild plugin, in the plugin build and the preview) sets `useSubjectCenter = false`, and fails the build if
  FullCalendar loses a line it patches. It also lays out what's at the same time in the week and day (SPEC §7.1,
  Google Calendar's way): `markBehind`, injected into `@fullcalendar/timegrid/internal.js`, marks an event whose
  overlaps all start `HEADING_PX` (48) or more below its top; it weighs `BEHIND_WIDTH` (0.25) instead of 1 in
  FullCalendar's columns and is drawn to the right edge behind them; the rest sits side by side (FullCalendar's
  default drew the later one over the earlier from its middle, covering its title). Only with `slotEventOverlap`
  (the task form's day preview turns it off: side by side always). The `calendar-week` preview checks a deadline
  5 minutes into "Cours réseau" sits beside it, and "Séminaire" keeps its width with one at 12:00. In the month
  (2026-10-20), lines have two heights (`.is-span`: an event or session within a day, start over end, `ct-ev-bar
  .is-tall` of seven dots; deadlines one line), and FullCalendar's "+N more" assumed one: it hid the line above
  whatever didn't fit (room for the link) and kept its place empty, and a shorter line further down still fit
  under the gap. In `@fullcalendar/daygrid/internal.js`, `DayGridSegHierarchy` now hides the line above only if
  `moreLinkRoom` (the link's height at the row's font) doesn't fit, and `closeDays` / `hideInClosedDays` hide
  everything after the first hidden line of a day (a multi-day event still shows on its other days). The
  `calendar-month` / `calendar-month-narrow` previews check each day's lines follow one another, then the link
  (`packedDays`), and the kinds of a day in order with 6px between them: `monthGroup` (expand.ts: bars, deadlines
  all day, sessions all day, what has a time) is the month's first `eventOrder` key (`extendedProps.monthGroup`),
  and `monthGroupStarts` marks the first line of each kind on its day `ct-ev-apart` (its margin is inside
  FullCalendar's harness, so it's measured). A ticked checkbox shows its tick by `opacity`: `visibility: visible` showed it through
  FullCalendar's hidden lines. Moving is behind `CalendarView.moving` (the toolbar's "Move", off at each open,
  confirmed 2026-10-20: it's the mode that changes the calendar, never remembered):
  events get `editable` only then; the panel's drop and the card's time fields don't depend on it, and a drop from the panel turns it
  on (2026-10-20: the session just placed is stretched next; `calendar-interact` drops one, then pulls its edge). The
  `calendar-drag` preview checks nothing moves while locked, then exact landings (event, work session, deadline).
  Move mode shows through `.ct-calendar.is-moving` (frame on `.ct-calendar-grid`, `.fc-event:not(.fc-event-draggable)`
  faded, `.fc-event-resizer-end` shown with a grip) and `renderLegend` (the hint replaces `.ct-key`); Escape ends it
  only when this calendar is the active view (the keydown is on window).
  In the month, FullCalendar drags a `position: fixed` copy, which Obsidian's `.workspace-leaf { contain: strict }`
  placed from the tab's corner (far from the pointer): `fixedMirrorParent` is `CalendarView.dragLayer`, a
  `ct-calendar` > `fc` div on the document's body (our look still applies), removed on close. The
  `calendar-month-drag` preview puts the calendar in a `.workspace-leaf` beside a fake sidebar to catch it.
  A deadline set from the calendar (drag, picker) goes through `TaskSync.setDue`: the cached VTODO first (the
  calendar draws from it), then the note. Through the note alone it waited for `NOTE_DEBOUNCE_MS`, and any redraw
  in between (a sync ending, another move) drew it back at its old place. The `calendar-drag` harness redraws
  100 ms after each drop to catch this, and reads positions in one `evaluate` (a locator can catch a redraw midway).
  `refresh()` and `tick()` wait while an event is pressed (pointerdown on `.fc-event` until pointerup) or dragged /
  stretched (`eventDragStart` … `eventDragStop`), then run once let go (after FullCalendar applies the drop):
  FullCalendar hides what's dragged by instance id, and a refetch mid-drag made new instances, so the original
  (even twice) showed beside the one in hand. `calendar-drag` holds an event while the previous drop's redraws come.
- **Video meetings** (2026-10-22): `meetingOf` (`src/calendar/meeting.ts`, cached per ical.js component in a
  WeakMap: a series' occurrences share their master) reads the link from `CONFERENCE` / Google / Microsoft properties,
  else from a known service's link in `URL`, `LOCATION`, `DESCRIPTION`, else any link in `LOCATION` then
  `DESCRIPTION` (`anyIn`: maps, documents, files, help pages left out by `NOT_MEETINGS` / `NOT_MEETING_PATH`; in the
  notes the link on a line with a meeting word first) (spec §7.1). `Occurrence.meeting` carries it;
  `Occurrence.location` is `placeOf` (null when the place is only that link). "Join" opens with `window.open`
  (Obsidian hands it to the browser). The `calendar-card` preview clicks *Rejoindre Teams* with `window.open`
  stubbed; `event-note` checks its header button.
- **Event notes whose event isn't in the calendar** (2026-10-19): `eventOfNote` finds the occurrence with
  `findOccurrence(…, { declined: true })`, so a declined invitation's note still answers it; the header's `missing`
  is `"declined"` or `"deleted"` (no catalog entry once calendars are synced), and then has no reveal (time static,
  no calendar button). Deleted offers "Delete the note" = `fileManager.promptForDeletion` (Obsidian's confirmation
  and trash settings; it trashes the file itself). `revealInCalendar` shows a hidden collection again.
- **Calendar navigation** (2026-10-19): `navLinks` with `navLinkDayClick: "timeGridDay"` / `navLinkWeekClick:
  "timeGridWeek"` (our toolbar isn't FullCalendar's, so its own "day" was `dayGridDay`, a list); `weekNumbers`
  drawn as small tabs ("S43", `view.weekShort`). `reveal` switches to the occurrence's day view.
- **Task form layout** (2026-10-19, "un problème d'harmonie de spacing"): Obsidian top-aligns setting rows, so
  `.ct-task-fields` gives names `min-height: var(--input-height)`; on desktop each row's control is a fixed grid
  (`7.5em 4.5em 0.75em 4.5em 28px 28px`, `flex: none`, the info takes the rest) so columns line up across rows;
  the calendar button is always the last track, menus span `2 / -1`. Phones keep Obsidian's stacked rows.
- **One field, one thing** (2026-10-19, the user: "évite d'avoir des champs multi usage"): in forms and the month
  picker, a day field and time fields (deadline: Day + Time; time block: Day + Start – End), read by
  `readFields` (when.ts; errors `day` / `time` / `end` / `noDay` / `noStart` / `endBefore`, said by
  `fieldsProblem`, marked by `markFields`). No on/off switches, no placeholder standing for a state. Free text
  ("ven 14h", "mar 14h-16h", "lun au mer") stays for `@` in notes only.
- **Their name is "session"** (2026-10-20, the user: "j'aime pas le terme créneau"; chosen over bloc, séance, time
  block): "Session de travail" in the key, "2 sessions", `@session`; English the same. The old keywords
  (`@créneau`, `@bloc`, `@block`) were dropped, asked: `@session` is the only one (`FEATURE_WORDS` in when.ts).
- **Time blocks are events, never task fields** (RFC 5545 has no work-session field; agreed with the user): `@session`
  becomes a VEVENT with `RELATED-TO` once TaskSync gives the note its UID (`TaskSync` `created` callback →
  `main.createBlocks`; pending blocks are in memory, lost if Obsidian closes before the first sync).
- **Repetition**: `repeat` in the note (English phrase, or raw RRULE) ↔ `RRULE`; `normalizeRule` gives one spelling
  so iOS's `INTERVAL=1;WKST=MO` doesn't ping-pong. Ticking moves the task on (`TaskSync.moveOn`, `nextOccurrence`
  via ical.js), pushing from the new state rather than re-reading the note (Obsidian parses frontmatter later).
- **Pasted task lines convert at once** (`input.paste` / `input.drop` only, never undo or a file synced from
  elsewhere): a line copied with its newline puts the cursor below it, so it was never "left".
- **Auto-conversion is optimistic**: `TaskConverter.prepare` picks the path (reserving it against a second quick
  conversion) and `prime`s the TaskIndex; the line becomes `- [[Task]]` on the next microtask, the note is written
  after, and a failed write puts the line back. The user saw the old "write, then replace" as lag.
- **Editor works without a server**: TaskIndex, decorations and conversion only touch notes; TaskSync gives the
  new note its VTODO when a server is configured (a note without `caldav_uid` = "not on the server yet" icon).
- **Decoration refresh** goes through a CM6 `StateEffect` dispatched to every live editor (tracked by the
  ViewPlugin), not `workspace.updateOptions()` (reconfiguring with the same extension keeps old plugin instances).
  Reading view: `previewMode.rerender(true)`.
- `scripts/check-mobile-load.cjs` stubs `@codemirror/*` with a permissive proxy (module-scope
  `StateEffect.define()`); Obsidian provides CodeMirror on every platform.
- **FullCalendar v6** (MIT plugins only): v7 moved the vanilla build to the `fullcalendar` package with a new API;
  v6 is the known, stable one. It injects its CSS itself; `styles.css` maps its variables to Obsidian's.
- **What can be edited in the calendar**: events and work sessions in writable calendars, except invitations and
  mirrored events (`X-CALTASKS-SOURCE-ACCOUNT`), which only get Accept / Maybe / Decline (right-click). Deadlines move
  by editing the task note's `due` (TaskSync pushes). Moving one occurrence of a series writes an exception
  (RECURRENCE-ID in the series' DTSTART zone); the whole series is moved on the phone. Answers apply to the whole
  invitation (series and exceptions).
- **Recurrence ids** are RECURRENCE-ID instants in UTC (`20261019T080000Z`) or dates (`20261019`), never local
  strings: they're stored in event notes and travel in `obsidian://…&rid=` links.
- ical.js needs the zones: `registerZones` registers the item's VTIMEZONEs and generates one for IANA TZIDs
  without a definition.
- File names keep the server summary unless the user renames the note (`titleMatches`).
- **Tags, not projects** (2026-10-25, the user found project notes odd; "oui" to: Obsidian's own tags, projects
  gone): the note's `tags` (list, no "#"; `tagsOf` reads a string or "#" too) ↔ `CATEGORIES` (`categoriesFor` /
  `tagsFromCategories` in `src/tasks/tags.ts`: a category that can't be a tag stays, "Work stuff" ↔ `Work-stuff`
  keeps its spelling, compared in any case and order so nothing ping-pongs). `@tag famille` (one per `@`; spelling
  kept: `findWhen` reads it back from the line, `parseToken` sees folded words) gives the task a tag; the assistant
  offers `main.knownTags` (cached until a note changes). A `#tag` on a task line does too (2026-10-26: left to
  Obsidian for a few hours, put back after the link; the user asked for both): out of the title, and off the line
  once applied. A `#tag` alone doesn't make a task (`hasTaskMarker` is `@` only). No inheritance (not from the note it's in, nor the
  parent). Chips show a chip per tag (one chip for all until 2026-10-26),
  less the containing note's (`getAllTags` in `main.noteTags`); the header shows them in one item (two pills
  wrapped the full header at 900 px). The form's Tags field is free text with `AbstractInputSuggest` (vault tags
  from `getAllTags` over every note, most used first; `metadataCache.getTags` isn't public); a pick sets the field
  without an `input` event (that reopened the list). Bases groups by the whole list: `[famille, urgent]` is one
  group "famille, urgent" (checked in Obsidian); `file.hasTag("famille")` filters one tag (checked too). The
  `projectTag` setting, project notes and the `project:` property are gone; old `project:` values are left alone.

## Gotchas (inherited from claude-workspace)
- Never declare class fields that shadow Obsidian base-class members (`containerEl`, `contentEl`, `titleEl`,
  `icon`, `scope`…); tsconfig has `useDefineForClassFields: false` too.
- `Plugin.removeCommand(id)` takes the id without the plugin prefix.
- Obsidian `onunload` is sync; async cleanup is fire-and-forget.
- WSL is in NAT mode. Windows → WSL works through localhost forwarding, so Windows Obsidian reaches Davis at
  `http://localhost:9000/dav/` (verified 2026-10-15; the reverse, WSL → Windows `127.0.0.1`, doesn't). The Tailscale URL only works from
  tailnet devices, and the PC's Windows side isn't one (Tailscale runs inside WSL).
- Obsidian's `normalizePath("")` returns `"/"` (the test stub does the same), so `normalizePath(x) || fallback`
  never falls back. An emptied folder setting got saved as `/` that way (fixed 2026-10-15 in `mergeSettings`).
