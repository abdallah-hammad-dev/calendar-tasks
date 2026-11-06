# Calendar & Tasks for Obsidian

Your CalDAV calendar and tasks inside Obsidian: every task is a note, every event can have one, with a calendar
view and a task list. It syncs with the CalDAV server you already use, so the same calendar and tasks stay on your
phone and in your other apps.

> [!WARNING]
> **Vibe-coded. Use at your own risk.**
> I built this plugin by describing what I wanted to Claude Code and testing the result, not by writing the
> code myself. It's a personal tool that I use on my own vault and calendar every day, and share as is. Don't
> expect a deep, low-level understanding of the code from me, quick fixes, or support. It creates, rewrites and
> deletes notes in your vault and items on your calendar server, so try it on a test vault (or a backed-up one)
> and a test calendar first.

## What it does

- **Tasks are notes.** Each task is a note in `Tasks/`: its deadline, repetition, priority and tags are properties,
  synced as a reminder on your server. The note's body is yours (context, links, drawings) and never leaves the
  vault.
- **Write a task anywhere.** A checklist line with an `@` becomes a task:
  `- [ ] Prepare slides @friday 2pm @tag work`. Wherever it's linked, the task shows its checkbox and its dates.
- **A deadline isn't time to work.** A task has one date, its deadline. Time set aside for it is a *session*: an
  event in your calendar, linked to the task (`@session tue 2pm-4pm`).
- **Task list.** An Obsidian [Bases](https://obsidian.md/help/bases) file (`Tasks.base`) with *To do*, *No
  deadline*, *By tag* and *Done* views. It's yours to change.
- **Calendar view.** Month, week, day and list, with your events, deadlines, sessions and invitations. Drag to move,
  select a range to create, and drop open tasks from the *To plan* panel onto a time slot.
- **Event notes.** Any event can have a note in `Calendar/` for your meeting notes (one per occurrence of a
  recurring event), made when you open it.
- **Invitations.** Accept, Maybe or Decline from the event's card. Unanswered invitations are striped, declined ones
  greyed and struck through (or hidden). Video meetings (Teams, Zoom, Meet, Webex…) get a *Join* button.
- **Back to the note from your phone.** Events and reminders carry a link that opens their note in Obsidian (e.g.
  tapped in Apple Calendar or Reminders).
- **Claude.** With [Claude Workspace](https://github.com/abdallah-hammad-dev/claude-workspace), Claude Code can
  read and change all of it. See [Claude](#claude).
- In English and French.

## Requirements

- Obsidian **1.13.2+**, desktop or mobile.
  - Tested on Linux, Windows and iPhone.
  - macOS and Android should work but are untested.
- A CalDAV server.
  - Tested with [Davis](https://github.com/tchapi/davis) and Radicale. Other standard servers (Nextcloud,
    Fastmail, iCloud with an app-specific password…) should work.
  - If your phone uses it too, it must be reachable **over HTTPS**: the iPhone refuses plain HTTP.
  - For your answers to invitations to reach the organizer, the server must support CalDAV scheduling (Davis and
    Nextcloud do, Radicale doesn't).

## Install

### With BRAT (recommended: one paste, automatic updates)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub repository and
keeps them up to date. It works on mobile too.

1. In Obsidian, open **Settings → Community plugins**, turn off Restricted mode, then **Browse**. Search for
   **BRAT**, then **Install** and **Enable** it.
2. Open the command palette (`Ctrl/Cmd + P`) and run **BRAT: Plugins: Add a beta plugin for testing (with or without version)**.
3. In **Repository**, paste:
   ```
   https://github.com/abdallah-hammad-dev/calendar-tasks
   ```
4. Keep **Latest version** and **Enable after installing the plugin**, then click **Add plugin**.
5. Connect your server: see [Setup](#setup).

**Updates:** BRAT checks for new versions every time Obsidian starts (on by default). To update right away, run
**BRAT: Plugins: Check for updates to all beta plugins and UPDATE**.

No GitHub token is needed: the repository is public.

### Manually, from a release

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/abdallah-hammad-dev/calendar-tasks/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/calendar-tasks/`.
3. In **Settings → Community plugins**, turn off Restricted mode and enable **Calendar & Tasks**.

Updates are manual: download the three files again.

### From source

Needs Node.js 20+:

```sh
git clone https://github.com/abdallah-hammad-dev/calendar-tasks.git
cd calendar-tasks
npm install
npm run build
mkdir -p "<your vault>/.obsidian/plugins/calendar-tasks"
cp main.js manifest.json styles.css "<your vault>/.obsidian/plugins/calendar-tasks/"
```

## Setup

In **Settings → Calendar & Tasks → CalDAV server**:

1. **Server address**: your server or account URL (e.g. `https://cal.example.com/dav/`).
2. **Username** and **Password**. The password goes into Obsidian's keychain, never into the vault.
3. **Test the connection**. Your calendars are listed, and syncing starts.

It syncs at startup, every 5 minutes (setting), when Obsidian comes back to the foreground, and right after each
change. **Calendar & Tasks: Sync now** forces it.

**On your phone**, add the same CalDAV account to your calendar and reminders apps. On an iPhone: Settings →
Calendar → Calendar Accounts → Add Account → Other → CalDAV, then turn on Calendars and Reminders. The phone shows
changes made in Obsidian at its next fetch (pull down in Calendar to force it).

## Writing tasks

A checklist line becomes a task once it has an `@` and you leave the line. Each `@` adds one thing:

```markdown
- [ ] Prepare slides @friday 2pm @tag work             ← deadline (a day right after @), a tag
- [ ] Write the report @fri @session tue 2pm-4pm       ← deadline + time set aside on Tuesday
- [ ] Gym @repeat every monday and thursday 7am        ← repeats
- [ ] Move house @session mon to wed                   ← whole days set aside
- [ ] Call the bank @task                              ← just the task (or a lone @)
```

In French: `@ven 14h` (or `@deadline ven 14h`), `@session mar 14h-16h`, `@répéter chaque lundi`,
`@session lun au mer`, `@tâche`.

- **The `@` assistant.** Typing `@` in a checklist line asks what to add (*Deadline*, *Session*, *Repeat*, *Tag*,
  *Priority*, *Create the task*), then offers values and shows what they mean.
- **Deadline:** `friday`, `tomorrow 2pm`, `15/10`, `15 october 2027`, `in 3 days`, `next monday`… or *Pick a
  date…*. It's the date your phone shows.
- **Session:** `tue 2pm-4pm`, `tue 2pm for 90min`, `tue morning`, `tue` (all day), `mon to wed`. A task can have
  several. `every tuesday 2pm-4pm` makes one that comes back, until the task is done.
- **Repeat:** `every week`, `every 2 days`, `every weekday`, `monthly`…, with a last day if it stops
  (`every monday until june 30`). Ticking a repeating task brings it back at its next date.
- **Priority:** `high`, `medium`, `low`.
- **Tags:** `@tag family` or `#family` on the line. They go into the task note's `tags` (the tag pane and search
  see them), not into the note you're writing in.

The line is replaced by a link to the task note, drawn with its checkbox and chips. Click a chip to change it, or
type `@` after the link (`- [[Write the report]] @mon` moves the deadline). A plain `- [ ]` line without an `@`
stays an ordinary checklist item.

**Other ways in:** the **New task** button (ribbon, command palette, or the calendar's *+ New*) opens a form. A
right-click on a task line offers *Edit the task…*, *Plan a session for the task…* and *Change the task's
deadline…*.

**A task note** opens with a bar on top: its checkbox, deadline, repetition, next session, tags and sub-tasks'
progress, each one clickable. A task written inside a task note becomes its sub-task.

**The task list** (`Tasks.base`) is written on first run; *Regenerate the task list* in settings rewrites it (it
asks first). To list, inside a note, the tasks it links to (or that link to it), embed a base:

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

## The calendar

Open it from the ribbon or with **Calendar & Tasks: Open the calendar**.

- **Deadlines** carry a flag (red once missed); **sessions** are dashed.
- **Click** an event for its card: open its note, change it (pencil) or delete it (trash: one occurrence or the
  whole series). **Right-click** for the same, and to answer an invitation.
- **Drag or resize** to move an event (one occurrence of a recurring event moves on its own). Dragging a deadline
  changes the task's due date.
- **Select a range** to create an event, or a session for a task.

**Events copied from your other accounts** (Google, Microsoft…) by a backend that writes them into your CalDAV
server can be answered or deleted, not edited. Deleting one asks first: it leaves your calendar, the original stays
on its account, and its organizer isn't told. Such a backend marks them with `X-CALTASKS-SOURCE-ACCOUNT`
(see [`docs/SPEC.md`](docs/SPEC.md) §4.6).

## Claude

With [Claude Workspace](https://github.com/abdallah-hammad-dev/claude-workspace) installed (desktop), Calendar &
Tasks adds a **Calendar & Tasks** module there:

- **Tools** (`calendar_*`): list events, find free time, create, move or delete events, answer invitations, list,
  create and tick tasks, change their deadline, repetition or priority, plan a session for a task, and find (or
  make) the note of an event or task.
- **Context:** Claude sees which task or event note you're looking at, and the range and event selected in the
  calendar.
- **Skill:** how tasks, sessions and event notes work in this vault, so Claude follows the same rules you do.

## What it changes in your vault

- **`Tasks/`**: one note per task. Reminders made elsewhere (your phone) get their note too, except ones already
  done when the plugin first sees them.
  - Deleting a task note deletes its reminder.
  - A reminder deleted elsewhere leaves its note, marked done and unlinked.
- **Task lines** you write are replaced by a link to their note (`- [[Prepare slides]]`).
- **`Calendar/`**: event notes, only the ones you open. Named `DD-MM-YYYY Title.md` (setting); a deleted event's
  note stays.
- **`Tasks.base`**: written once, then yours.
- **`.obsidian/plugins/calendar-tasks/data.json`**: the settings, without the password.
- **Outside the vault:** the password is in Obsidian's keychain. The calendar cache is kept per device (IndexedDB),
  so vault sync never mixes devices' caches.
- **On your server:** the events and reminders you make. A reminder's notes end with a link back to its note
  (setting).

## Safety and privacy

- The plugin talks only to your CalDAV server. No other service, no telemetry.
- Nothing is overwritten silently. If an item changed on the server and here at the same time:
  - a task is merged field by field;
  - an event keeps the server's version, and a notice says so;
  - your answer to an invitation and the occurrences you deleted are made again on the server's version.
- With Claude Workspace, Claude can create, change and delete your events and tasks, within the permission mode you
  give Claude Code.

## How it works

```
Obsidian ── Calendar & Tasks ──── CalDAV (HTTPS) ──── your server ──── phone, other apps
            task notes ⇄ VTODO                          ▲
            events, sessions ⇄ VEVENT                    └── optional backend: other accounts copied in
```

- **Dates live on the server; everything else in the notes.** A task note's properties mirror its reminder (a
  `VTODO`); its body never leaves the vault.
- **Sync** uses sync tokens (RFC 6578). Local changes are queued, work offline, and are pushed with `If-Match`, so
  the server says when an item changed elsewhere.
- **Recurring events** are expanded locally (ical.js); each occurrence can have its own note.

More detail: `CLAUDE.md` (architecture and decisions), [`docs/SPEC.md`](docs/SPEC.md) (the design) and
[`docs/releasing.md`](docs/releasing.md).

## Known limitations

- Apple Reminders shows sub-tasks flat and doesn't show the link field: the link to the note is also written as
  the last line of the reminder's notes (setting).
- Moving a whole recurring series is done in your phone's calendar; the calendar view moves one occurrence at a
  time.
- With several devices sharing the vault (e.g. LiveSync), give the vault the same name on each. A task note written
  by hand could otherwise get a second reminder on another device.

## Develop

```sh
npm install
npm test                 # unit tests (Vitest)
npm run lint
npm run build            # → main.js
npm run check:mobile     # the bundle loads on mobile
npm run test:integration # against local CalDAV servers (see CLAUDE.md)
npm run ui:preview       # screenshots of the calendar and settings with Obsidian's stylesheet
```

Try it in a test vault:

```sh
npm run deploy                                                        # into ./test-vault
TEST_VAULT=/mnt/c/Users/<you>/Documents/ct-test-vault npm run deploy  # Windows Obsidian, building from WSL
```

The deploy script refuses to write into a non-empty folder that isn't marked as a test vault.

Releasing a new version (also what BRAT users receive): see [`docs/releasing.md`](docs/releasing.md). In short,
`npm version patch` then `git push --follow-tags`.

## Credits

Built on [FullCalendar](https://fullcalendar.io) (MIT) for the calendar view and
[ical.js](https://github.com/kewisch/ical.js) (MPL-2.0) for iCalendar.

## License

[MIT](LICENSE). The software is provided "as is", without warranty of any kind.
