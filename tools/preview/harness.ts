/**
 * UI preview scenarios, rendered with Obsidian's real app.css in Chromium by shoot.mjs.
 * ?scenario=<name>&theme=light|dark&lang=fr|en
 */
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { editorInfoField, Menu, setIcon } from "obsidian";
import { CalendarView, type CalendarHost } from "../../src/calendar/CalendarView";
import { wholeDevicePixels } from "../../src/calendar/device-pixels";
import { expandItem } from "../../src/calendar/expand";
import { editEvent, moveEvent, setPartstat } from "../../src/calendar/vevent";
import { writeTask } from "../../src/tasks/vtodo";
import { chipModel, type ChipModel } from "../../src/editor/chips";
import { DateSuggest } from "../../src/editor/date-suggest";
import { TaskModal } from "../../src/tasks/modals";
import { ConfirmModal, EventModal } from "../../src/calendar/modals";
import { t } from "../../src/i18n";
import { localValue } from "../../src/calendar/when-fields";
import { renderTaskHeader } from "../../src/editor/task-header";
import { renderEventHeader } from "../../src/editor/event-header";
import { DatePickerModal } from "../../src/editor/date-picker";
import { renderCheckbox, renderChips } from "../../src/editor/render";
import { refreshTaskDecorations, taskEditorExtension } from "../../src/editor/live-preview";
import { chipFieldText, openChipField, type ChipKey } from "../../src/editor/fields-state";
import { parseLinkLine } from "../../src/editor/convert";
import { findWhen } from "../../src/editor/when";
import { DEFAULT_SETTINGS, SettingsTab, type SettingsHost } from "../../src/settings";
import type { TaskInfo } from "../../src/tasks/task-index";

const q = new URLSearchParams(location.search);
const scenario = q.get("scenario") ?? "calendar-week";
document.body.classList.add(q.get("theme") === "dark" ? "theme-dark" : "theme-light");
// "phone-…" scenarios (shoot.mjs adds `phone=1`): Obsidian on an iPhone, its floating header and navbar included.
const phone = q.get("phone") === "1";
if (phone) {
  document.body.classList.add("is-mobile", "is-phone", "is-ios", "is-floating-nav");
  document.body.style.setProperty("--safe-area-inset-top", "47px");
  document.body.style.setProperty("--safe-area-inset-bottom", "34px");
}
const TZ = "Europe/Paris";
const done = () => ((window as unknown as { __ready: boolean }).__ready = true);

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//p//p//EN\r\n${body}END:VCALENDAR\r\n`;
const ev = (uid: string, summary: string, start: string, end: string, extra = "") =>
  ics(`BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART;TZID=Europe/Paris:${start}\r\nDTEND;TZID=Europe/Paris:${end}\r\n${extra}END:VEVENT\r\n`);
const todo = (uid: string, summary: string, due: string, extra = "") =>
  ics(`BEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDUE;TZID=Europe/Paris:${due}\r\n${extra}END:VTODO\r\n`);

// "calendar-edit": every calendar in the same blue, as the bench server has them (the marks still differ).
const mono = scenario === "calendar-edit";
const CALS = [
  { url: "https://c/taches/", name: "Rappels", color: mono ? "#007AFF" : "#3fb68b", hidden: false, readOnly: false },
  { url: "https://c/perso/", name: "Perso", color: mono ? "#0088FF" : "#4f8cff", hidden: false, readOnly: false },
  { url: "https://c/ecole/", name: "École (mirror)", color: mono ? "#007AFF" : "#e2725b", hidden: false, readOnly: true },
];
const ITEMS: [string, string][] = [
  // A Teams meeting as Outlook writes it (the link in the description), and a Zoom link as the place.
  ["https://c/perso/", ev("w", "Point Olera", "20261012T100000", "20261012T110000",
    "RRULE:FREQ=WEEKLY;COUNT=8\r\nDESCRIPTION:Réunion Microsoft Teams\\nCliquez ici pour participer à la réunion<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0>\r\n")],
  ["https://c/perso/", ev("s", "Séminaire", "20261014T090000", "20261014T123000", "LOCATION:Salle 3\r\n")],
  ["https://c/perso/", ics("BEGIN:VEVENT\r\nUID:trip\r\nSUMMARY:Lyon\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261018\r\nEND:VEVENT\r\n")],
  ["https://c/ecole/", ev("c1", "Cours réseau", "20261013T083000", "20261013T103000", "RRULE:FREQ=WEEKLY;COUNT=10\r\n")],
  // A deadline right after an event starts: beside it, not over its title.
  ["https://c/taches/", todo("t12", "Imprimer les grilles", "20261013T083500")],
  ["https://c/ecole/", ev("inv", "Jury de projet", "20261015T140000", "20261015T153000",
    "ORGANIZER:mailto:prof@uni.edu\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:abd@bench.test\r\n")],
  ["https://c/ecole/", ev("inv2", "Réunion pédagogique", "20261016T110000", "20261016T120000",
    "ORGANIZER:mailto:prof@uni.edu\r\nATTENDEE;PARTSTAT=TENTATIVE:mailto:abd@bench.test\r\n")],
  ["https://c/taches/", todo("t1", "Préparer slides", "20261015T180000")],
  ["https://c/taches/", todo("t2", "Rendre rapport", "20261013T120000", "STATUS:COMPLETED\r\n")],
  ["https://c/taches/", todo("t3", "Envoyer le devis", "20261014T120000")],
  ["https://c/perso/", ev("blk", "Préparer slides", "20261015T160000", "20261015T174500", "RELATED-TO:t1\r\n")],
  // Three deadlines too close to draw apart (one already done): one "3 tâches" marker.
  ["https://c/taches/", todo("t4", "Relancer Paul pour le devis", "20261014T160000")],
  ["https://c/taches/", todo("t5", "Payer la facture", "20261014T160000", "STATUS:COMPLETED\r\n")],
  ["https://c/taches/", todo("t6", "Imprimer le poster", "20261014T161000")],
  // Minutes that aren't on the half hour.
  ["https://c/taches/", todo("t7", "Réserver la salle", "20261016T143500")],
  ["https://c/perso/", ev("cafe", "Café avec Léa", "20261016T154500", "20261016T163000")],
  ["https://c/perso/", ev("call", "Appel Paul", "20261015T103500", "20261015T105000", "LOCATION:https://us02web.zoom.us/j/81234567890\r\n")],
  // A work session under an invitation, and all-day deadlines.
  ["https://c/perso/", ev("blk2", "Rédiger le mémoire", "20261016T090000", "20261016T120000", "RELATED-TO:t8\r\n")],
  ["https://c/perso/", ev("blk3", "Relire le plan", "20261013T143500", "20261013T150500", "RELATED-TO:t8\r\n")],
  ["https://c/taches/", todo("t8", "Rédiger le mémoire", "20261023T180000")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t9\r\nSUMMARY:Acheter du lait\r\nDUE;VALUE=DATE:20261017\r\nEND:VTODO\r\n")],
  // A work session all day: a line in the month, like an all-day deadline.
  ["https://c/perso/", ics("BEGIN:VEVENT\r\nUID:blk4\r\nSUMMARY:Relire le chapitre 2\r\nRELATED-TO:t8\r\nDTSTART;VALUE=DATE:20261017\r\nDTEND;VALUE=DATE:20261018\r\nEND:VEVENT\r\n")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t10\r\nSUMMARY:Appeler la banque\r\nDUE;VALUE=DATE:20261015\r\nEND:VTODO\r\n")],
];
// The week after, for the task form's day preview.
ITEMS.push(
  // Over two days: on the second, what has a time sits under its bar, a little apart (the month).
  ["https://c/perso/", ics("BEGIN:VEVENT\r\nUID:fair\r\nSUMMARY:Salon\r\nDTSTART;VALUE=DATE:20261019\r\nDTEND;VALUE=DATE:20261021\r\nEND:VEVENT\r\n")],
  ["https://c/perso/", ev("team", "Réunion d'équipe", "20261022T093000", "20261022T103000")],
  ["https://c/ecole/", ev("cours2", "Cours réseau", "20261022T110000", "20261022T123000")],
  ["https://c/perso/", ev("dentist", "Dentiste", "20261023T170000", "20261023T174500")],
  // A session all day between two deadlines by title: in the month, the day's deadlines, then its session (the week
  // after the one the drag previews use, so their all-day row keeps its height).
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t13\r\nSUMMARY:Acheter des timbres\r\nDUE;VALUE=DATE:20261024\r\nEND:VTODO\r\n")],
  ["https://c/perso/", ics("BEGIN:VEVENT\r\nUID:blk5\r\nSUMMARY:Ranger le bureau\r\nRELATED-TO:t8\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nEND:VEVENT\r\n")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t14\r\nSUMMARY:Trier les photos\r\nDUE;VALUE=DATE:20261024\r\nEND:VTODO\r\n")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t11\r\nSUMMARY:Envoyer le compte rendu\r\nDUE;TZID=Europe/Paris:20261023T160000\r\nEND:VTODO\r\n")],
);
const occurrencesFor = (from: Date, to: Date) =>
  ITEMS.flatMap(([cal], i) => expandItem(`${cal}${i}.ics`, cal, ITEMS[i]![1], { from, to, tz: TZ, me: ["abd@bench.test"] }));

const TASKS: Record<string, { title: string; done: boolean }> = {
  t1: { title: "Préparer slides", done: false },
  t2: { title: "Rendre rapport", done: true },
  t5: { title: "Payer la facture", done: true },
  t8: { title: "Rédiger le mémoire", done: false },
};

/**
 * A view's `.workspace-leaf-content` as Obsidian lays it out on an iPhone: in the root split, under the floating
 * header (sidebar, title, "…"), above the floating navbar. What the view draws under either is hidden for real.
 */
function phoneFrame(content: HTMLElement): void {
  const root = document.body.createDiv({ cls: "workspace" }).createDiv({ cls: "workspace-split mod-root" });
  const tabs = root.createDiv({ cls: "workspace-tabs mod-top mod-active mod-visible" });
  tabs.style.flex = "1";
  const leaf = tabs.createDiv({ cls: "workspace-tab-container" }).createDiv({ cls: "workspace-leaf mod-active" });
  leaf.appendChild(content);
  content.style.height = "100%";
  const header = createDiv({ cls: "view-header" });
  content.prepend(header);
  const action = (parent: HTMLElement, icon: string) => setIcon(parent.createDiv({ cls: "clickable-icon view-action" }), icon);
  action(header.createDiv({ cls: "view-header-left" }), "sidebar-left");
  header.createDiv({ cls: "view-header-title-container" }).createDiv({ cls: "view-header-title", text: t("view.calendar") });
  action(header.createDiv({ cls: "view-actions" }), "more-horizontal");
  const navbar = document.body.createDiv({ cls: "mobile-navbar" }).createDiv({ cls: "mobile-navbar-actions" });
  for (const icon of ["chevron-left", "chevron-right", "search", "plus", "copy", "menu"]) {
    setIcon(navbar.createDiv({ cls: "mobile-navbar-action" }).createEl("button", { cls: "clickable-icon" }), icon);
  }
}

/** `inTab`: inside an Obsidian tab beside a sidebar, whose `contain: strict` shifts `position: fixed` children. */
function calendar(view: "timeGridWeek" | "timeGridDay" | "dayGridMonth" | "listWeek", inTab = false): void {
  const queued = new Set<string>();
  let panelOpen = view === "timeGridWeek" || scenario === "phone-panel";
  // "calendar-drag": moves are written as the plugin writes them: the data changes at once (a deadline's reminder
  // too, TaskSync.setDue), the view redraws, then again once pushed. A redraw from elsewhere comes right after (a
  // sync ending, another move): what was dropped must stay.
  const drag = scenario === "calendar-drag" || scenario === "calendar-month-drag";
  const realMove = (o: Parameters<CalendarHost["move"]>[0], start: Date, end: Date | null, allDay: boolean) => {
    const i = ITEMS.findIndex(([cal], j) => `${cal}${j}.ics` === o.itemUrl);
    const local = (d: Date) => localValue(d, allDay);
    setTimeout(() => v.refresh(), 100);
    if (o.kind === "deadline") {
      ITEMS[i]![1] = writeTask(ITEMS[i]![1], { due: local(start) }, { tz: TZ });
      setTimeout(() => v.refresh(), 200);
      return;
    }
    const fallback = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
    ITEMS[i]![1] = moveEvent(ITEMS[i]![1], o.recurring ? o.recurrenceId : null, local(start), local(end ?? fallback), TZ);
    v.refresh();
    setTimeout(() => v.refresh(), 600);
  };
  const host: CalendarHost = {
    occurrences: (from, to) =>
      ITEMS.flatMap(([cal], i) => expandItem(`${cal}${i}.ics`, cal, ITEMS[i]![1], { from, to, tz: TZ, me: ["abd@bench.test"] })),
    calendars: () => CALS,
    toggleCalendar: () => undefined,
    updateCalendar: async () => true,
    createCalendar: async (spec) => {
      (window as unknown as { __created: string }).__created = `${spec.displayName}|${spec.color}|${spec.components.join()}`;
      return true;
    },
    deleteCalendar: (url) => ((window as unknown as { __deleted: string }).__deleted = url),
    open: () => undefined,
    // Invitations have no note yet ("Create the note"), the other events have one ("Open the note").
    hasNote: (o) => !o.invitation,
    syncState: (o) => (queued.has(o.itemUrl) ? "queued" : "synced"),
    sync: () => undefined,
    language: () => q.get("lang") ?? "fr",
    initialDate: () => "2026-10-15",
    editable: (o) => (drag ? !CALS.find((c) => c.url === o.calendarUrl)?.readOnly && !o.invitation : o.kind !== "deadline" && !o.invitation),
    move: async (o, start, end, allDay) => {
      (window as unknown as { __moved: string }).__moved = `${start.toString().slice(16, 21)}-${end?.toString().slice(16, 21) ?? ""}`;
      if (drag) realMove(o, start, end, allDay);
      return true;
    },
    newEvent: (start, end, allDay) => ({
      when: { start: localValue(start, allDay), end: localValue(end, allDay), allDay },
      calendars: { a: "Perso", b: "Travail" },
      calendarUrl: "a",
      tasks: [{ uid: "1", title: "Rédiger le mémoire" }],
      submit: () => undefined,
    }),
    // As the plugin does (`main.editEventOptions`): the form filled in, its changes written in place, drawn at once.
    editEvent: (o) => ({
      when: { start: o.start, end: o.end ?? o.start, allDay: o.allDay },
      calendars: { "https://c/perso/": "Perso", "https://c/taches/": "Rappels" },
      calendarUrl: o.calendarUrl,
      tasks: [{ uid: "t8", title: "Rédiger le mémoire" }, { uid: "t1", title: "Préparer slides" }],
      edit: { title: o.title, location: o.location ?? "", taskUid: o.taskUid, series: o.recurring },
      submit: (c) => {
        const i = ITEMS.findIndex(([cal], j) => `${cal}${j}.ics` === o.itemUrl);
        const when = c.when;
        ITEMS[i]![1] = editEvent(ITEMS[i]![1], o.recurring ? o.recurrenceId : null, { summary: c.title, start: when.start, end: when.end ?? when.start, location: c.location || null }, TZ);
        v.refresh();
      },
    }),
    editTask: (uid) => ((window as unknown as { __editTask: string }).__editTask = uid),
    pickSlotFor: (uid) => ((window as unknown as { __pickSlot: string }).__pickSlot = uid),
    remove: (o, all) => ((window as unknown as { __removed: string }).__removed = `${o.title}|${all ? "all" : "one"}`),
    // The right-click menu, one item: enough to see what a click elsewhere does.
    menu: (_o, e, edit) => new Menu().addItem((i) => i.setTitle(t("menu.edit")).onClick(edit)).showAtMouseEvent(e),
    planTasks: () => [
      { path: "a", title: "Envoyer le devis", priority: "high", due: { text: "14 oct.", overdue: true }, blocks: 0 },
      { path: "d", title: "Préparer slides", priority: "medium", due: { text: "15 oct.", overdue: false }, blocks: 2 },
      { path: "b", title: "Rendre le mémoire", priority: null, due: { text: "23 oct.", overdue: false }, blocks: 1 },
      { path: "c", title: "Appeler la banque", priority: "low", due: null, blocks: 0 },
    ],
    planUnplannedOnly: () => q.get("only") === "1",
    setPlanUnplannedOnly: () => undefined,
    // As the plugin does (`main.plan`): an hour (or the day) from the drop, a session of that task, drawn at once.
    plan: (path, start, allDay) => {
      const title = host.planTasks().find((p) => p.path === path)?.title ?? path;
      const end = new Date(start.getTime() + (allDay ? 86_400_000 : 3_600_000));
      const blank = ev(`planned-${ITEMS.length}`, title, "20261001T000000", "20261001T010000", `RELATED-TO:${path}\r\n`);
      ITEMS.push(["https://c/perso/", moveEvent(blank, null, localValue(start, allDay), localValue(end, allDay), TZ)]);
      v.refresh();
    },
    pickSlot: () => undefined,
    newTask: () => undefined,
    planPanelOpen: () => panelOpen,
    setPlanPanelOpen: (open) => (panelOpen = open),
    task: (uid) => TASKS[uid] ?? null,
    toggleTask: () => undefined,
    // As in the plugin: the answer is written and queued (the view redraws), then pushed (it redraws again).
    rsvp: (o, ps) => {
      const i = ITEMS.findIndex(([cal], j) => `${cal}${j}.ics` === o.itemUrl);
      ITEMS[i]![1] = setPartstat(ITEMS[i]![1], ["abd@bench.test"], ps)!;
      queued.add(o.itemUrl);
      v.refresh();
      setTimeout(() => {
        queued.delete(o.itemUrl);
        v.refresh();
      }, 400);
    },
    savedView: () => null,
    saveView: () => undefined,
  };
  const leaf = { app: { workspace: { on: () => ({}), getActiveViewOfType: () => v }, loadLocalStorage: () => null, saveLocalStorage: () => undefined } };
  const v = new CalendarView(leaf as never, host);
  (window as unknown as { __reveal: (id: string, start: string) => void }).__reveal = (id, start) => v.reveal(id, start);
  v.containerEl.style.height = "100vh";
  if (phone) phoneFrame(v.containerEl);
  else if (inTab) {
    const tab = document.body.createDiv({ cls: "workspace-leaf" });
    Object.assign(tab.style, { position: "fixed", top: "40px", left: "260px", right: "0", bottom: "0" });
    v.containerEl.style.height = "100%";
    tab.appendChild(v.containerEl);
  } else document.body.appendChild(v.containerEl);
  void v.onOpen().then(() => {
    if (view !== "timeGridWeek") (v as unknown as { calendar: { changeView(v: string): void } }).calendar.changeView(view);
    // A phone's "⋯" (Obsidian's view menu, a sheet), and the collections it opens.
    if (scenario === "phone-more") {
      const menu = new Menu();
      v.onPaneMenu(menu, "more-options");
      menu.showAtPosition({ x: 0, y: 0 });
    }
    if (scenario === "phone-collections") (v as unknown as { openCollections(): void }).openCollections();
    setTimeout(done, 300);
  });
}

function taskLinks(): void {
  const now = new Date("2026-10-15T10:00:00Z");
  const t = (o: Partial<TaskInfo>): TaskInfo => ({
    path: "", basename: "", done: false, due: null, repeat: null, priority: null, uid: "u", tags: [], parentPath: null, links: [], collection: null, created: null, completed: null, completions: [], ...o,
  });
  const words = { today: "Aujourd'hui", tomorrow: "Demain" };
  const model = (task: TaskInfo, extra: Partial<Parameters<typeof chipModel>[1]> = {}): ChipModel =>
    chipModel(task, { contextTags: [], children: [], sync: "synced", now, tz: TZ, lang: "fr", words, ...extra });
  const labels = {
    due: "Deadline", pending: "En attente de synchro", local: "Pas encore sur le serveur", toggle: "Cocher / décocher", edit: "Cliquer pour modifier",
    priority: { high: "Haute", medium: "Moyenne", low: "Basse" },
  };
  const rows: [string, ChipModel][] = [
    ["Préparer slides", model(t({ path: "Tâches/Préparer slides.md", priority: "high", due: "2026-10-15T18:00", tags: ["olera"] }), { children: [t({ done: true }), t({})] })],
    ["Sport", model(t({ path: "Tâches/Sport.md", due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" }))],
    ["Rendre rapport", model(t({ path: "Tâches/Rendre rapport.md", priority: "medium", due: "2026-10-13", tags: ["cours", "urgent"] }))],
    ["Appeler Paul", model(t({ path: "Tâches/Appeler Paul.md", priority: "low", due: "2026-10-16T09:30" }), { sync: "pending" })],
    ["Acheter du café", model(t({ path: "Tâches/Acheter du café.md", done: true, due: "2026-10-14" }))],
    ["Réserver salle", model(t({ path: "Tâches/Réserver salle.md" }), { sync: "local" })],
  ];
  const view = document.body.createDiv({ cls: "markdown-reading-view" });
  view.style.padding = "24px 32px";
  const page = view.createDiv({ cls: "markdown-preview-view markdown-rendered" });
  page.createEl("h2", { text: "Olera — réunion du 14/10" });
  page.createEl("p", { text: "À faire cette semaine :" });
  const ul = page.createEl("ul");
  for (const [name, m] of rows) {
    const li = ul.createEl("li");
    const a = li.createEl("a", { cls: "internal-link", text: name, href: name });
    if (m.done) a.classList.add("ct-task-done");
    a.before(renderCheckbox(m, labels, () => undefined));
    a.after(renderChips(m, labels, () => undefined));
  }
  // The first row as if hovered: its pencil shows.
  ul.querySelector<HTMLElement>(".ct-chip-edit")?.style.setProperty("opacity", "1");
  page.createEl("p", { text: "Petites étapes (pas des tâches) :" });
  const steps = page.createEl("ul", { cls: "contains-task-list" });
  for (const [text, checked] of [["Relire le plan", true], ["Exporter en PDF", false]] as const) {
    const li = steps.createEl("li", { cls: "task-list-item" });
    const box = li.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" }) as HTMLInputElement;
    box.checked = checked;
    li.appendText(` ${text}`);
  }
  done();
}

/**
 * A real editor (CodeMirror, our extension) on a note with a task line being typed and a task already made: what
 * the line shows while an `@` is typed (a field), once it has its value (a block), and the chips of the task.
 * The page clock is Thursday 15/10/2026 11:00. Records in `window.__fields`.
 */
function taskFields(): void {
  const today = { year: 2026, month: 10, day: 15 };
  const labels = {
    due: "Deadline", pending: "En attente de synchro", local: "Pas encore sur le serveur", toggle: "Cocher / décocher", edit: "Cliquer pour modifier",
    priority: { high: "Haute", medium: "Moyenne", low: "Basse" },
  };
  let task: TaskInfo = {
    path: "Tâches/Rapport.md", basename: "Rapport", done: false, due: "2026-10-16T09:30", repeat: null, priority: "medium", uid: "u", tags: ["famille", "urgent"],
    parentPath: null, links: [], collection: null, created: null, completed: null, completions: [],
  };
  const log = { removed: [] as string[], form: [] as string[], left: [] as string[], closed: [] as string[] };
  (window as unknown as { __fields: typeof log }).__fields = log;
  const model = () => chipModel(task, { contextTags: [], children: [], sync: "synced", now: new Date(), tz: TZ, lang: "fr", words: { today: "Aujourd'hui", tomorrow: "Demain" } });
  const keys = (): ChipKey[] => [...(task.priority ? ["priority" as const] : []), ...(task.due ? ["due" as const] : []), ...task.tags.map((tag) => `tag:${tag}` as const)];
  const page = document.body.createDiv({ cls: "markdown-source-view mod-cm6 is-live-preview" });
  page.style.padding = "24px 32px";
  const view = new EditorView({
    parent: page,
    state: EditorState.create({
      // The last line as written before its chips had a space of their own.
      doc: "À faire cette semaine :\n- [ ] Appeler mamie \n- [[Rapport]] \n- [ ] Réviser le partiel\n- [[Rapport]]",
      extensions: [
        EditorView.lineWrapping,
        keymap.of(defaultKeymap), // Backspace and the rest, as in Obsidian
        editorInfoField.init(() => ({ file: { path: "Notes/Olera.md" } })),
        taskEditorExtension({
          model: (linkpath) => (linkpath === "Rapport" ? model() : null),
          toggle: () => undefined,
          checkbox: (m) => renderCheckbox(m, labels, () => undefined),
          chips: (m, marks) =>
            renderChips(
              m,
              labels,
              (_path, focus, el, key) => {
                const text = key ? chipFieldText(task, key, "fr", today) : null;
                const root = el.closest<HTMLElement>(".cm-editor");
                const v = root && EditorView.findFromDOM(root);
                if (!text || !key || !v) return void log.form.push(String(focus));
                v.dispatch(openChipField(v.state, v.posAtDOM(el), key, text));
                v.focus();
              },
              marks,
            ),
          lineLeft: (_v, _from, text) => void log.left.push(text),
          fieldClosed: (v, from, text, _path, replaces) => {
            log.closed.push(`${text}|${replaces ?? ""}`);
            // As the plugin does: the `@` goes to the task and leaves the line.
            const link = parseLinkLine(text);
            const found = link && findWhen(text.slice(link.end), today);
            if (!link || (!found && text.slice(link.end).trim())) return;
            queueMicrotask(() => {
              if (found?.when.due) task = { ...task, due: found.when.due };
              v.dispatch({ changes: { from: from + link.end, to: from + text.length, insert: " " }, selection: { anchor: from + link.end + 1 } });
              refreshTaskDecorations();
            });
          },
          chipKeys: () => keys(),
          openList: () => undefined,
          removeChip: (_text, _path, key) => {
            log.removed.push(key);
            if (key === "priority") task = { ...task, priority: null };
            else if (key === "due") task = { ...task, due: null };
            else task = { ...task, tags: task.tags.filter((tag) => `tag:${tag}` !== key) };
            queueMicrotask(refreshTaskDecorations);
          },
          fields: {
            today: () => today,
            lang: () => "fr",
            knownTags: () => KNOWN_TAGS,
            chipValue: (_state, _line, key) => {
              const has = key === "priority" ? task.priority : key === "due" ? task.due : key === "repeat" ? task.repeat : null;
              return has ? { text: chipFieldText(task, key, "fr", today)?.value ?? null } : null;
            },
          },
        }),
      ],
    }),
  });
  (window as unknown as { __view: EditorView }).__view = view;
  done();
}

function settings(): void {
  const host = {
    settings: { ...DEFAULT_SETTINGS, serverUrl: "https://dav.example.com/dav/", username: "abd", tasksFolder: "Tâches", eventsFolder: "Calendrier" },
    saveSettings: async () => undefined,
    testConnection: async () => undefined,
    regenerateTaskBase: () => undefined,
    collections: () => ({ "https://c/general/": "Général", "https://c/pro/": "Pro", "https://c/ecole/": "École" }),
  } as unknown as SettingsHost;
  const tab = new SettingsTab({} as never, host);
  const modal = document.body.createDiv({ cls: "modal mod-settings cw-preview-settings" });
  const container = modal.createDiv({ cls: "vertical-tab-content-container" });
  container.appendChild(tab.containerEl);
  tab.update();
  tab.display();
  done();
}

/** The task form on a task already made, opened from its deadline chip; `menu`: its repeat menu open. */
function editTask(menu = false): void {
  const modal = new TaskModal({} as never, {
    knownTags: KNOWN_TAGS,
    collections: ["Général", "Pro", "École"],
    collection: "Pro",
    focus: "due",
    edit: {
      title: "Rédiger le mémoire",
      due: "2026-10-23T18:00",
      repeat: "FREQ=WEEKLY",
      priority: "high",
      tags: ["olera"],
      collection: "Pro",
      planned: [
        { label: "mar. 20 oct. 14:00–16:00", start: "2026-10-20T14:00" },
        { label: "jeu. 22 oct. 10:00–12:00", start: "2026-10-22T10:00" },
      ],
    },
    submit: () => undefined,
  });
  modal.open();
  if (menu) modal.contentEl.querySelector<HTMLElement>(".ct-select")?.click();
  done();
}

/** Deleting a collection: what it holds, what becomes of the notes. */
function confirmDelete(): void {
  new ConfirmModal({} as never, {
    title: t("cal.deleteTitle", { name: "Tests" }),
    lines: [t("cal.deleteHolds", { what: `${t("cal.count.events", { n: 12 })}${t("cal.and")}${t("cal.count.task")}` }), t("cal.deleteAll"), t("cal.deleteNotes")],
    action: t("menu.delete"),
    run: () => undefined,
  }).open();
  done();
}

/** Creating an event from a selected range in the calendar. */
function newEvent(): void {
  new EventModal({} as never, {
    when: { start: "2026-10-20T14:00", end: "2026-10-20T15:00", allDay: false },
    calendars: { a: "Perso", b: "Travail" },
    calendarUrl: "a",
    tasks: [
      { uid: "1", title: "Rédiger le mémoire" },
      { uid: "2", title: "Appeler la banque" },
    ],
    submit: () => undefined,
  }).open();
  done();
}

/** The vault's tags, most used first (what the task form suggests). */
const KNOWN_TAGS = ["olera", "famille", "urgent", "cours", "maison", "projets/factures"];

/** The "New task" form, filled in; `tags`: a tag being typed, the vault's suggested. */
function newTask(tags = false): void {
  const modal = new TaskModal({} as never, {
    knownTags: KNOWN_TAGS,
    collections: ["Général", "Pro", "École"],
    collection: "Pro",
    submit: () => undefined,
  });
  modal.open();
  const inputs = modal.contentEl.querySelectorAll<HTMLInputElement>("input[type=text], input:not([type])");
  const fill = (i: number, v: string) => {
    const el = inputs[i];
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event("input"));
  };
  // Title; deadline day, time; time block day, from, to.
  fill(0, "Rédiger le mémoire");
  fill(1, "ven");
  fill(2, "18h");
  fill(3, "mar");
  fill(4, "14h");
  fill(5, "16h");
  inputs[5]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  fill(3, "jeu");
  fill(4, "10h");
  fill(6, tags ? "#olera #f" : "#olera");
  if (tags) inputs[6]?.focus();
  done();
}

/**
 * The task form on a phone with the keyboard up (Obsidian says its height in `--keyboard-height`), typing a tag:
 * the field and its suggestions must show above the keyboard, Cancel / Create too.
 */
function newTaskKeyboard(): void {
  document.documentElement.style.setProperty("--keyboard-height", "336px");
  const keyboard = document.body.createDiv();
  Object.assign(keyboard.style, { position: "fixed", left: "0", right: "0", bottom: "0", height: "336px", background: "#5a5a5f", zIndex: "1000", opacity: "0.9" });
  const modal = new TaskModal({} as never, { knownTags: KNOWN_TAGS, collections: ["Général", "Pro"], collection: "Pro", submit: () => undefined });
  modal.open();
  const tags = modal.contentEl.querySelector<HTMLInputElement>(".ct-task-tags-input")!;
  // Tapped once the form is open (it focuses its title first).
  setTimeout(() => tags.focus(), 50);
  setTimeout(() => {
    tags.value = "#f";
    tags.dispatchEvent(new Event("input"));
    done();
  }, 600);
}

/** The task form with the day it's being placed on: a slot typed among the day's events, a deadline. */
function taskPreview(): void {
  const modal = new TaskModal({} as never, {
    knownTags: [],
    collections: ["Général", "Pro"],
    collection: "Général",
    submit: () => undefined,
    preview: {
      occurrences: occurrencesFor,
      color: (url) => CALS.find((c) => c.url === url)?.color ?? null,
      language: () => "fr",
    },
  });
  modal.open();
  const inputs = modal.contentEl.querySelectorAll<HTMLInputElement>("input[type=text], input:not([type])");
  const fill = (i: number, v: string) => {
    const el = inputs[i];
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event("input"));
  };
  fill(0, "Préparer la démo");
  fill(1, "23/10/2026");
  fill(2, "18h");
  fill(3, "22/10/2026");
  fill(4, "10h");
  fill(5, "11h30");
  window.setTimeout(done, 400);
}

/** The date picker for a deadline: a few days after today, at 14h; it can be taken off. */
function datePicker(): void {
  new DatePickerModal({} as never, {
    mode: "due",
    value: "2026-10-23T14:00",
    pick: () => undefined,
    remove: { label: "Pas de deadline", run: () => undefined },
  }).open();
  done();
}

/**
 * A task note open in reading view: the header above the page, properties hidden. `short`: a deadline and a tag
 * only, so the creation date has room (the full header has none: it must hide, not wrap).
 * A task note's header: full, short, done ("Faite hier" by its checkbox), or repeating (the last time it was done,
 * every time in a menu).
 */
function taskNote(kind: "full" | "short" | "done" | "repeat" = "full"): void {
  const short = kind !== "full";
  const leaf = document.body.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "markdown" } });
  Object.assign(leaf.style, { height: "100vh", display: "flex", flexDirection: "column" });
  leaf.createDiv({ cls: "view-header", text: "" }).style.height = "40px";
  const content = leaf.createDiv({ cls: "view-content ct-task-view" });
  content.style.flex = "1";
  const header = renderTaskHeader(
    {
      done: kind === "done",
      priority: short ? null : { level: "high", label: "Priorité haute" },
      due: kind === "repeat" ? { text: "Lun. 2 nov.", overdue: false } : { text: "Demain 18:00", overdue: false },
      repeat: kind === "repeat" ? "chaque lundi" : null,
      tags: ["olera"],
      parent: null,
      progress: short ? null : "1/3",
      blocks: short
        ? []
        : [
            { label: "mar. 20 oct. 14:00–16:00", start: "2026-10-20T14:00" },
            { label: "jeu. 22 oct. 10:00–12:00", start: "2026-10-22T10:00" },
          ],
      sync: null,
      created: { text: "Créée hier", tooltip: "Créée le mardi 20 octobre 2026 à 21:40" },
      completed: kind === "done" ? { text: "Faite hier", tooltip: "Faite le samedi 24 octobre 2026 à 14:32" } : null,
      history:
        kind === "repeat"
          ? [
              ["26 oct.", "lundi 26 octobre 2026 à 19:15"],
              ["19 oct.", "lundi 19 octobre 2026 à 20:02"],
              ["13 oct.", "mardi 13 octobre 2026 à 08:40"],
              ["5 oct.", "lundi 5 octobre 2026 à 18:30"],
              ["28 sept.", "lundi 28 septembre 2026 à 19:00"],
              ["21 sept.", "lundi 21 septembre 2026 à 21:10"],
            ].map(([day, full]) => ({ day: day!, full: full! }))
          : null,
    },
    { toggle: () => undefined, edit: () => undefined, open: () => undefined, block: () => undefined, showBlock: () => undefined, properties: { shown: false, toggle: () => undefined } },
    {
      todo: "À faire", done: "Terminée", deadline: "Deadline", addBlock: "Ajouter une session", repeat: "Répétition",
      tags: "Tags", parent: "Tâche parente", progress: "Sous-tâches faites", history: "Les fois où elle a été faite", edit: "Modifier la tâche…",
      showProperties: "Afficher les propriétés", hideProperties: "Masquer les propriétés", pending: "", local: "",
    },
  );
  content.appendChild(header);
  const reading = content.createDiv({ cls: "markdown-reading-view" });
  const page = reading.createDiv({ cls: "markdown-preview-view markdown-rendered is-readable-line-width" });
  const sizer = page.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
  sizer.createDiv({ cls: "inline-title", text: "Rédiger le mémoire" });
  const props = sizer.createDiv({ cls: "metadata-container" });
  props.setText("caldav_uid: 8f3c…  (hidden)");
  sizer.createEl("p", { text: "Plan : intro, état de l'art, méthode, résultats." });
  const ul = sizer.createEl("ul", { cls: "contains-task-list" });
  for (const [text, checked] of [["Relire le chapitre 2", true], ["Faire les figures", false], ["Envoyer à Paul", false]] as const) {
    const li = ul.createEl("li", { cls: "task-list-item" });
    const box = li.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox" }) as HTMLInputElement;
    box.checked = checked;
    li.appendText(` ${text}`);
  }
  for (let i = 0; i < 6; i++) sizer.createEl("p", { text: "Notes de travail, liens, idées…" });
  done();
}

/**
 * An event note: its header (when, repetition, place, collection, the answer to an invitation), no properties.
 * Declined, it says it's hidden and keeps the answer; deleted, only the note's times and a button to delete it.
 */
function eventNote(missing: "declined" | "deleted" | null = null): void {
  const leaf = document.body.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "markdown" } });
  Object.assign(leaf.style, { height: "100vh", display: "flex", flexDirection: "column" });
  leaf.createDiv({ cls: "view-header", text: "" }).style.height = "40px";
  const content = leaf.createDiv({ cls: "view-content ct-task-view" });
  content.style.flex = "1";
  const win = window as unknown as { __revealed: number; __deleted: number };
  const there = missing !== "deleted";
  content.appendChild(
    renderEventHeader(
      {
        when: there ? "mardi 13 octobre · 07:00 – 10:30" : "lundi 19 octobre · 10:00 – 11:00",
        calendar: there ? { name: "École", color: "#E5484D" } : null,
        repeats: there && !missing,
        meeting: there && !missing ? { text: "Rejoindre Teams", host: "teams.microsoft.com", url: "https://teams.microsoft.com/l/meetup-join/x" } : null,
        location: there ? "Salle B204" : null,
        invitation: there ? { partstat: missing === "declined" ? "DECLINED" : null } : null,
        missing,
      },
      {
        reveal: () => (win.__revealed = 1),
        rsvp: () => undefined,
        deleteNote: () => (win.__deleted = 1),
        properties: { shown: false, toggle: () => undefined },
      },
      {
        reveal: "Voir dans le calendrier (pour le déplacer)",
        repeats: "Se répète",
        declined: "Refusée : masquée du calendrier",
        deleted: "Événement supprimé du calendrier",
        deleteNote: "Supprimer la note",
        answers: { ACCEPTED: "Accepter", TENTATIVE: "Peut-être", DECLINED: "Refuser" },
        showProperties: "Afficher les propriétés",
        hideProperties: "Masquer les propriétés",
      },
    ),
  );
  const reading = content.createDiv({ cls: "markdown-reading-view" });
  const page = reading.createDiv({ cls: "markdown-preview-view markdown-rendered is-readable-line-width" });
  const sizer = page.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
  sizer.createDiv({ cls: "inline-title", text: there ? "13-10-2026 Cours réseau" : "19-10-2026 Point projet" });
  sizer.createEl("p", { text: "Notes du cours…" });
  done();
}

/** The date picker for a time block: a day, from 14h to 16h. */
function slotPicker(): void {
  new DatePickerModal({} as never, { mode: "slot", value: { start: "2026-10-25T14:00", end: "2026-10-25T16:00" }, pick: () => undefined }).open();
  done();
}

/**
 * The @ assistant at four moments: just `@`, a deadline's day chosen, a slot that comes back, and `@` after the
 * link of a task already made (changing it).
 */
function dateSuggest(): void {
  const popup = new DateSuggest({} as never, { task: () => null, edit: () => undefined, knownTags: () => KNOWN_TAGS });
  const editing = { path: "Tâches/Sport.md", due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" };
  // A phone: one under the other, as wide as Obsidian lets them be there (its own max-width and max-height).
  const states = phone ? ["", "deadline ven ", "session chaque mardi ", "edit:"] : ["", "deadline ven ", "session chaque mardi ", "tag ", "priorité ", "edit:"];
  states.forEach((col_typed, col) => {
    const edit = col_typed.startsWith("edit:");
    const typed = edit ? col_typed.slice(5) : col_typed;
    (popup as unknown as { editing: unknown }).editing = edit ? editing : null;
    const left = phone ? 10 : 16 + col * 420;
    const top = phone ? 12 + col * 300 : 12;
    const line = document.body.createDiv({ cls: "markdown-source-view mod-cm6" }).createDiv({ cls: "cm-line" });
    Object.assign(line.style, { position: "absolute", left: `${left}px`, top: `${top}px` });
    line.setText(edit ? `- [[Sport]] @${typed}` : `- [ ] Rendre le rapport @${typed}`);
    const box = document.body.createDiv({ cls: "suggestion-container" });
    Object.assign(box.style, { position: "absolute", left: `${left}px`, top: `${top + 36}px` }); // as wide as it needs, as in Obsidian
    if (!phone) box.style.maxWidth = "400px";
    const list = box.createDiv({ cls: "suggestion" });
    popup.getSuggestions({ query: typed, editor: {} } as never).forEach((s, i) => {
      const item = list.createDiv({ cls: i === 0 ? "suggestion-item is-selected" : "suggestion-item" });
      popup.renderSuggestion(s, item);
    });
  });
  done();
}

// As the plugin does when it loads: the calendar's dots and bars in whole device pixels.
wholeDevicePixels(window);

if (["calendar-week", "calendar-drag", "calendar-interact", "calendar-card", "calendar-group", "calendar-edit", "calendar-time", "calendar-zoom", "calendar-new"].includes(scenario)) calendar("timeGridWeek");
else if (scenario === "calendar-list" || scenario === "calendar-list-narrow") calendar("listWeek");
else if (scenario === "calendar-month" || scenario === "calendar-month-narrow" || scenario.startsWith("calendar-marks-month")) calendar("dayGridMonth");
else if (scenario.startsWith("calendar-marks-week")) calendar("timeGridWeek");
else if (scenario.startsWith("calendar-marks-list")) calendar("listWeek");
else if (scenario === "calendar-month-drag") calendar("dayGridMonth", true);
else if (scenario === "phone-month") calendar("dayGridMonth");
else if (scenario === "phone-day") calendar("timeGridDay");
else if (scenario === "phone-list") calendar("listWeek");
else if (scenario === "phone-panel") calendar("timeGridDay");
else if (scenario === "phone-views" || scenario === "phone-add" || scenario === "phone-more" || scenario === "phone-collections") calendar("dayGridMonth");
else if (scenario === "phone-new-task-keyboard") newTaskKeyboard();
else if (scenario === "phone-new-task") newTask();
else if (scenario === "phone-task-preview") taskPreview();
else if (scenario === "phone-edit-task") editTask();
else if (scenario === "phone-new-event") newEvent();
else if (scenario === "phone-date-picker") datePicker();
else if (scenario === "phone-slot-picker") slotPicker();
else if (scenario === "phone-task-note") taskNote();
else if (scenario === "phone-event-note") eventNote();
else if (scenario === "phone-settings") settings();
else if (scenario === "phone-date-suggest") dateSuggest();
else if (scenario === "phone-task-links") taskLinks();
else if (scenario === "phone-task-fields") taskFields();
else if (scenario === "task-links") taskLinks();
else if (scenario === "task-fields") taskFields();
else if (scenario === "settings") settings();
else if (scenario === "date-suggest") dateSuggest();
else if (scenario === "new-task") newTask();
else if (scenario === "new-task-tags") newTask(true);
else if (scenario === "edit-task") editTask();
else if (scenario === "edit-task-menu") editTask(true);
else if (scenario === "new-event") newEvent();
else if (scenario === "task-preview") taskPreview();
else if (scenario === "confirm-delete") confirmDelete();
else if (scenario === "date-picker") datePicker();
else if (scenario === "slot-picker") slotPicker();
else if (scenario === "task-note") taskNote();
else if (scenario === "task-note-short") taskNote("short");
else if (scenario === "task-note-done") taskNote("done");
else if (scenario === "task-note-repeat" || scenario === "task-note-repeat-narrow") taskNote("repeat");
else if (scenario === "event-note") eventNote();
else if (scenario === "event-note-declined") eventNote("declined");
else if (scenario === "event-note-deleted") eventNote("deleted");
