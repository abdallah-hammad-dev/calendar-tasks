# Calendar & Tasks for Obsidian

Your CalDAV calendar and tasks inside Obsidian, in sync with Apple Calendar and Reminders (or any CalDAV client):

- **every task is a note**, synced as a reminder, and shows up as a checkbox wherever you mention it;
- **write a task anywhere**: `- [ ] Prepare slides @friday 2pm @tag work` becomes a task note;
- **the list of all your tasks** is a native [Bases](https://obsidian.md/help/bases) view;
- **a calendar view** with your events, task deadlines, work sessions and invitations;
- **every event can have a note**, created when you open it (one per occurrence for recurring events);
- **links back from the phone**: tapping the link in Apple Calendar or Reminders opens the note;
- a module for [Claude Workspace](https://github.com/abdallah-hammad-dev/claude-workspace), so Claude Code can read
  and change all of it.

> [!WARNING]
> **Early version, built with Claude Code.** I use it on my own vault and share it as is. It writes notes and
> calendar items: try it on a test vault (or a backed-up one) and a test calendar first.

## Requirements

- Obsidian 1.13.2 or later, desktop or mobile.
- A CalDAV server reachable **over HTTPS** (the iPhone refuses to log in over plain HTTP). Any standard server
  works: [Davis](https://github.com/tchapi/davis), Radicale, Nextcloud, Fastmail, iCloud (with an app password)…
  To answer invitations from the iPhone too, the server must support CalDAV scheduling (Davis, Nextcloud do;
  Radicale doesn't).

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add a beta plugin* → this repository's URL. Or copy
`main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/calendar-tasks/`.

## Setup

Settings → **Calendar & Tasks** → CalDAV server:

1. **Server address**: your server or account URL (e.g. `https://cal.example.com/dav/`).
2. **Username** and **password**. The password is kept in Obsidian's keychain, never in the vault.
3. **Test the connection**: you should see your calendars listed, and syncing starts.

Syncing runs at startup, every few minutes (setting), when Obsidian comes back to the foreground and right after
each change. The command **Calendar & Tasks: Sync now** forces it.

On the iPhone, add the same account in Settings → Calendar → Calendar Accounts → Add Account → Other → CalDAV,
and turn on Calendars and Reminders. Changes made in Obsidian show up at the phone's next fetch (pull down in
Calendar to force it; "Fetch New Data: every 15 minutes" helps).

## Tasks

A task is a note in the tasks folder (default `Tasks/`) with this frontmatter:

```yaml
type: task
done: false               # tick it here, in the task list, or on the phone
due: 2026-10-15           # the deadline, or 2026-10-15T14:00 (your local time). Optional
repeat: every monday      # optional: every day, every 2 weeks, every weekday, every month…
tags: [work, urgent]      # optional: Obsidian's own tags
parent: "[[Parent task]]" # only for a sub-task with its own deadline
created: 2026-10-21T14:05 # when the task was made, set by the extension
completed: 2026-10-25T14:32 # when it was ticked (here or on the phone); goes if it's unticked
caldav_uid: …             # managed by the extension, don't edit
```

The note's body is yours: context, links, drawings. It is never sent to the server.

**One date: the deadline** (`due`, optional), synced to your phone. Time to work on a task isn't a task field: it's
a *time block*, an event in your calendar linked to the task (see below).

**Write a task in any note** as a checklist line with an `@`. Each `@` adds one thing:

```markdown
- [ ] Prepare slides @friday 2pm @tag work             ← deadline (a day right after @), a tag
- [ ] Write the report @fri @session tue 2pm-4pm       ← deadline + time blocked on Tuesday
- [ ] Gym @repeat every monday and thursday 7am        ← repeats
- [ ] Move house @session mon to wed                   ← whole days blocked
- [ ] Call the bank @task                              ← just the task (or a lone @)
```

In French: `@deadline ven 14h` (or just `@ven 14h`), `@session mar 14h-16h`, `@répéter chaque lundi`,
`@session lun au mer`, `@tâche`.

**The `@` assistant**: typing `@` in a checklist line first asks what to add (*Deadline*, *Session*,
*Repeat*, *Tag*, *Priority*, *Create the task*), then offers values for it and shows what they mean. The ✓ item ends the line
and creates the task; *Something else* adds another `@`.

While you type it, an `@` shows as a **field** labelled with what it is (*🚩 Deadline*, or `#` for a tag); once it
has its value it becomes a **block** like the chips (`🚩 Tomorrow`, `#work`). Click a block to change it.
Backspace against a block selects it, a second Backspace deletes it.

- **Deadline**: `friday`, `tomorrow 2pm`, `15/10`, `15/10/2027`, `15 october 2027`, `in 3 days`, `next monday`…
  It's the date your phone shows. *Pick a date…* opens a calendar, with a time field (or none, for the whole day).
- **Time block**: `tue 2pm-4pm`, `tue 2pm for 90min`, `tue morning`, `tue` (all day), `mon to wed` (whole days).
  It becomes an event in your calendar, linked to the task (clicking it opens the task note), so it shows on the
  phone too. A task can have several. `every tuesday 2pm-4pm` makes a session that comes back (a recurring event);
  it stops when the task is done.
- **Priority**: `high`, `medium`, `low` (`@priority none` takes it off a task). Shown as !!! / !! / !, and synced
  as the reminder's priority.
- **Repeat**: `every week`, `every 2 days`, `every monday and thursday`, `every weekday`, `monthly`… The task
  syncs as a repeating reminder; ticking it brings it back at its next date instead of closing it. Each time
  you tick it is kept in `completions`; the note's bar lists the last days faintly, and a click lists them all.

A line is *left* when the cursor moves to another line, or when you click somewhere else in Obsidian (another note,
a sidebar); switching to another app doesn't count, so a half-written line waits. A pasted task line is converted
at once (except the one the cursor ends on). **Only lines with an `@` become
tasks**: a tracked task shows as a link with a checkbox and chips (dates, repetition, tags, sync state); a
plain `- [ ]` line stays an ordinary checklist item that lives only in its note.

**A task note** opens with a bar on top that stays while you scroll: its checkbox, deadline, repetition, next time
block, tags, sub-task progress. Click any of them to change it. The raw properties (ids and such) are hidden; the
list icon in the bar shows them.

**Changing a task**: click its priority, deadline, repetition or a tag: its field opens on the line with a list of
choices; pick one or type it (Escape keeps the old value; Backspace on the field's name takes the value off). Backspace right after the link selects the chip before
the cursor, a second one takes it off the task; ← and → (or a click between two chips) move the cursor among them. The pencil (shown when you hover the line) opens the task's form. Or type `@` after its link: `- [[Write the report]] @mon` moves the deadline, `@session thu 10am-12pm` adds
a time block, `@repeat never` stops the repetition, `@deadline never` removes the deadline, `@tag family` or
`#family` adds a tag; it applies once the field closes (a `#tag` when you leave the line) and cleans the line.

**The New task button** (ribbon, command palette, or the calendar's *+ New task*) opens a form: title, deadline,
time blocks, repetition, priority, tags (your vault's tags are suggested as you type). Dates are typed the same way (`fri 2pm`, `tue 2pm-4pm`) or picked from a calendar
(with a time for the deadline, from / to for a time block). Time blocks are listed: *to add* until you save, then
*planned*.

**Planning**: right-click a line with a task (or use the commands) → *Edit the task…* / *Block time…* /
*Change the deadline…*. In the
calendar, the *To plan* panel lists open tasks with no time block ahead: drag one onto a time slot (an hour, then
resize it) or a day (all day), or click it to type a slot.

**Tags** group tasks: `@tag family` (one tag per `@tag`; the assistant offers your vault's tags) or `#family` on a
task line goes into the task note's `tags` (Obsidian's own, so the tag pane and search see them), and leaves the
line, so the note you're writing in isn't tagged. Only the line's tags count: a task written in a `#family` note
doesn't get it. A `#tag` alone doesn't make a task (it takes an `@`). They're sent to the server as the reminder's
categories, and categories added elsewhere come back as tags.

**Sub-tasks**: a task written inside a task note becomes its child (`parent`). A sub-task always shows in its
parent's note: one that gets its parent another way (from another app, the `parent` property, Claude) is added there
as a `- [[Sub-task]]` line. Take that line out of the parent and the sub-task becomes a task of its own (it isn't
deleted); put it back (undo, paste) and it's a sub-task again. The iPhone shows them flat.

**The task list** is the Bases file written on first run (default `Tasks.base`), with *To do*,
*No deadline* (newest first), *By tag* and *Done* (the last ones done first) views. It's yours afterwards; *Regenerate the task list* in
the settings rewrites it with the default views (it asks first). *By tag* groups by the whole list (a task tagged
`#family` and `#urgent` is a group of its own, as Bases does it); for one tag, filter on `file.hasTag("family")`.
To list the tasks a note links to (or that link to it) inside that note, embed a base:

````markdown
```base
filters:
  and:
    - 'type == "task"'
    - or:
        - 'file.hasLink(this.file)'
        - 'this.file.hasLink(file)'
views:
  - type: table
    name: Tasks
    order: [done, file.name, due]
```
````

## Calendar

**Open the calendar** from the ribbon or the command palette. Month, week, day and list views; calendars can be
shown or hidden from the legend.

- **Deadlines** carry a flag (red once missed, ↻ when the task repeats); **time blocks** are dashed.
- **Click** an event for its card: open its note (created in `Calendar/` as `YYYY-MM-DD Title.md`), or its pencil
  to change it in a form (title, times to the minute, place, collection, the task it's a session for; one
  occurrence of a recurring event changes on its own), or its trash to delete it (one occurrence or the whole
  series). On a work session, its task's line opens the task's form; on a deadline, the pencil opens the task's
  form and the calendar button plans a session.
- **Drag or resize** an event to move it (one occurrence of a recurring event moves on its own). Dragging a
  deadline changes the task's due date.
- **Select a range** to create an event, or a work session for a task.
- **Right-click** an event to change or delete it, or to answer an invitation.
- **Video meetings** (Teams, Zoom, Google Meet, Webex…) show a camera; their card, their note and the right-click
  menu have *Join Teams* (or Zoom, Meet…), found in the event wherever its link is (Outlook puts Teams' in the
  description). A link to a service it doesn't know, in the place or the notes, gives *Join the meeting* (maps,
  documents and help pages aside).

Invitations you haven't answered are striped. Events copied from other accounts by a backend (they carry
`X-CALTASKS-SOURCE-ACCOUNT`) can only be answered, not edited.

## Claude

With [Claude Workspace](https://github.com/abdallah-hammad-dev/claude-workspace) installed (desktop), Claude Code
gets `calendar_*` tools: list events, find free time, create / move / delete events, answer invitations, list /
create / complete tasks, change their deadline or repetition, block time for a task, and get the note of an event
or task. It also sees which task or event note you're looking at, and gets a skill describing these conventions.

## Privacy

- The extension talks only to your CalDAV server. Nothing else, no telemetry.
- The password stays in Obsidian's keychain. Calendar data is cached per device in IndexedDB, not in the vault.

## Known limitations

- Apple Reminders shows sub-tasks flat, and doesn't show the link field: the link to the note is also written as
  the last line of the reminder's notes (setting).
- A task already completed the first time the extension sees it gets no note (it'd flood the vault with old
  reminders). Opening it from the phone still creates its note.
- Moving a whole recurring series is done on the phone; the calendar view moves one occurrence at a time.
- If your vault sync delivers a brand-new task note to a second device before the first one wrote its
  `caldav_uid`, the second device may create a duplicate reminder.

## Development

```sh
npm install
npm test                 # unit tests
npm run test:integration # against local CalDAV servers (see CLAUDE.md)
npm run build && npm run check:mobile
npm run ui:preview       # screenshots of the calendar and settings with Obsidian's stylesheet
```

The design is in [`docs/SPEC.md`](docs/SPEC.md).

## License

MIT
