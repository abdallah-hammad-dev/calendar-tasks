/**
 * UI preview scenarios, rendered with Obsidian's real app.css in Chromium by shoot.mjs.
 * ?scenario=<name>&theme=light|dark&lang=fr|en
 */
import { CalendarView, type CalendarHost } from "../../src/calendar/CalendarView";
import { expandItem } from "../../src/calendar/expand";
import { chipModel, type ChipModel } from "../../src/editor/chips";
import { DateSuggest } from "../../src/editor/date-suggest";
import { TaskModal } from "../../src/tasks/modals";
import { ConfirmModal, NewEventModal } from "../../src/calendar/modals";
import { t } from "../../src/i18n";
import { localValue } from "../../src/calendar/when-fields";
import { renderTaskHeader } from "../../src/editor/task-header";
import { renderEventHeader } from "../../src/editor/event-header";
import { DatePickerModal } from "../../src/editor/date-picker";
import { renderCheckbox, renderChips } from "../../src/editor/render";
import { DEFAULT_SETTINGS, SettingsTab, type SettingsHost } from "../../src/settings";
import type { TaskInfo } from "../../src/tasks/task-index";

const q = new URLSearchParams(location.search);
const scenario = q.get("scenario") ?? "calendar-week";
document.body.classList.add(q.get("theme") === "dark" ? "theme-dark" : "theme-light");
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
  ["https://c/perso/", ev("w", "Point Olera", "20261012T100000", "20261012T110000", "RRULE:FREQ=WEEKLY;COUNT=8\r\n")],
  ["https://c/perso/", ev("s", "Séminaire", "20261014T090000", "20261014T123000", "LOCATION:Salle 3\r\n")],
  ["https://c/perso/", ics("BEGIN:VEVENT\r\nUID:trip\r\nSUMMARY:Lyon\r\nDTSTART;VALUE=DATE:20261016\r\nDTEND;VALUE=DATE:20261018\r\nEND:VEVENT\r\n")],
  ["https://c/ecole/", ev("c1", "Cours réseau", "20261013T083000", "20261013T103000", "RRULE:FREQ=WEEKLY;COUNT=10\r\n")],
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
  ["https://c/perso/", ev("call", "Appel Paul", "20261015T103500", "20261015T105000")],
  // A work session under an invitation, and all-day deadlines.
  ["https://c/perso/", ev("blk2", "Rédiger le mémoire", "20261016T090000", "20261016T120000", "RELATED-TO:t8\r\n")],
  ["https://c/perso/", ev("blk3", "Relire le plan", "20261013T143500", "20261013T150500", "RELATED-TO:t8\r\n")],
  ["https://c/taches/", todo("t8", "Rédiger le mémoire", "20261023T180000")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t9\r\nSUMMARY:Acheter du lait\r\nDUE;VALUE=DATE:20261017\r\nEND:VTODO\r\n")],
  ["https://c/taches/", ics("BEGIN:VTODO\r\nUID:t10\r\nSUMMARY:Appeler la banque\r\nDUE;VALUE=DATE:20261015\r\nEND:VTODO\r\n")],
];
// The week after, for the task form's day preview.
ITEMS.push(
  ["https://c/perso/", ev("team", "Réunion d'équipe", "20261022T093000", "20261022T103000")],
  ["https://c/ecole/", ev("cours2", "Cours réseau", "20261022T110000", "20261022T123000")],
  ["https://c/perso/", ev("dentist", "Dentiste", "20261023T170000", "20261023T174500")],
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

function calendar(view: "timeGridWeek" | "dayGridMonth" | "listWeek"): void {
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
    sync: () => undefined,
    language: () => q.get("lang") ?? "fr",
    initialDate: () => "2026-10-15",
    editable: (o) => o.kind !== "deadline" && !o.invitation,
    move: async (_o, start, end) => {
      (window as unknown as { __moved: string }).__moved = `${start.toString().slice(16, 21)}-${end?.toString().slice(16, 21) ?? ""}`;
      return true;
    },
    newEvent: (start, end, allDay) => ({
      when: { start: localValue(start, allDay), end: localValue(end, allDay), allDay },
      calendars: { a: "Perso", b: "Travail" },
      calendarUrl: "a",
      tasks: [{ uid: "1", title: "Rédiger le mémoire" }],
      submit: () => undefined,
    }),
    menu: () => undefined,
    planTasks: () => [
      { path: "a", title: "Envoyer le devis", priority: "high", due: { text: "14 oct.", overdue: true }, blocks: 0 },
      { path: "d", title: "Préparer slides", priority: "medium", due: { text: "15 oct.", overdue: false }, blocks: 2 },
      { path: "b", title: "Rendre le mémoire", priority: null, due: { text: "23 oct.", overdue: false }, blocks: 1 },
      { path: "c", title: "Appeler la banque", priority: "low", due: null, blocks: 0 },
    ],
    planUnplannedOnly: () => q.get("only") === "1",
    setPlanUnplannedOnly: () => undefined,
    plan: () => undefined,
    pickSlot: () => undefined,
    newTask: () => undefined,
    planPanelOpen: () => view === "timeGridWeek",
    setPlanPanelOpen: () => undefined,
    task: (uid) => TASKS[uid] ?? null,
    toggleTask: () => undefined,
    rsvp: () => undefined,
    savedView: () => null,
    saveView: () => undefined,
  };
  const leaf = { app: { workspace: { on: () => ({}) }, loadLocalStorage: () => null, saveLocalStorage: () => undefined } };
  const v = new CalendarView(leaf as never, host);
  (window as unknown as { __reveal: (id: string, start: string) => void }).__reveal = (id, start) => v.reveal(id, start);
  v.containerEl.style.height = "100vh";
  document.body.appendChild(v.containerEl);
  void v.onOpen().then(() => {
    if (view !== "timeGridWeek") (v as unknown as { calendar: { changeView(v: string): void } }).calendar.changeView(view);
    setTimeout(done, 300);
  });
}

function taskLinks(): void {
  const now = new Date("2026-10-15T10:00:00Z");
  const t = (o: Partial<TaskInfo>): TaskInfo => ({
    path: "", basename: "", done: false, due: null, repeat: null, priority: null, uid: "u", projectPath: null, parentPath: null, collection: null, ...o,
  });
  const words = { today: "Aujourd'hui", tomorrow: "Demain" };
  const model = (task: TaskInfo, extra: Partial<Parameters<typeof chipModel>[1]> = {}): ChipModel =>
    chipModel(task, { contextProject: null, children: [], sync: "synced", now, tz: TZ, lang: "fr", words, ...extra });
  const labels = {
    due: "Deadline", pending: "En attente de synchro", local: "Pas encore sur le serveur", toggle: "Cocher / décocher", edit: "Cliquer pour modifier",
    priority: { high: "Haute", medium: "Moyenne", low: "Basse" },
  };
  const rows: [string, ChipModel][] = [
    ["Préparer slides", model(t({ path: "Tâches/Préparer slides.md", priority: "high", due: "2026-10-15T18:00", projectPath: "Projets/Olera.md" }), { children: [t({ done: true }), t({})] })],
    ["Sport", model(t({ path: "Tâches/Sport.md", due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" }))],
    ["Rendre rapport", model(t({ path: "Tâches/Rendre rapport.md", priority: "medium", due: "2026-10-13", projectPath: "Projets/Cours réseau.md" }))],
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

function settings(): void {
  const host = {
    settings: { ...DEFAULT_SETTINGS, serverUrl: "https://dav.example.com/dav/", username: "abd", tasksFolder: "Tâches", eventsFolder: "Calendrier", projectTag: "projet" },
    saveSettings: async () => undefined,
    testConnection: async () => undefined,
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
    projects: [{ path: "Projets/Olera.md", name: "Olera", collection: "Pro" }],
    project: "Projets/Olera.md",
    collections: ["Général", "Pro", "École"],
    collection: "Pro",
    focus: "due",
    edit: {
      title: "Rédiger le mémoire",
      due: "2026-10-23T18:00",
      repeat: "FREQ=WEEKLY",
      priority: "high",
      project: "Projets/Olera.md",
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
  new NewEventModal({} as never, {
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

/** The "New task" form, filled in. */
function newTask(): void {
  const modal = new TaskModal({} as never, {
    projects: [
      { path: "Projets/Olera.md", name: "Olera", collection: "Pro" },
      { path: "Projets/Cours réseau.md", name: "Cours réseau", collection: "École" },
    ],
    project: "Projets/Olera.md",
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
  done();
}

/** The task form with the day it's being placed on: a slot typed among the day's events, a deadline. */
function taskPreview(): void {
  const modal = new TaskModal({} as never, {
    projects: [],
    project: null,
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

/** A task note open in reading view: the header above the page, properties hidden. */
function taskNote(): void {
  const leaf = document.body.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "markdown" } });
  Object.assign(leaf.style, { height: "100vh", display: "flex", flexDirection: "column" });
  leaf.createDiv({ cls: "view-header", text: "" }).style.height = "40px";
  const content = leaf.createDiv({ cls: "view-content ct-task-view" });
  content.style.flex = "1";
  const header = renderTaskHeader(
    {
      done: false,
      priority: { level: "high", label: "Priorité haute" },
      due: { text: "Demain 18:00", overdue: false },
      repeat: null,
      project: { name: "Olera", path: "Projets/Olera.md" },
      parent: null,
      progress: "1/3",
      blocks: [
        { label: "mar. 20 oct. 14:00–16:00", start: "2026-10-20T14:00" },
        { label: "jeu. 22 oct. 10:00–12:00", start: "2026-10-22T10:00" },
      ],
      sync: null,
    },
    { toggle: () => undefined, edit: () => undefined, open: () => undefined, block: () => undefined, showBlock: () => undefined, properties: { shown: false, toggle: () => undefined } },
    {
      todo: "À faire", done: "Terminée", deadline: "Deadline", addBlock: "Ajouter un créneau", repeat: "Répétition",
      project: "Projet", parent: "Tâche parente", progress: "Sous-tâches faites", edit: "Modifier la tâche…",
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

/** An event note: its header (when, repetition, place, collection, the answer to an invitation), no properties. */
function eventNote(): void {
  const leaf = document.body.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "markdown" } });
  Object.assign(leaf.style, { height: "100vh", display: "flex", flexDirection: "column" });
  leaf.createDiv({ cls: "view-header", text: "" }).style.height = "40px";
  const content = leaf.createDiv({ cls: "view-content ct-task-view" });
  content.style.flex = "1";
  const revealed = () => ((window as unknown as { __revealed: number }).__revealed = 1);
  content.appendChild(
    renderEventHeader(
      {
        when: "mardi 13 octobre · 07:00 – 10:30",
        calendar: { name: "École", color: "#E5484D" },
        repeats: true,
        location: "Salle B204",
        invitation: { partstat: null },
        gone: false,
      },
      { reveal: revealed, rsvp: () => undefined, properties: { shown: false, toggle: () => undefined } },
      {
        reveal: "Voir dans le calendrier (pour le déplacer)",
        repeats: "Se répète",
        gone: "Plus dans le calendrier",
        answers: { ACCEPTED: "Accepter", TENTATIVE: "Peut-être", DECLINED: "Refuser" },
        showProperties: "Afficher les propriétés",
        hideProperties: "Masquer les propriétés",
      },
    ),
  );
  const reading = content.createDiv({ cls: "markdown-reading-view" });
  const page = reading.createDiv({ cls: "markdown-preview-view markdown-rendered is-readable-line-width" });
  const sizer = page.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
  sizer.createDiv({ cls: "inline-title", text: "13-10-2026 Cours réseau" });
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
  const popup = new DateSuggest({} as never, { task: () => null, edit: () => undefined });
  const editing = { path: "Tâches/Sport.md", due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" };
  ["", "deadline ven ", "créneau chaque mardi ", "edit:"].forEach((col_typed, col) => {
    const edit = col_typed.startsWith("edit:");
    const typed = edit ? col_typed.slice(5) : col_typed;
    (popup as unknown as { editing: unknown }).editing = edit ? editing : null;
    const left = 16 + col * 420;
    const line = document.body.createDiv({ cls: "markdown-source-view mod-cm6" }).createDiv({ cls: "cm-line" });
    Object.assign(line.style, { position: "absolute", left: `${left}px`, top: "12px" });
    line.setText(edit ? `- [[Sport]] @${typed}` : `- [ ] Rendre le rapport @${typed}`);
    const box = document.body.createDiv({ cls: "suggestion-container" });
    Object.assign(box.style, { position: "absolute", left: `${left}px`, top: "48px", width: "400px" });
    const list = box.createDiv({ cls: "suggestion" });
    popup.getSuggestions({ query: typed } as never).forEach((s, i) => {
      const item = list.createDiv({ cls: i === 0 ? "suggestion-item is-selected" : "suggestion-item" });
      popup.renderSuggestion(s, item);
    });
  });
  done();
}

if (["calendar-week", "calendar-interact", "calendar-card", "calendar-group", "calendar-edit", "calendar-time", "calendar-zoom", "calendar-new"].includes(scenario)) calendar("timeGridWeek");
else if (scenario === "calendar-list") calendar("listWeek");
else if (scenario === "calendar-month") calendar("dayGridMonth");
else if (scenario === "task-links") taskLinks();
else if (scenario === "settings") settings();
else if (scenario === "date-suggest") dateSuggest();
else if (scenario === "new-task") newTask();
else if (scenario === "edit-task") editTask();
else if (scenario === "edit-task-menu") editTask(true);
else if (scenario === "new-event") newEvent();
else if (scenario === "task-preview") taskPreview();
else if (scenario === "confirm-delete") confirmDelete();
else if (scenario === "date-picker") datePicker();
else if (scenario === "slot-picker") slotPicker();
else if (scenario === "task-note") taskNote();
else if (scenario === "event-note") eventNote();
