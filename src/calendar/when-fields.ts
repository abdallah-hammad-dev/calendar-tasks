import { hm } from "../editor/date-picker";
import { dateText, dayValue, readFields } from "../editor/when";
import { localZone, parseLocal, wallClock } from "../ical/time";
import { t } from "../i18n";
import { formRow } from "../ui/form-row";

/**
 * When something takes place, as local values: "2026-10-14T03:35" to the minute, or days ("2026-10-14", the end
 * exclusive). `end` null: a deadline, a moment.
 */
export interface When {
  start: string;
  end: string | null;
  allDay: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local value as a Date in this device's zone ("2026-10-14" is that day's midnight here, not in UTC). */
export function localDate(value: string): Date {
  const n = (a: number, b: number) => Number(value.slice(a, b));
  return new Date(n(0, 4), n(5, 7) - 1, n(8, 10), value.length > 10 ? n(11, 13) : 0, value.length > 10 ? n(14, 16) : 0);
}

/** A Date's local value: its day, and its time unless `allDay`. */
export function localValue(d: Date, allDay: boolean): string {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return allDay ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-14" moved by whole days (calendar days: no daylight saving surprises). */
export function shiftDays(day: string, n: number): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const days = (a: string, b: string) =>
  Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);

/** Ticking "All day": the days the times touch (an end at midnight doesn't take the next day). */
export function toAllDay(w: When): When {
  const start = w.start.slice(0, 10);
  if (w.end === null) return { start, end: null, allDay: true };
  const last = w.end.slice(0, 10);
  const end = w.end.slice(11) === "00:00" && last > start ? last : shiftDays(last, 1);
  return { start, end, allDay: true };
}

/** Unticking "All day": the same days at the given times (an hour if they don't make a range). */
export function toTimed(w: When, times: { start: string; end: string }): When {
  const start = `${w.start}T${times.start}`;
  if (w.end === null) return { start, end: null, allDay: false };
  let end = `${shiftDays(w.end, -1)}T${times.end}`;
  if (end <= start) end = localValue(new Date(localDate(start).getTime() + 3_600_000), false);
  return { start, end, allDay: false };
}

/** A new start, the length kept (a day count for whole days). */
export function moveStart(w: When, start: string): When {
  if (w.end === null) return { ...w, start };
  const end = w.allDay
    ? shiftDays(w.end, days(w.start, start))
    : localValue(new Date(localDate(w.end).getTime() + localDate(start).getTime() - localDate(w.start).getTime()), false);
  return { ...w, start, end };
}

/** A start, and an end after it. */
export const isValid = (w: When) => !!w.start && (w.end === null || (!!w.end && w.end > w.start));

/**
 * Start and end in a form's grid (spec §7.1): a day and a time each, one thing per field (2026-10-19: the date-time
 * fields opened the system's calendar and read as one), and "All day", which hides the times. Moving the start
 * keeps the length; what isn't understood, or an end not after the start, is marked. `onChange` gets each value,
 * null while it isn't valid. Returns the start's day field.
 */
export function renderWhenFields(el: HTMLElement, initial: When, onChange: (w: When | null) => void): HTMLInputElement {
  let w = { ...initial };
  // The times to come back to when "All day" is unticked.
  let times = { start: initial.allDay ? "09:00" : initial.start.slice(11), end: initial.allDay || !initial.end ? "10:00" : initial.end.slice(11) };
  const grid = el.hasClass("ct-form-grid") ? el : el.createDiv({ cls: "ct-form-grid" });
  const today = wallClock(new Date(), localZone());
  const pair = (icon: string | null, name: string) => {
    const field = formRow(grid, icon, name);
    field.addClass("ct-when-pair");
    const day = field.createEl("input", { cls: "ct-when-day", type: "text", attr: { placeholder: t("picker.day") } });
    const time = field.createEl("input", { cls: "ct-when-time", type: "text", attr: { placeholder: t("picker.time") } });
    day.spellcheck = time.spellcheck = false;
    return { day, time };
  };
  const start = w.end === null ? pair("flag", t("when.due")) : pair("clock", t("when.start"));
  const end = w.end === null ? null : pair(null, t("when.end"));
  const allDay = formRow(grid, null, "").createEl("label", { cls: "ct-when-allday" });
  const check = allDay.createEl("input", { type: "checkbox" });
  allDay.appendText(t("when.allDay"));

  const hmOf = (value: string) => {
    const p = parseLocal(value);
    return p && !p.allDay ? hm(p.wall) : "";
  };
  const show = () => {
    start.day.value = dateText(w.start.slice(0, 10));
    start.time.value = w.allDay ? "" : hmOf(w.start);
    if (end && w.end !== null) {
      end.day.value = dateText(w.allDay ? shiftDays(w.end, -1) : w.end.slice(0, 10));
      end.time.value = w.allDay ? "" : hmOf(w.end);
    }
    for (const f of [start, end]) {
      f?.time.toggle(!w.allDay);
      f?.day.removeClass("is-invalid");
      f?.time.removeClass("is-invalid");
    }
    check.checked = w.allDay;
  };
  /** A day and a time read on their own (`readFields`); null, and marked, while they don't make a moment. */
  const read = (f: { day: HTMLInputElement; time: HTMLInputElement }): string | null => {
    const r = readFields({ day: f.day.value, time: w.allDay ? "" : f.time.value }, today);
    f.day.toggleClass("is-invalid", !r.day);
    f.time.toggleClass("is-invalid", !w.allDay && !r.start);
    return r.day && (w.allDay || r.start) ? dayValue(r.day, w.allDay ? null : r.start) : null;
  };
  const report = () => {
    const ok = isValid(w);
    end?.day.toggleClass("is-invalid", !ok);
    end?.time.toggleClass("is-invalid", !ok && !w.allDay);
    onChange(ok ? { ...w } : null);
  };
  const onStart = () => {
    const value = read(start);
    if (!value) return onChange(null);
    w = moveStart(w, value);
    if (end && w.end !== null) {
      end.day.value = dateText(w.allDay ? shiftDays(w.end, -1) : w.end.slice(0, 10));
      end.time.value = w.allDay ? "" : hmOf(w.end);
    }
    report();
  };
  const onEnd = () => {
    if (!end) return;
    const value = read(end);
    if (!value) return onChange(null);
    w = { ...w, end: w.allDay ? shiftDays(value, 1) : value };
    report();
  };
  start.day.addEventListener("input", onStart);
  start.time.addEventListener("input", onStart);
  end?.day.addEventListener("input", onEnd);
  end?.time.addEventListener("input", onEnd);
  check.addEventListener("change", () => {
    if (!isValid(w)) return show();
    if (check.checked) {
      times = { start: w.start.slice(11), end: w.end?.slice(11) || times.end };
      w = toAllDay(w);
    } else w = toTimed(w, times);
    show();
    report();
  });
  show();
  return start.day;
}
