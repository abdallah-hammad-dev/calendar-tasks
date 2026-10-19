# Calendar & Tasks for Obsidian — spec

Founding spec of this extension. Read it fully before writing code, then work milestone by milestone (§10).
Background: the design recap `Calendrier & tâches Obsidian — récap de la discussion.md` (French) and
`claude-workspace/docs/BRIEF.md`. Where they disagree with this file, this file wins.

---

## 1. What it is

An Obsidian extension (desktop + mobile) that turns my vault into the front end of my own calendar and task
system. Data lives on a CalDAV server (my Davis, sabre/dav), so Apple Calendar and Reminders on my iPhone show the same
events and tasks. In Obsidian:

- every event can have a note (created when I click it), every task **is** a note;
- a calendar view shows events, task deadlines and invitations;
- the list of all my tasks is a native **Bases** view;
- a task written in any note becomes a real task, shown as a checkable link wherever it is mentioned;
- Claude Code (through the claude-workspace extension) can read and change all of it.

It's built for me first, but published on GitHub: a friend will use it, others can fork it.

## 2. Principles

1. **Native Obsidian first.** Properties (frontmatter), Bases, tags, `[[links]]`, native autocomplete. Custom code
   only for what Obsidian can't do: CalDAV sync, the calendar view, turning a line into a task note, parsing
   `@dates`, drawing checkboxes on task links.
2. **Standards.** iCalendar `VEVENT`/`VTODO` over CalDAV. Any client (Apple Calendar, Reminders, KOrganizer,
   Thunderbird) keeps working on the same data. Works with **any** CalDAV server (Davis, Radicale, Nextcloud, Fastmail,
   iCloud with an app password), not only mine.
3. **Pure CalDAV client. The extension never calls the Go backend.** The backend is a separate robot next to
   the CalDAV server (external-account mirrors, RSVP relay). Everything the extension needs from it arrives as CalDAV data.
   Without the backend, everything works except external accounts and RSVP relaying.
4. **The link is the iCalendar `UID`, never a file path.** Renaming or moving a note breaks nothing.
5. **Settings cover names and connections, not the data model.** Tag, folders, server, collections are
   settings. Property names and behavior are fixed (in one constants file, for forks).
6. **Mobile works.** No Node APIs outside the desktop-only Claude module; all HTTP through `requestUrl`.
7. **Secrets never sync.** The CalDAV password lives in Obsidian's keychain (`app.secretStorage`),
   never in `data.json`, which syncs with the vault.

## 3. Architecture

```
 iPhone: Apple Calendar + Reminders ──┐
                                      │ CalDAV
 Obsidian (desktop + mobile)          ▼
 ┌─ this extension ──────────┐    Davis (source of truth)
 │ CalDAV client + cache     │◄──►  collections: perso, travail, …,
 │ sync engine (UID ↔ note)  │       mirrors "École (mirror)", …
 │ calendar view, editor     │            ▲
 │ Claude module (desktop) ──┼─► claude-workspace   │ CalDAV (watch + write mirrors)
 └───────────────────────────┘    (MCP + skills)    │
                                         Go backend: OAuth accounts, mirrors (Google API,
                                         Microsoft Graph, CalDAV), RSVP relay, accounts web page
```

**Who owns what.** CalDAV owns time data (start, end, `DUE`, status, recurrence). The note owns content (body,
links, drawings). The frontmatter copies the time fields it needs (§4).

## 4. Data model

### 4.1 Tasks

A task = **one note in the tasks folder + one `VTODO`**. Every `VTODO` has a note: a task created in Reminders
gets its note at the next sync (otherwise Bases couldn't list it). All tasks live in one folder; no project
folders.

```yaml
---
type: task
done: false               # checkbox property
due: 2026-10-15           # the deadline: date, or date-time (2026-10-15T14:00). Optional
project: "[[Olera]]"      # optional, link to a project note (§4.2)
parent: "[[Parent task]]" # only for a child task
collection: Pro           # the collection (CalDAV calendar) holding it, by name; changing it moves the task
caldav_uid: 8f3c…
---
Free content: context, links to any file, small steps as plain `- [ ]` (never synced).
```

| Note | `VTODO` | Direction |
|---|---|---|
| file name | `SUMMARY` | both (a rename in Reminders renames the note through `fileManager`, links follow) |
| `done` | `STATUS:COMPLETED` + `COMPLETED` + `PERCENT-COMPLETE:100` / `STATUS:NEEDS-ACTION` | both |
| `due` | `DUE` (`VALUE=DATE`, or `DATE-TIME` with `TZID`) + `DTSTART` = same value, as iOS writes it | both |
| `repeat` | `RRULE` (needs `DTSTART`: written = `DUE`). The note holds an English phrase (`every monday`, `every 2 weeks`, `every weekday`) or, for rules the grammar can't say, the RRULE itself. Rules are compared in one spelling (iOS adds `INTERVAL=1`, `WKST`) | both |
| `priority` | `PRIORITY` (2026-10-19, asked: none or three levels). The note holds `high` / `medium` / `low` (`haute` / `moyenne` / `basse` read too); written 1 / 5 / 9 as Reminders does, read 1–4 / 5 / 6–9 (RFC 5545); none = no property (0 read as none). A level written elsewhere (2, 7…) is kept while the note says the same level. Shown !!! / !! / ! (red / orange / blue) | both |
| `project` | `CATEGORIES:<project note name>` | both |
| `parent` | `RELATED-TO;RELTYPE=PARENT:<parent UID>`; read a `RELATED-TO` without `RELTYPE` as parent (iOS drops the parameter, RFC default) | both |
| `caldav_uid` | `UID` | set once |
| `collection` | the calendar the `VTODO` is in (its `displayname`) | both: a reminder moved to another list renames it; naming another collection moves the reminder (created there, then deleted here); a collection renamed is renamed in the notes |
| — | `URL:obsidian://calendar-tasks?vault=<vault>&uid=<UID>` | written by the extension |
| — | last line of `DESCRIPTION`: the same link (Reminders shows no URL field but makes links in notes tappable). The extension owns only that line, never the rest of the notes; setting to turn it off | written by the extension |

- **One date: the deadline** (`due`, optional). It's the one date Apple Reminders shows (it reads `DUE` only: a
  `DTSTART`-only reminder shows no date, bench test 6). **Time to work on a task is an event linked to it**
  (§4.4, `RELATED-TO`), never a task field: RFC 5545 has none for it, and an event shows as a slot in every
  calendar. A "planned day" kept in the note only was tried (2026-10-15) and dropped (2026-10-16): it doubled the
  time blocks, and an all-day block covers it.
- **Repeating tasks**: one note, one VTODO with `RRULE`. Ticking it (here, or on a phone that only marks it
  completed) brings it back at its next date after today, with a notice. What iOS
  does when it completes a repeating CalDAV reminder: bench test 9.
- **Small steps** stay plain `- [ ]` lines in the task note, never synced.
- **A step with its own deadline** becomes a child task (a note with `parent:`), synced as a child `VTODO`. It's a
  tree (`RELTYPE=PARENT`), not a dependency chain. Reminders shows child tasks flat and can't create them on a
  CalDAV list, but keeps `RELATED-TO` when a child is edited on the iPhone: hierarchy is created in Obsidian.
- **Calendar shows deadlines** (`DUE`), not tasks. Time spent on a task is a time block (§4.4).
- File names: `SUMMARY` with `/\:*?"<>|#^[]` replaced; a duplicate name gets ` (2)`, ` (3)`…
- **Collections are contexts** (2026-10-18, the user: "Général, Pro, École", never one collection for tasks and
  another for events): a collection made here holds events and tasks (iOS shows it in Calendar and in Reminders).
  **Where a new task goes**: the collection its note names, else its parent task's (a subtask stays with it), else
  its project's (`collection: École` on the project note), else the default collection (setting), else the first
  by name that holds tasks. Its note then says which. A name that matches no collection holding tasks (any case
  accepted) gets a notice and the task stays. Time blocks go in their task's collection; new events in the
  default one (the new event form can pick another).

### 4.2 Projects

- **A project is any note that carries the project tag** (default `#project`, mine `#projet`, setting). No special
  folder or type. Bases lists all projects with `file.hasTag(<tag>)`.
- A task belongs to at most one project: the `project:` link property (rename-safe, backlinks, groupable in Bases).
  No project = a general task.
- A task can be **mentioned anywhere**, whatever its project; a mention is only a link.
- Changing the tag setting later: notes with the old tag stop being projects until retagged. Tasks keep their
  `project:` (it's a link).

### 4.3 Events

A note is created **only when I click** the event (calendar view, or the `URL` on the iPhone); later clicks open it.

- Folder: events folder (default `Calendar/`, mine `Calendrier/`). Name: `13-10-2026 Title.md`, the day written as
  set (2026-10-19, the user: always day first; `13-10-2026`, `13.10.2026` or `2026-10-13`, never "/", which a file
  name can't hold); changing it renames the notes. Another event of the same day with the same title gets its
  time added (`13-10-2026 Title 14h30`), then " (2)"…; each note is tied to its event by `caldav_uid` (and
  `recurrence_id`), never by its name.
- **Recurring events: one note per occurrence.** All occurrences share `caldav_uid`; a Bases filter on it lists
  every session of a series. A hub note for the series is just a project.
- If the event is renamed or moved, the note is renamed (links follow).
- `start`/`end` go **CalDAV → note only**: events are moved in the calendar, not by editing frontmatter.
- **Header** (2026-10-19, asked: a band with the information, like task notes, not the properties): when, ↻,
  place, the collection (its colour), Accept / Maybe / Decline for an invitation; properties hidden (the same toggle
  as task notes). A click on the time (or the calendar button) opens the calendar on the event, in its day's view
  (2026-10-19), scrolled to it, blinking, to move it there (the week's tab opens its week, to move it to another
  day): never the system's date picker on `start` / `end`. Its collection hidden, it is shown again (a notice says
  so).
- **Not in the calendar** (2026-10-19, asked: the calendar button opened a day without the event): the header says
  why and has nothing to open there (the time isn't a link, no calendar button). Declined: "Declined: hidden from
  the calendar", the answer still there to change it. Deleted (not on the server after a sync): "Event deleted
  from the calendar" and **Delete the note**, through Obsidian's own deletion (its confirmation and trash
  settings). Before the first sync nothing is said.

```yaml
---
type: event
start: 2026-10-16T10:00
end: 2026-10-16T11:00
project: "[[Olera]]"       # optional, added by hand
caldav_uid: …
recurrence_id: …           # occurrences of recurring events only (original start, iCalendar format)
---
```

### 4.4 Time blocks

A work session on a task is a `VEVENT` with `RELATED-TO:<task UID>`. Clicking it opens the **task** note (no event
note). Hovering a deadline highlights its time blocks.

A session can come back (`@créneau chaque mardi 14h-16h`): a recurring `VEVENT` (`RRULE`), which Apple Calendar
shows like any recurring event. That's different from a repeating *task* (§4.1), whose deadline comes back each
time it's ticked. When a task is done for good (not a repeating one), its recurring sessions end: `UNTIL` = now,
past sessions kept; a series that hasn't started is deleted.

### 4.5 The `obsidian://` link

- `registerObsidianProtocolHandler("calendar-tasks", …)` handles `obsidian://calendar-tasks?vault=…&uid=…[&rid=…]`.
- It resolves the `UID` through the index (§6.3) and opens the note, creating it if it doesn't exist yet.
- Apple Calendar shows an event's `URL` as a link card with an **Open** button, under "Location", labelled with the
  URL's host, i.e. the protocol action name (tested): the action name is what I read on the phone. Reminders doesn't show
  `URL`, hence the link line in the notes (§4.1).
- **Limitation:** a recurring series has one `URL` for all occurrences, so a tap on the iPhone carries no `rid`.
  The handler then opens today's occurrence, else the next one.
- Mirror events are written by the backend: it must add the same `URL` itself, or they won't link back.

### 4.6 Invitations (mirror collections)

Events in mirror collections are **read-only except my `PARTSTAT`**.

- **I answer on the iPhone or in Obsidian.** The server must implement CalDAV scheduling (RFC 6638), which is why
  it is **Davis** and not Radicale (tested 2026-10-15, see the bench's `TESTS.md`):
  - Radicale: no Accept / Decline buttons, and iOS doesn't recognize me as the attendee, whatever the address.
  - Davis: Accept / Maybe / Decline **and a notification**, even for an invitation the backend writes with a plain
    `PUT`, as long as my `ATTENDEE` address is the Davis user's email (its `calendar-user-address-set`).
  - Davis holds **one email per user**, while invitations reach several of my addresses. So the backend writes my
    `ATTENDEE` with the Davis address and keeps the invited one in `X-SOURCE-ATTENDEE`.
  - Davis tries to send the reply to an external organizer itself and fails cleanly when no mail sender is set
    (`SCHEDULE-STATUS=3.7`, nothing sent). Keep `INVITE_FROM_ADDRESS` empty: the backend relays through the APIs, so
    there is no double reply.
- An invitation = `ORGANIZER` + my `ATTENDEE` line. `NEEDS-ACTION` shows as pending, with Accept / Maybe /
  Decline.
- **RSVP = the extension edits my `ATTENDEE;PARTSTAT=…` on the server** (`PUT` with `If-Match`). The backend sees
  the change and relays it to Google / Microsoft. Same path as answering from the iPhone. When iOS answers it also
  rewrites the `ATTENDEE` parameters (adds `CUTYPE`, `EMAIL`, drops `RSVP`): the backend compares `PARTSTAT` only.
- **Where my answer stands** (2026-10-19, asked: "le bouton accepter refuse marche ?"): sent at the first click, as in
  Apple Calendar and Google (no Validate step: an answer can be changed any time). The card stays open and a line under
  the buttons says where it is: "Sending your answer to the server…", "Not sent yet: the server can't be reached…",
  "Answer saved.", then from the backend's `X-RSVP-STATE`: on its way to the organizer, "Sent to the organizer.", or
  why it failed (in red). A new answer removes `X-RSVP-STATE` (it told how the previous one went); the backend writes
  it again. Declining hides the invitation, so a notice says so.
- Properties the backend writes and the extension reads (names to fix together with the backend):
  `X-SOURCE-ACCOUNT` (which account), `X-SOURCE-ATTENDEE` (which `ATTENDEE` is me), `X-RSVP-STATE`
  (`pending` / `confirmed` / `failed:<reason>`). "Me" = the server's `calendar-user-address-set` for my principal
  (standard); my addresses in settings are only a fallback for servers that don't advertise it.
- Declined invitations are hidden.

## 5. Editor

### 5.1 Task links are checkable

Any link to a task note (`[[Task]]`, `[[Task|alias]]`) is drawn with, in Live Preview **and** Reading view, on
desktop and mobile:

- a checkbox from the task's `done`: clicking it sets `done` in the task note, which syncs to CalDAV;
- the priority (!!! / !! / !), the deadline (flag icon, red when overdue) and the repetition (↻);
- the project name when it differs from the current note's project;
- a small sync-state icon (synced / pending / conflict);
- child-task progress, e.g. `2/5`, when the task has child tasks.

**Changing a task from its line** (2026-10-17): click a chip (or the pencil shown when the line is hovered, desktop)
to open the task form (§5.3) at that field; or type `@` after the link (`- [[Rapport]] @ven`), same assistant as
§5.2, and ✓ (or leaving the line) applies it and takes the `@` words off the line.

Lines hold only the link (`- [[Préparer slides]]`), never `- [ ] [[…]]`: one state, no stale checkboxes. Without the
extension, it's a plain link. Small steps (plain `- [ ]`, no link) look different on their own.

Implementation: CodeMirror 6 view plugin (Live Preview) + `registerMarkdownPostProcessor` (Reading view), driven by
`metadataCache`.

### 5.2 Writing a task anywhere

```
- [ ] Préparer slides @15/10 [[Olera]]
```

- **A `- [ ]` line with a task marker becomes a task automatically** when the cursor leaves the line: the extension
  creates `<tasks folder>/Préparer slides.md` + its `VTODO`, and replaces the line with `- [[Préparer slides]]`.
  The marker is `@` (the `@` grammar below), or `@` alone (a task with no date).
- **A line without a marker stays a small step**, unless I run "Convert to task" (command with a hotkey, also in
  the editor context menu; works on several selected lines).
- **The `@` assistant** (decided 2026-10-16: one thing per `@`, the user found a free-form phrase confusing):
  typing `@` in a checklist line first offers *what* to add: Deadline, Time block, Repeat, No date.
  Picking one writes its keyword and the list moves on to values for it (days, then times or time ranges; or
  repetitions), showing what they mean (🚩 / 🕒 / 🔁 / 📅). The ✓ item takes what's typed and ends the line, so the
  task converts at once; "Something else" starts another `@` on the same line; "Pick a date…" opens a month view
  in Obsidian's colors (the system picker looked foreign and opened in a corner of the window) and a field for
  each thing, never one field for two: Day, then Time (deadline) or From / to (time block), each read on its own
  ("ven", "15/10"; "14h"). No time is the whole day (an end alone isn't allowed; a start alone lasts an hour). A
  day typed moves the calendar there, a day clicked fills Day, quick times (9h, 12h, 14h, 18h) or ranges (9h–12h,
  14h–16h, 14h–18h, 18h–20h) fill the hours; no switch. OK, Enter or a double-click picks; a field not understood
  is marked, the line below says why, and nothing is picked. Once the words
  stop making sense (the title goes on), the list closes.
- **On a task already made** (`- [[Rapport]] @…`, the `@` after the link), the same assistant changes the task:
  a deadline replaces the old one, a time block is added, a repetition replaces the old one and keeps the deadline
  (moved onto the rule's first day from it: `@chaque lundi` on a task due Tuesday → the Monday after). "No date"
  is replaced by **Remove the deadline** (`@sans date`: deadline and repetition) and **Stop repeating**
  (`@répéter jamais`).
- **Written in a task note**, it becomes a child task (`parent:` set). Anywhere else, a standalone task.
- **Project**, first match wins:
  1. a link on the line to a project note (`[[Olera]]` carries the tag): it becomes `project:` and leaves the title;
  2. the note being written in, if it is a project;
  3. the `project:` of the note being written in (e.g. a meeting note);
  4. the parent task's project (child tasks);
  5. none.
- Other links on the line stay in the task: the title uses their display text, and the original line is copied
  as the first line of the task body so no link is lost.
- **The `@` grammar** (`src/editor/when.ts`), French and English. Each `@` is one thing: a keyword, then its value.
  - `@deadline` / `@échéance` / `@due` + a day and/or a time: `@deadline ven 14h`. **Shortcut**: a day straight
    after `@` is a deadline (`@demain`, `@ven 14h`).
  - `@créneau` / `@bloc` / `@block` + a slot: `mar 14h-16h`, `mar 14h à 16h`, `14h pendant 2h`, `mar matin`
    (9–12; `aprem` 14–18, `soir` 18–20), `mar` (all day); a start alone lasts an hour. **A time block is an event**
    (VEVENT with `RELATED-TO:<task UID>`, in the event calendar), created once the task note has its reminder:
    blocking time is never a task field (RFC 5545 has none for it; DTSTART is a start date, not a work session).
    A repetition inside the slot makes it come back (§4.4): `@créneau chaque mardi 14h-16h`, `@créneau en semaine
    7h-8h`, `@créneau chaque semaine ven matin`; it starts on the rule's first day unless one is given.
  - `@répéter` / `@repeat` + a repetition: `chaque semaine`, `tous les 2 jours`, `chaque lundi et jeudi`,
    `en semaine`, `every month`… optionally + a time (`chaque lundi 7h`). **Shortcut**: a repetition straight after
    `@` (`@chaque lundi`). With no deadline, it starts on its first day from today.
  - `@sans date` / `@no date`, `@` alone, or a keyword with no value: a task without a date. On a task already
    made, `@sans date` removes its deadline and repetition, `@répéter jamais` / `@repeat never` its repetition.
  - Days: `15/10` (day/month, the next one), `15/10/2027` or `15/10/27`, `2026-10-15`, `15 octobre`,
    `1er nov 2027`, `oct 15`, `demain` / `tomorrow`, `lun` / `mon` (next one), `lundi prochain`, `dans 3 jours` /
    `in 2 weeks`. While a date is being typed (`15/10/2`), the list stays open and says how to write one.
    Times: `14h`, `14h30`, `14:30`, `2pm`, `à 9h`, `matin` (9:00), `midi`, `aprem` (14:00), `soir` (18:00).
  - Several `@` on one line combine: `- [ ] Rapport @ven 18h @créneau mar 14h-16h @répéter chaque semaine`.

### 5.3 New task button, planning

- **New task** (ribbon icon, command, and a button in the calendar view): a form with the title, an optional
  deadline (a day and a time, or picked from the month view), optional time blocks (a day, from, to), a repetition (never / daily / weekly / weekdays / monthly /
  yearly), a project (defaults to the one of the note in front) and the collection (the project's if it names one,
  else the default; follows the project picked until picked by hand). Writes the task note; TaskSync creates its
  reminder, then the block. A repetition with no deadline starts on its first day from today.
- **The form's look** (2026-10-17): the title as a large field on top, rows with an icon (deadline, time blocks,
  repeat, priority, project), no static descriptions (the line under a field says what it read). Repeat, priority (None / Low / Medium / High,
  as on the iPhone) and project open Obsidian's own menu, never the system list. Rows in step (2026-10-19): each
  name centred on its field, the fields in the same columns from row to row (day, time or start, –, end, +,
  calendar), the menus from the time column to the end, the buttons level with the bottom of the day beside, the
  lines under the names short ("→ ven. 23 oct. 18:00"); repeat ends with "Custom…" (type "chaque lundi et jeudi").
- **A field for each thing** (2026-10-19, asked: "sépare les champs, le jour et l'heure, évite d'avoir des champs
  multi usage"): the deadline is Day + Time, a time block Day + Start – End, each field read on its own ("ven",
  "15/10"; "14h"), named inside while empty. No time is the day itself (a whole-day block); a start alone lasts an
  hour; hours without a day, an end without a start or before it are marked, and the line under the row says why.
  Multi-day and recurring slots stay with `@` in notes.
- **Time blocks in the form** (2026-10-17, the user found a single field unclear: no time, and no way to tell if
  it was taken): a list. A slot goes in dragged on the day beside, from the calendar button, or typed in its
  fields then Enter or +. The list and the day beside show the same slots: those the form adds are tinted (filled
  with the accent beside) with ✕, those already planned are grey; no status words (2026-10-19: "à ajouter" read as
  an order, and a drag that only filled the fields didn't show in the list). A slot typed but not added still
  counts on save. Nothing reaches the calendar before the form is saved; a notice says when blocks do.
- **The day beside the form** (2026-10-18, asked: "voir où ça va se placer par rapport aux autres événements"):
  with a server, a day of the calendar sits beside the fields (below on a phone), drawn like the calendar. It
  shows the day of the deadline or slot just typed, scrolled to it, with that day's events; what's being placed
  (deadline, slots to add, the slot being typed) is filled with the accent, like a selection in the calendar, and
  the rest fades, side by side rather than overlapping (2026-10-18: an outline alone didn't say "being set"). Dragging over free time (or a click: an hour)
  adds a slot to the list; what's being placed moves and stretches by 5 minutes, and its row or fields follow. ‹ › change the day. A click on a slot in the list (to add, or already planned), or in the
  deadline or slot fields, shows that day; the slot row shown is outlined (2026-10-18: once a second slot was
  added, the first one and the deadline couldn't be found again). In edit, the task's current deadline isn't
  drawn twice.
- **Edit the task…**: the same form filled in (clicking a chip opens it at that field; also the editor's context
  menu, a command, and the calendar's menu on a deadline). A new title renames the note (links follow).
- **Block time… / Change the deadline…**: the month view with its fields (day, from / to; day, time; "No deadline"
  beside OK when one is set), from the editor's context menu on a line linking a task, from two
  commands (the linked task or the task note in front), and from the calendar's context menu on a deadline.
- **Tasks** panel in the calendar view (toggle, remembered): every open task, sorted by deadline (the most urgent
  first for the same one), each with its priority and how
  many time blocks it has this week or later (one dropped on a day already past this week counts, and one waiting
  for the task's reminder), in words after the work session's dashed shape: "2 créneaux" (2026-10-19: a clock and a
  number read as nothing). A task can get several blocks in a week, so planned tasks stay (2026-10-18: the user
  disliked a "To plan" list that dropped them); a "No time block" toggle (remembered) shows only those with none.
  Drag one onto the calendar to block time there (a time slot: an hour, resizable; a day: all day); click one to
  type a slot. On a phone the open panel replaces the grid.
- Blocking time at capture is `@créneau …`; usually it's decided later, looking at the week.

### 5.4 Task note header

Asked 2026-10-17: a task note opens with its checkbox and data cleanly on top, still there when scrolling, and not
its raw properties ("I don't want to see the id; if I want to, I can open the properties myself").

- A bar above the page (outside its scroller, so it stays): the checkbox with "To do" / "Done", the priority's
  marks (the word in its tooltip; a click opens the form there), the deadline (red
  when overdue), the repetition, the next time block (+N more; click shows it in the calendar; + adds one from the
  calendar picker), the project and parent task (links), child-task progress, the sync icon when not synced.
  Clicking the deadline or repetition opens the task form there. Only what the task has is shown (2026-10-19: the
  dashed "Deadline" / "Time block" placeholders read as data; the pencil adds them). A pencil opens the form.
- The note's properties are hidden in task notes (Obsidian's `--metadata-display-*` variables, the mechanism of
  its own "hide properties" setting); a button in the bar shows them again (remembered).
- Kept current on file open, layout changes, task changes, syncs, and every 5 minutes.

## 6. Sync

### 6.1 CalDAV client

- Discovery from the server URL (`.well-known/caldav`, principal, calendar home), then the chosen collections.
- `tsdav` if it accepts a custom fetch backed by `requestUrl`; otherwise a small hand-written client
  (`PROPFIND`, `REPORT sync-collection`, `PUT`, `DELETE`). Parsing and recurrence expansion with `ical.js`.

### 6.2 Engine

- **Local cache** per collection (items + ETags + sync-token) in plugin storage: instant display, offline.
- **Incremental sync** with sync-tokens (RFC 6578); full resync if the token is invalid.
- **Local changes are queued** and pushed with `If-Match: <etag>`. A `412` refetches the item. If the same field
  changed on both sides, the server wins for time fields and a notice tells me. Nothing is silently overwritten.
- **When:** at startup, every N minutes (setting), when Obsidian regains focus, and right after a local change.
- **Note → CalDAV** changes are detected from `metadataCache` changes on notes with `caldav_uid`.
- **A token echoed back unchanged while the server's current token differs** means the server can't serve it
  (sabre/dav answers "no changes" to unknown tokens with its own prefix): full resync. Tested against Davis.
- **Edit items in place, never regenerate them.** Change only the properties the extension owns and keep everything
  else as is: iOS adds `VALARM`, `VTIMEZONE`, `X-APPLE-SORT-ORDER`, `SEQUENCE`, `TRANSP`… and keeps our `URL` and
  `X-` properties when it edits (tested), so we must return the favor.
- **Times are written in the user's time zone** (`TZID=<Obsidian/system zone>` + its `VTIMEZONE`), never in UTC:
  with UTC times Apple Calendar shows a second "(GMT)" time under every event (tested). All-day dates stay
  `VALUE=DATE`.
- The iPhone sees changes at its next fetch (no push for non-iCloud CalDAV): pull-to-refresh, or "Fetch new data:
  every 15 minutes" in iOS settings. Document it in the README.

### 6.3 Index

`UID (+ RECURRENCE-ID) → note path`, built from `metadataCache` at startup and kept up to date on
create / rename / delete.

### 6.4 Deletion (implemented as proposed in M2)

- Server-side deletion never deletes a note: an event note stays as is (its header says the event is deleted and
  offers to delete the note, §4.3); a task note gets `done: true` and loses its `caldav_uid`.
- Deleting a task note deletes its `VTODO`. Deleting an event note deletes nothing on the server (event notes are
  optional).

## 7. Views

### 7.1 Calendar view

A custom `ItemView` (`registerView`), fed by the cache, so it shows events that have no note. FullCalendar (MIT
parts only) lays out the grid and handles dragging; everything you see is drawn by the extension in Obsidian's style
(2026-10-17, the user found FullCalendar's look out of place and chose "keep the engine, redo the skin" over another
library or a home-made grid): our toolbar (‹ › Today, the period, a segmented Month / Week / Day / Agenda control,
New task, To plan, Sync), our events, our day headers (weekday small, date large, today in an accent disc), and,
as in Apple Calendar (2026-10-19), a day's header (or its number in the month) opens that day's view and a small
tab with the week's number ("S43", at the start of each week in the month, in the corner of the week and day
views) opens that week; both only answer the pointer (no buttons), and
popovers.

- Month / week / day / agenda (no week on phones); the last view is remembered. One color per collection;
  collections are toggled from the row under the toolbar, all alike, in the server's order: a dot in their color
  (hollow when hidden), their name, "Hide" / "Show" on hover. Their pencil (or a right-click) opens a card: name, a
  color, shown or not, and "Delete collection" (no explanatory lines: the user found them silly, 2026-10-18).
  "+" after them creates one (MKCALENDAR in the account's home): a name and a color not used yet; it holds
  events and tasks.
  Deleting asks first, saying what it holds; it's like deleting each thing in it: gone from the server and every
  device, and its tasks' notes stay, ticked and unlinked (§6.4); a setting pointing at it goes back to automatic. Name and color are written on the server (PROPPATCH `displayname` and `calendar-color`, the color
  property every CalDAV client reads), so every device gets them; read-only collections only show them. Names are
  shown as the server has them, never translated per client (2026-10-17: the user wants a plain CalDAV account
  that Apple reads, nothing Apple-specific; the list iOS created as `DEFAULT_TASK_CALENDAR_NAME` gets a real name
  by being renamed on the server).
- **Display types — three shapes, whatever the colors** (2026-10-17: with every collection in the same blue, the
  user couldn't tell events from tasks): an **event** is a filled block (tint + solid bar; a solid vertical bar in the month and the agenda);
  anything about a task carries the **task's checkbox**, ticked in place: a **work session** is drawn like an
  event, its bar dashed (2026-10-20: a dashed outline around a barely tinted block didn't read as time taken; a
  finely dotted vertical bar in the month and the agenda, where a dot and a dashed ring said little; the bars are
  Apple Calendar's), a **deadline** a one-line outlined marker, cornered like events (2026-10-19: a pill
  read badly; a line across the day through it was tried and dropped: ugly), with "⚑ 18:00" (the time drops
  first when narrow; the checkbox, flag and time turn red once missed, the title stays readable; struck through
  when done). A key under the toolbar names the three shapes, each drawn as the view draws it: blocks in the week
  and day (the deadline's: an outlined box with its checkbox), the line marks in the month and the agenda (a solid
  bar, a dashed one, the checkbox). Deadlines closer than 20 minutes on a day are one
  marker, "3 tâches" + their names, whose card lists them with checkboxes (Google Calendar's "N tasks"; side by
  side they were unreadable slivers). Invitations: striped and an envelope while unanswered, faded for "maybe".
  Month lines are aligned: mark, time, title; all day, events stay bars, deadlines and work sessions are lines too.
  What lasts within a day (an event, a work session) takes two lines: its start over its end (fainter), the bar
  along both, the title beside on up to two lines; a deadline, a moment, keeps one (2026-10-20, asked: always the
  start and the end; on one line, "08:30 – 10:30" left little room for the title in a narrow day). A day too full
  shows its lines one under the other, then "+N more" right under them: nothing further down shows, and the line
  above goes only if the link has no room.
  The dotted bar is whole 2px dots, the same in every line (fitted to the height, some looked thicker; 2026-10-20).
  Bars, dots and dashes are whole device pixels at any screen scaling: at 125 % (Windows) 2px is 2.5 pixels, and
  dots came out 2 or 3 pixels long, bars 3 or 4 wide, depending on where each fell (2026-10-20). So these sizes are
  2 and 3 CSS pixels rounded down to the pixel (2 and 3 pixels at 125 %, 3 and 4 at 150 %), followed as the
  scaling or Obsidian's zoom changes.
- **Agenda** (2026-10-20: FullCalendar's list read as a spreadsheet): a heading per day in one piece, "Mardi
  27 octobre" (the year when it isn't this one) then "Aujourd'hui" (the accent) or "Demain"; a click opens the day.
  Then the day's items without lines between them: when (muted; a deadline's after a flag, "⚑ 18:00" or
  "⚑ Journée", red once missed), the month's mark in a column of its own (a solid bar, a dashed one, the checkbox, which
  ticks the task), the title (the same weight for all) and "· where". What's over fades.
- **What's at the same time** (week and day; 2026-10-19: a deadline at 14:05 covered the title of the event at
  14:00), as in Google Calendar: what starts together (less than a title and its time apart) sits side by side;
  what starts well below an event sits over its lower part, a little in from its left edge, the event drawn whole
  behind it (side by side always, as in Apple Calendar, halved a 3-hour event for a deadline at its end). Narrow,
  titles wrap whole words and the repeat icon makes room.
- **Precision: 5 minutes** (Apple Calendar's): dragging and resizing snap to 5 minutes, and a dragged event shows
  the time it lands on. A click on an empty slot gives an hour from the half hour clicked. **To the minute**: the
  new event form and an event's card (click its time) have Start / End, each a day field and a time field (2026-10-19:
  the date-time fields opened the system's calendar), and "All day", which hides the times; moving the start keeps
  the length, what isn't understood or an end not after the start is marked and blocks saving, and the selection on
  the calendar follows what's typed. The form is one grid (icon, name, field on every line: Start, End, All day,
  Collection, For a task), no description lines, no tooltip on a field that shows its name.
- **Zoom** (week and day): Ctrl/⌘ + wheel, a trackpad or touch pinch, or the − / + buttons make the hours taller
  (26 to 312 px an hour, 52 by default, kept per device); the time under the pointer stays put. Taller hours get
  quarter-hour lines and their half / quarter hours written, fainter. A deadline stays one line high.
- **Click** shows the event's card beside it (a modal on phones): when, ↻, place, collection, the task it's a time
  block for, a checkbox for a deadline's task, Accept / Maybe / Decline for an invitation (and where my answer stands, §4.6), "Create the note" while
  the event has none (notes are made on first open, §4.3; 2026-10-19), then "Open the note" (or "Open the task"; the
  right-click menu says the same), and "…" for the other actions (the right-click menu); while its time is being changed, Save is the only
  main button. The card is drawn again when the data changes (an answer pushed, a sync), and closes only if its
  occurrence is gone. Dragging a deadline edits `due`.
- **Drag / resize** moves an event (not mirror events or invitations: their tooltip says why), a work session or a
  deadline, **only in Move mode** (2026-10-19, asked: "pas envie de bouger mon calendrier en glissant des trucs sans
  faire exprès"): a "Move" toggle in the toolbar, off whenever the calendar opens (2026-10-20, confirmed: it's a
  mode for a moment, the one that changes the calendar, and must read as such; never remembered). It shows all over, not only on
  its button (2026-10-19, asked; Apple's jiggling icons as the idea, not the look): the button turns to "✓ Done",
  the grid is framed in the accent, what can't move fades, what can be stretched shows a grip at its bottom, and the
  key under the toolbar gives way to the hint ("Drag to move, pull the bottom edge to change the length"; in the
  month "Drag onto another day"; "Esc to finish"). Escape or Done ends it; the agenda (nothing drags) ends it too. Off, a press on an event only
  opens its card. Dropping a task from the Tasks panel and changing times in a card work either way (both are on
  purpose); a task dropped turns Move mode on, so the session just placed can be stretched at once (2026-10-20,
  asked: placing a task means giving it its length). The event follows the pointer from where it was grabbed, to the 5 minutes (2026-10-19: it jumped up
  to 15 minutes as it started to move). In the month, what's dragged stays under the pointer (it was far from
  it) and the day it lands on is outlined; it keeps its time. What's dropped stays where it lands: a deadline
  changes its reminder at once, then its note (2026-10-19: "ça revient puis ça se redéplace" when the calendar
  redrew before the note's change reached the reminder). While something is held, the calendar doesn't redraw
  (2026-10-19: a redraw from the move just before showed the old one again beside the one in hand); it does once
  it's dropped. **Selecting a range** creates an event (title, collection, or a task it's a work session for: picking it names the event, unless a title was typed), in a popover beside the selection, which stays drawn until the popover closes (a modal on phones).
- Editing an event's details (title, place, recurrence) can be done from a small modal; complex edits stay in
  Apple Calendar.

### 7.2 Task list — Bases

On first run, the extension writes a `.base` file (default `Tasks.base`; never overwritten afterwards) filtered
on `type == "task"`, with views:

- **To do** — `done` false, sorted by `due`, then the most urgent (`formula.urgency`: `priority` is text, so a
  number 1–4 from it; 2026-10-19);
- **By project** — grouped by `project` (a "no project" group), same sort;
- **Done**.

Views are Obsidian's own: the user (or Claude, whose skill lists the task properties, their types and the
`urgency` formula) makes any other view from the properties. Time blocks are events, never properties: no view
shows them.

`done` is a checkbox property, so it can be ticked directly in the table (verify inline editing on the minimum
Obsidian version). Any note can embed a `base` block listing "tasks of this note": `project` is this note, or this
note links to them (uses `this` in embedded bases; verify the exact filter syntax). A custom Bases view
(`registerBasesView`, 1.10+) is not needed for v1.

## 8. Claude module (desktop only)

Registered by this extension through claude-workspace's `plugin.api.registerModule` when that plugin is present and
`Platform.isDesktopApp`. Module id `calendar`, so tools are `calendar_*` (the registry enforces the prefix). See
`claude-workspace/docs/module-api.md`. **The input schemas use zod; use the same major version as claude-workspace
(v4) and check the first tool round-trips through its MCP server.**

| Tool | Purpose |
|---|---|
| `calendar_list` | Events (occurrences expanded), deadlines and time blocks in a range; each with UID and note path if any |
| `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` | Edit events (not mirror events) |
| `calendar_free_slots` | Free slots of a given length in a range |
| `calendar_rsvp` | Set my `PARTSTAT` on an invitation (the backend relays it) |
| `calendar_list_tasks` | Tasks by state, project, due range |
| `calendar_create_task` | Title, due, project, parent, body → creates note + `VTODO`, returns path |
| `calendar_complete_task` | Set `done` |
| `calendar_schedule_task` | Create a time block for a task |
| `calendar_note` | Path of the note of an event / task; creates it if missing (Claude then edits it with its own file tools) |

- **Context provider:** in the calendar view, the visible range and the selected event; in a task or event note,
  its CalDAV state (done, due, sync state, attendees).
- **Skill** (`registerSkill`), generated from the settings (folder names, project tag): deadline ≠ time block, a
  task is a note, how projects work, prefer these tools over editing `caldav_uid` / time fields by hand.

## 9. Settings

| Setting | Default (mine) |
|---|---|
| CalDAV server URL, username | — |
| Password | in the keychain |
| Collections shown; default collection (new tasks and events, when nothing else says) | discovered; first by name, shown by its name |
| Tasks folder | `Tasks/` (`Tâches/`) |
| Events folder | `Calendar/` (`Calendrier/`) |
| Date in event note names | `13-10-2026` (or `13.10.2026`, `2026-10-13`) |
| Task list base file | `Tasks.base` |
| Project tag | `project` (`projet`) |
| My email addresses (fallback when the server doesn't advertise `calendar-user-address-set`) | — |
| Sync interval | 5 min |
| Accounts page URL (backend web page, opened by "Add account") | empty = button hidden |

UI strings in one file, French + English. Code, README and commit messages in English. `minAppVersion` 1.13.2
(declarative settings tab with Obsidian's settings search, and the keychain `secret` control).

The README must say that **the CalDAV server needs HTTPS for the iPhone**: iOS doesn't send credentials over plain
HTTP and ignores a custom port without SSL (tested). For local tests, `tailscale serve` gives HTTPS with a real
certificate (see the bench's `TESTS.md`).

## 10. Milestones (in order; stop and show me at each)

- **Before M0 — done 2026-10-15.** iPhone tests: results in `~/organisation/calendar/bench/TESTS.md`, carried
  into §4 and §6. The school account test is skipped (a fallback exists in every case).
- **M0 — Skeleton.** Same tooling as claude-workspace: TypeScript strict, esbuild, ESLint, Vitest with an `obsidian`
  stub, test vault, release workflow, `CLAUDE.md`, MIT license.
- **M1 — CalDAV client + cache + sync engine**, no UI. Integration tests against the local Davis bench (`~/organisation/calendar/`).
- **M2 — Tasks.** Task notes ↔ `VTODO`, index, notes for tasks created elsewhere, `Tasks.base`.
- **M3 — Editor.** Checkable task links, line conversion, `@date` parser, project resolution.
- **M4 — Calendar view (read).** Display types, click → note, event notes, protocol handler.
- **M5 — Calendar view (write).** Create / move / resize, time blocks.
- **M6 — Invitations.** Mirror display, RSVP through `PARTSTAT` (tested with fixtures until the backend exists).
- **M7 — Claude module.**
- **M8 — Publish.** README, BRAT install for the friend, FR/EN strings.

## 11. Out of scope for now

Booking (public page, slots, sent invitations: part 2). `X-SOURCE-MAIL` link to the original email. Recurring
tasks, priorities, kanban. The backend's own MCP endpoint (Claude outside Obsidian).

## 12. Open questions

- Extension id and name (`calendar-tasks` is a placeholder; Obsidian ids can't contain "obsidian").
- `X-` property names shared with the backend (§4.6).
- Deletion rules (§6.4).
- Protocol action name: it is the label of the link card in Apple Calendar and the start of the line in Reminders
  notes, so short **and** readable (e.g. `obsidian://note?uid=…`), without clashing with other plugins' actions.
