import { SuggestModal, type App } from "obsidian";
import { language, t } from "../i18n";
import { localZone, wallClock } from "../ical/time";
import type { Ymd } from "../editor/date-token";
import { dateText, parseDate, repeatLabel, suggestAt, untilOf, withUntil } from "../editor/when";
import type { SelectOption } from "./menu-select";

/**
 * How a task or an event comes back, in a form: a menu of repetitions (and "Custom…", typed), then its last day,
 * "Until", a day field shown only while it repeats (2026-11-04, the user: "tous les lundi mais seulement entre tel
 * mois et mois", for tasks as for events: "comme ça c'est aligné").
 */

const lang = (): "fr" | "en" => (language().startsWith("fr") ? "fr" : "en");
const today = () => wallClock(new Date(), localZone());
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The repetitions the menu offers (the rest is typed: "Custom…"). */
export const REPEATS = [
  "FREQ=DAILY",
  "FREQ=WEEKLY",
  "FREQ=WEEKLY;INTERVAL=2",
  "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  "FREQ=MONTHLY",
  "FREQ=YEARLY",
];

export const repeatOption = (rule: string): SelectOption => ({ value: rule, label: capital(repeatLabel(rule, lang()) ?? rule) });

/** "Never", the usual ones, and `pattern` when it's none of them. */
export function repeatOptions(pattern: string | null): SelectOption[] {
  const options = [{ value: "", label: t("modal.repeat.never") }, ...REPEATS.map(repeatOption)];
  if (pattern && !REPEATS.includes(pattern)) options.push(repeatOption(pattern));
  return options;
}

/** A rule as two fields: how it comes back, and its last day. */
export function splitRule(rule: string | null): { pattern: string | null; until: Ymd | null } {
  if (!rule) return { pattern: null, until: null };
  // A number of times (COUNT, which no form here writes) stays part of how it comes back, shown as it is.
  if (/(^|;)COUNT=/i.test(rule)) return { pattern: rule, until: null };
  return { pattern: withUntil(rule, null), until: untilOf(rule) };
}

/** The last day as its field shows it ("15/6/2027"), "" for none. */
export function untilText(until: Ymd | null): string {
  return until ? dateText(`${until.year}-${String(until.month).padStart(2, "0")}-${String(until.day).padStart(2, "0")}`) : "";
}

/**
 * What the last day's field holds: nothing (no end), a day, or something not understood. A day before `first`
 * (the first time it comes) is said too.
 */
export function readUntil(text: string, first: string | null): { until: Ymd | null; error: string | null } {
  if (!text.trim()) return { until: null, error: null };
  const value = parseDate(text.trim(), today());
  if (!value || value.length !== 10) return { until: null, error: t("picker.dayInvalid") };
  const until = { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
  if (first && value < first.slice(0, 10)) return { until, error: t("modal.untilBefore") };
  return { until, error: null };
}

/** Picks a repetition by typing it: "chaque lundi et jeudi", "tous les 3 jours", "toutes les 2 semaines"… */
export class RepeatPickerModal extends SuggestModal<{ label: string; rule: string }> {
  constructor(
    app: App,
    private readonly opts: { placeholder: string; pick: (rule: string) => void },
  ) {
    super(app);
    this.setPlaceholder(opts.placeholder);
  }

  getSuggestions(query: string): { label: string; rule: string }[] {
    const typed = `repeter ${query}`;
    const res = suggestAt(typed, today(), lang());
    if (!res) return [];
    const seen = new Set<string>();
    const out: { label: string; rule: string }[] = [];
    for (const i of res.items) {
      const rule = i.kind !== "more" ? i.when?.repeat : null;
      if (!rule || seen.has(rule)) continue;
      seen.add(rule);
      out.push({ label: (i.kind === "accept" ? typed : typed.slice(0, res.from) + i.text).replace(/^repeter\s*/, "").trim(), rule });
    }
    return out;
  }

  renderSuggestion(item: { label: string; rule: string }, el: HTMLElement): void {
    el.addClass("ct-date-suggestion");
    el.createSpan({ cls: "ct-date-suggestion-label", text: item.label });
    el.createSpan({ cls: "ct-date-suggestion-day", text: repeatLabel(item.rule, lang()) ?? item.rule });
  }

  onChooseSuggestion(item: { label: string; rule: string }): void {
    this.opts.pick(item.rule);
  }
}
