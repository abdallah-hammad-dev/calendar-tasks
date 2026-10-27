import ICAL from "ical.js";
import { formatLocalDate, formatLocalDateTime, parseLocal } from "../ical/time";
import { addDays, fold, resolveDate, suggestDates, WEEKDAYS, weekdayOf, type Ymd } from "./date-token";
import { isTag, sameTag } from "../tasks/tags";
import type { Priority } from "../constants";

/**
 * The `@` grammar (spec §5.2). Each `@` adds one thing to the task, named by a keyword, then its value:
 * `@deadline ven 14h`, `@session mar 14h-16h`, `@répéter chaque lundi`, `@tag famille`, `@priorité haute`, `@tâche` (the task
 * alone). Shortcuts: a
 * day straight after `@` is a deadline (`@demain`), a repetition is a repetition (`@chaque lundi`), and `@` alone
 * is `@tâche`. On a task already made, the same `@` changes it (`@deadline jamais`, `@répéter jamais` take things
 * off). French and English.
 */
export interface When {
  /** Deadline: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm". */
  due: string | null;
  /** RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO". */
  repeat: string | null;
  /** Time blocked for the task: events linked to it (RELATED-TO), not task fields. */
  blocks: Block[];
  /** What to take off a task (`@deadline jamais`: deadline and repetition; `@répéter jamais`: the repetition). */
  clear?: Cleared[];
  /** Tags to give it (`@tag famille`), as written, without "#". */
  tags?: string[];
  /** `@priorité haute`. */
  priority?: Priority;
}

export type Cleared = "due" | "repeat" | "priority";

/** A time slot: local values, end exclusive; all-day slots are dates. */
export interface Block {
  start: string;
  end: string;
  /** RRULE when the slot comes back (`@session chaque mardi 14h-16h`): a recurring event, from `start` on. */
  repeat?: string;
}

export type Feature = "due" | "block" | "repeat" | "tag" | "priority";

/** Keywords naming what an `@` adds (folded). */
const FEATURE_WORDS: Record<string, Feature> = {
  deadline: "due", due: "due", echeance: "due",
  session: "block",
  repeter: "repeat", repete: "repeat", repetition: "repeat", repeat: "repeat",
  tag: "tag", tags: "tag",
  priorite: "priority", priority: "priority", prio: "priority",
};

/** A priority's words (folded); `aucune` / `none` (or `jamais`) takes it off a task. */
const PRIORITY_WORDS: Record<string, Priority> = { haute: "high", high: "high", moyenne: "medium", medium: "medium", basse: "low", low: "low" };
const NO_PRIORITY = new Set(["aucune", "none"]);

export const NO_WHEN: When = { due: null, repeat: null, blocks: [] };

export type Hm = { hour: number; minute: number };

const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WORKWEEK = ["MO", "TU", "WE", "TH", "FR"];

const TIME_WORDS: Record<string, Hm> = {
  matin: { hour: 9, minute: 0 },
  morning: { hour: 9, minute: 0 },
  midi: { hour: 12, minute: 0 },
  noon: { hour: 12, minute: 0 },
  aprem: { hour: 14, minute: 0 },
  "apres-midi": { hour: 14, minute: 0 },
  afternoon: { hour: 14, minute: 0 },
  soir: { hour: 18, minute: 0 },
  evening: { hour: 18, minute: 0 },
};
const UNITS: Record<string, string> = {
  jour: "DAILY", jours: "DAILY", day: "DAILY", days: "DAILY",
  semaine: "WEEKLY", semaines: "WEEKLY", week: "WEEKLY", weeks: "WEEKLY",
  mois: "MONTHLY", month: "MONTHLY", months: "MONTHLY",
  an: "YEARLY", ans: "YEARLY", annee: "YEARLY", annees: "YEARLY", year: "YEARLY", years: "YEARLY",
};
const ADVERBS: Record<string, string> = {
  quotidien: "DAILY", quotidienne: "DAILY", daily: "DAILY",
  hebdo: "WEEKLY", hebdomadaire: "WEEKLY", weekly: "WEEKLY",
  mensuel: "MONTHLY", mensuelle: "MONTHLY", monthly: "MONTHLY",
  annuel: "YEARLY", annuelle: "YEARLY", yearly: "YEARLY", annually: "YEARLY",
};
const AT_WORDS = new Set(["a", "at"]);
const AND_WORDS = new Set(["et", "and"]);
/** `@tâche`: the line becomes a task, nothing more (2026-10-25: was `@sans date`, asked). */
const TASK_WORDS = new Set(["tache", "task"]);
const NEVER = new Set(["jamais", "never"]);

function weekday(w: string | undefined): number | null {
  if (!w) return null;
  if (w in WEEKDAYS) return WEEKDAYS[w]!;
  if (w.endsWith("s") && w.slice(0, -1) in WEEKDAYS) return WEEKDAYS[w.slice(0, -1)]!; // "lundis", "mondays"
  return null;
}

/** Month names (folded). No "mar": it's Tuesday in French. */
const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1, january: 1,
  fevrier: 2, fevr: 2, fev: 2, february: 2, feb: 2,
  mars: 3, march: 3,
  avril: 4, avr: 4, april: 4, apr: 4,
  mai: 5, may: 5,
  juin: 6, june: 6, jun: 6,
  juillet: 7, juil: 7, july: 7, jul: 7,
  aout: 8, august: 8, aug: 8,
  septembre: 9, sept: 9, sep: 9, september: 9,
  octobre: 10, oct: 10, october: 10,
  novembre: 11, nov: 11, november: 11,
  decembre: 12, dec: 12, december: 12,
};
const MONTH_NAMES = {
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
};

/** `15 octobre`, `1er oct 2027`, `oct 15`, `october 15 2027`: day + month (+ year). */
function namedDateAt(f: string[], i: number, today: Ymd): { date: Ymd; used: number } | null {
  const num = (w: string | undefined) => /^(\d{1,2})(?:er|st|nd|rd|th)?$/.exec(w ?? "")?.[1];
  let day = num(f[i]);
  let month = MONTHS[f[i + 1] ?? ""];
  if (!day || !month) {
    month = MONTHS[f[i] ?? ""];
    day = num(f[i + 1]);
  }
  if (!day || !month) return null;
  const year = /^\d{4}$/.test(f[i + 2] ?? "") ? f[i + 2] : null;
  const date = resolveDate(year ? `${day}/${month}/${year}` : `${day}/${month}`, today);
  return date ? { date, used: year ? 3 : 2 } : null;
}

/** A day starting at word `i`: the date and how many words it took. */
function dayAt(f: string[], i: number, today: Ymd): { date: Ymd; used: number } | null {
  const w = f[i];
  if (w === undefined) return null;
  if (w === "next" && weekday(f[i + 1]) !== null) {
    const date = resolveDate(f[i + 1]!, today);
    if (date) return { date, used: 2 };
  }
  if ((w === "dans" || w === "in") && /^\d{1,3}$/.test(f[i + 1] ?? "")) {
    const n = Number(f[i + 1]);
    const unit = UNITS[f[i + 2] ?? ""];
    if (unit === "DAILY") return { date: addDays(today, n), used: 3 };
    if (unit === "WEEKLY") return { date: addDays(today, 7 * n), used: 3 };
    if (unit === "MONTHLY") return { date: addMonths(today, n), used: 3 };
    return null;
  }
  const named = namedDateAt(f, i, today);
  if (named) return named;
  const date = resolveDate(w, today);
  if (!date) return null;
  const next = f[i + 1];
  return { date, used: weekday(w) !== null && (next === "prochain" || next === "prochaine") ? 2 : 1 };
}

function addMonths(d: Ymd, n: number): Ymd {
  const first = new Date(Date.UTC(d.year, d.month - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(d.day, last) };
}

/** A time starting at word `i`: 14h, 14h30, 14:30, 2pm, 2 pm, 2:30pm, matin, à 14h… */
function timeAt(f: string[], i: number): { time: Hm; used: number } | null {
  const w = f[i];
  if (w === undefined) return null;
  if (AT_WORDS.has(w)) {
    const t = timeAt(f, i + 1);
    return t && !AT_WORDS.has(f[i + 1]!) ? { time: t.time, used: t.used + 1 } : null;
  }
  if (w in TIME_WORDS) return { time: TIME_WORDS[w]!, used: 1 };
  const ok = (hour: number, minute: number) => (hour <= 23 && minute <= 59 ? { hour, minute } : null);
  const half = (hour: number, minute: number, ap: string) =>
    hour >= 1 && hour <= 12 && minute <= 59 ? { hour: (hour % 12) + (ap === "pm" ? 12 : 0), minute } : null;
  let m = /^(\d{1,2})h(\d{2})?$/.exec(w);
  if (m) {
    const t = ok(Number(m[1]), Number(m[2] ?? 0));
    return t && { time: t, used: 1 };
  }
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(w);
  if (m) {
    const t = half(Number(m[1]), Number(m[2] ?? 0), m[3]!);
    return t && { time: t, used: 1 };
  }
  m = /^(\d{1,2})(?::(\d{2}))?$/.exec(w);
  if (m && (f[i + 1] === "am" || f[i + 1] === "pm")) {
    const t = half(Number(m[1]), Number(m[2] ?? 0), f[i + 1]!);
    return t && { time: t, used: 2 };
  }
  if (m && m[2] !== undefined) {
    const t = ok(Number(m[1]), Number(m[2]));
    return t && { time: t, used: 1 };
  }
  return null;
}

/** A repetition starting at word `i`: chaque semaine, tous les 2 jours, every monday and thursday, en semaine… */
function repeatAt(f: string[], i: number): { rule: string; used: number } | null {
  const w = f[i];
  if (w === undefined) return null;
  if (w in ADVERBS) return { rule: `FREQ=${ADVERBS[w]}`, used: 1 };
  if (w === "en" && f[i + 1] === "semaine") return { rule: `FREQ=WEEKLY;BYDAY=${WORKWEEK.join(",")}`, used: 2 };
  if (w === "weekdays") return { rule: `FREQ=WEEKLY;BYDAY=${WORKWEEK.join(",")}`, used: 1 };
  let j: number;
  if (w === "chaque" || w === "every") j = i + 1;
  else if ((w === "tous" || w === "toutes") && f[i + 1] === "les") j = i + 2;
  else return null;
  if (f[j] === "weekday" || f[j] === "weekdays") return { rule: `FREQ=WEEKLY;BYDAY=${WORKWEEK.join(",")}`, used: j + 1 - i };
  let n = 1;
  if (/^\d{1,3}$/.test(f[j] ?? "")) n = Math.max(1, Number(f[j++]));
  const unit = UNITS[f[j] ?? ""];
  if (unit) return { rule: `FREQ=${unit}${n > 1 ? `;INTERVAL=${n}` : ""}`, used: j + 1 - i };
  if (n > 1) return null;
  const days: number[] = [];
  let wd = weekday(f[j]);
  if (wd === null) return null;
  days.push(wd);
  j++;
  while (AND_WORDS.has(f[j] ?? "") && (wd = weekday(f[j + 1])) !== null) {
    if (!days.includes(wd)) days.push(wd);
    j += 2;
  }
  const byday = days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => CODES[d]);
  return { rule: `FREQ=WEEKLY;BYDAY=${byday.join(",")}`, used: j - i };
}

/** The first day on or after `from` that a rule falls on (its weekdays for BYDAY rules, else `from`). */
export function firstDay(rule: string, from: Ymd): Ymd {
  const byday = /BYDAY=([A-Z,]+)/.exec(rule)?.[1]?.split(",");
  if (!byday) return from;
  for (let k = 0; k < 7; k++) {
    const d = addDays(from, k);
    if (byday.includes(CODES[weekdayOf(d)]!)) return d;
  }
  return from;
}

const at = (d: Ymd, t: Hm | null) => (t ? formatLocalDateTime({ ...d, hour: t.hour, minute: t.minute, second: 0 }) : formatLocalDate(d));

/** A day and/or a time at word `i` (a deadline). A time alone is today. */
function momentAt(f: string[], i: number, today: Ymd): { day: Ymd | null; time: Hm | null; used: number } | null {
  const d = dayAt(f, i, today);
  let used = d?.used ?? 0;
  const t = timeAt(f, i + used);
  if (t) used += t.used;
  return used ? { day: d?.date ?? null, time: t?.time ?? null, used } : null;
}

/** "2h", "1h30", "45min", "90 min". */
function durationAt(f: string[], i: number): { minutes: number; used: number } | null {
  let m = /^(\d{1,2})h(\d{2})?$/.exec(f[i] ?? "");
  if (m) return { minutes: Number(m[1]) * 60 + Number(m[2] ?? 0), used: 1 };
  m = /^(\d{1,3})(?:min|mn)$/.exec(f[i] ?? "");
  if (m) return { minutes: Number(m[1]), used: 1 };
  if (/^\d{1,3}$/.test(f[i] ?? "") && (f[i + 1] === "min" || f[i + 1] === "mn")) return { minutes: Number(f[i]), used: 2 };
  return null;
}

/** What a part of the day means as a slot when no end is given. */
const SLOT_WORDS: Record<string, [number, number]> = {
  matin: [9, 12], morning: [9, 12], midi: [12, 13], noon: [12, 13],
  aprem: [14, 18], "apres-midi": [14, 18], afternoon: [14, 18], soir: [18, 20], evening: [18, 20],
};

const DAY_SPAN_WORDS = new Set(["au", "a", "to", "-", "jusqu'au", "until"]);
const ymd = (d: Ymd) => d.year * 10_000 + d.month * 100 + d.day;

/** Whole days at word `i`: `lun au mer`, `lun-mer`, `20/10 - 22/10`. */
function daySpanAt(f: string[], i: number, today: Ymd): { block: Block; used: number } | null {
  const span = (a: Ymd, b: Ymd, used: number) =>
    ymd(b) >= ymd(a) ? { block: { start: formatLocalDate(a), end: formatLocalDate(addDays(b, 1)) }, used } : null;
  const dash = /^(.+?)-(.+)$/.exec(f[i] ?? "");
  const a = dash && resolveDate(dash[1]!, today);
  const b = a && resolveDate(dash[2]!, a);
  if (a && b) return span(a, b, 1);
  const d = dayAt(f, i, today);
  if (!d || !DAY_SPAN_WORDS.has(f[i + d.used] ?? "")) return null;
  // The end day counts from the start ("lun au mer" said on a Thursday: next Monday to the Wednesday after).
  const e = dayAt(f, i + d.used + 1, d.date);
  return e ? span(d.date, e.date, d.used + 1 + e.used) : null;
}

/**
 * A time slot at word `i`: `mar 14h-16h`, `mar 14h à 16h`, `14h pendant 2h`, `mar matin`, `mar` (all day),
 * `lun au mer` (whole days).
 */
function slotAt(f: string[], i: number, today: Ymd, defaultDay = today): { block: Block; used: number } | null {
  const days = daySpanAt(f, i, today);
  if (days) return days;
  const d = dayAt(f, i, today);
  let used = d?.used ?? 0;
  const day = d?.date ?? defaultDay;
  let from: Hm | null = null;
  let to: Hm | null = null;
  const dash = /^(.+?)-(.+)$/.exec(f[i + used] ?? "");
  const a = dash && timeAt([dash[1]!], 0);
  const b = dash && timeAt([dash[2]!.replace(/^(\d{1,2})$/, "$1h")], 0);
  if (a && b) {
    [from, to] = [a.time, b.time];
    used++;
  } else {
    const word = f[i + used];
    const t = timeAt(f, i + used);
    if (t) {
      from = t.time;
      used += t.used;
      const sep = f[i + used];
      const e = sep === "-" || sep === "a" || sep === "to" || sep === "jusqu'a" ? timeAt(f, i + used + 1) : null;
      const dur = sep === "pendant" || sep === "for" ? durationAt(f, i + used + 1) : null;
      if (e) {
        to = e.time;
        used += 1 + e.used;
      } else if (dur) {
        const total = from.hour * 60 + from.minute + dur.minutes;
        to = { hour: Math.floor(total / 60), minute: total % 60 };
        used += 1 + dur.used;
      } else if (word && word in SLOT_WORDS && t.used === 1) {
        const [h1, h2] = SLOT_WORDS[word]!;
        [from, to] = [{ hour: h1, minute: 0 }, { hour: h2, minute: 0 }];
      }
    }
  }
  if (!used) return null;
  if (!from) return { block: { start: formatLocalDate(day), end: formatLocalDate(addDays(day, 1)) }, used };
  to ??= { hour: from.hour + 1, minute: from.minute };
  const late = to.hour * 60 + to.minute <= from.hour * 60 + from.minute || to.hour >= 24;
  const endDay = late ? addDays(day, 1) : day;
  const end = late && to.hour >= 24 ? { hour: to.hour - 24, minute: to.minute } : to;
  return { block: { start: at(day, from), end: at(endDay, end) }, used };
}

interface Token {
  /** What it names; null for a lone `@` or `tâche`. */
  feature: Feature | null;
  /** What it takes off (`deadline jamais`, `répéter jamais`). */
  clear: Cleared[];
  /** Words taken, keyword included (0: not a token). */
  used: number;
  /** Words of the value (0: the keyword alone, waiting for one). */
  valueUsed: number;
  moment: { day: Ymd | null; time: Hm | null } | null;
  block: Block | null;
  repeat: string | null;
  /** `@tag famille`: one tag (folded here; `findWhen` puts back its spelling). */
  tag: string | null;
  priority: Priority | null;
}

/** One `@`'s words (folded), read as far as they make sense. */
export function parseToken(f: string[], today: Ymd): Token {
  const none: Token = { feature: null, clear: [], used: 0, valueUsed: 0, moment: null, block: null, repeat: null, tag: null, priority: null };
  if (TASK_WORDS.has(f[0] ?? "")) return { ...none, used: 1 };
  let feature: Feature | undefined = FEATURE_WORDS[f[0] ?? ""];
  const i = feature ? 1 : 0;
  // Shortcuts without a keyword: a repetition, else a day (a deadline).
  feature ??= repeatAt(f, 0) ? "repeat" : "due";
  const tok: Token = { ...none, feature, used: i };
  if (feature === "block") {
    const r = repeatAt(f, i);
    if (r) {
      // "chaque mardi 14h-16h": the slot comes back; it starts on the rule's first day unless one is given.
      const first = firstDay(r.rule, today);
      const s = slotAt(f, i + r.used, today, first);
      const block = s?.block ?? { start: formatLocalDate(first), end: formatLocalDate(addDays(first, 1)) };
      [tok.block, tok.valueUsed] = [{ ...block, repeat: r.rule }, r.used + (s?.used ?? 0)];
    } else {
      const s = slotAt(f, i, today);
      if (s) [tok.block, tok.valueUsed] = [s.block, s.used];
    }
  } else if (feature === "repeat") {
    const r = repeatAt(f, i);
    if (i && NEVER.has(f[i] ?? "")) [tok.clear, tok.valueUsed] = [["repeat"], 1];
    else if (r) {
      tok.repeat = r.rule;
      tok.valueUsed = r.used;
      const m = momentAt(f, i + r.used, today); // "chaque lundi 7h": when the first one is due
      if (m) [tok.moment, tok.valueUsed] = [m, r.used + m.used];
    }
  } else if (feature === "tag") {
    // One tag per `@tag`: any word could be one, so a second would eat the title.
    const tag = (f[i] ?? "").replace(/^#+/, "");
    if (i && isTag(tag)) [tok.tag, tok.valueUsed] = [tag, 1];
  } else if (feature === "priority") {
    const w = f[i] ?? "";
    if (w in PRIORITY_WORDS) [tok.priority, tok.valueUsed] = [PRIORITY_WORDS[w]!, 1];
    else if (NO_PRIORITY.has(w) || NEVER.has(w)) [tok.clear, tok.valueUsed] = [["priority"], 1];
  } else if (i && NEVER.has(f[i] ?? "")) {
    [tok.clear, tok.valueUsed] = [["due", "repeat"], 1];
  } else {
    const m = momentAt(f, i, today);
    if (m) [tok.moment, tok.valueUsed] = [m, m.used];
  }
  tok.used = i + tok.valueUsed;
  return tok;
}

/** Words of a text with their positions; a word ending in punctuation ends the phrase there. */
function words(text: string, offset: number): { f: string; start: number; end: number }[] {
  const out: { f: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const raw = m[0];
    const stripped = raw.replace(/[.,;!?)]+$/, "");
    const start = offset + m.index;
    if (stripped) out.push({ f: fold(stripped), start, end: start + stripped.length });
    if (stripped.length < raw.length) break;
  }
  return out;
}

/**
 * Folds tokens into one reading. A repetition with no deadline starts on its first day. `dueGiven`: a day or a
 * time was written for the deadline (not only taken from the repetition).
 */
function readTokens(tokens: Token[], today: Ymd): { when: When; dueGiven: boolean } {
  const when: When = { due: null, repeat: null, blocks: [] };
  const clear = new Set<Cleared>();
  const tags: string[] = [];
  let repeatTime: Hm | null = null;
  let dueGiven = false;
  for (const t of tokens) {
    for (const c of t.clear) clear.add(c);
    if (t.feature === "block" && t.block) when.blocks.push(t.block);
    else if (t.feature === "tag" && t.tag) {
      if (!tags.some((x) => sameTag(x, t.tag!))) tags.push(t.tag);
    } else if (t.feature === "priority" && t.priority) when.priority ??= t.priority;
    else if (t.feature === "repeat" && t.repeat && !when.repeat) {
      when.repeat = t.repeat;
      if (t.moment?.day && !when.due) when.due = at(t.moment.day, t.moment.time);
      else repeatTime = t.moment?.time ?? null;
      if (t.moment) dueGiven = true;
    } else if (t.feature === "due" && t.moment && !when.due) {
      when.due = at(t.moment.day ?? today, t.moment.time);
      dueGiven = true;
    }
  }
  if (when.repeat && !when.due) when.due = at(firstDay(when.repeat, today), repeatTime);
  if (clear.size) when.clear = [...clear];
  if (tags.length) when.tags = tags;
  return { when, dueGiven };
}

const combine = (tokens: Token[], today: Ymd): When => readTokens(tokens, today).when;

export interface WhenToken {
  /** The `@` tokens' positions, to cut them from the title. */
  spans: { start: number; end: number }[];
  when: When;
  /** A day or time was written for the deadline (`@ven`, `@répéter chaque lundi 7h`), not only a repetition. */
  dueGiven: boolean;
}

/**
 * The `@` tokens of a line, if it has any: `@` + keyword and value, a shortcut (`@demain`, `@chaque lundi`), or a
 * lone `@`. An `@` inside a word (an email) or before an unknown word (`@quelquechose`) isn't one.
 */
export function findWhen(line: string, today: Ymd): WhenToken | null {
  const found = scan(line, today);
  if (!found.length) return null;
  const tokens = found.flatMap((f) => (f.tok ? [f.tok] : []));
  return { spans: found.map((f) => ({ start: f.start, end: f.end })), ...readTokens(tokens, today) };
}

/** Every `@` of a line that is a token (see `findWhen`): where it is, where its keyword ends, its reading. */
function scan(line: string, today: Ymd): { start: number; end: number; valueStart: number; tok: Token | null }[] {
  const out: { start: number; end: number; valueStart: number; tok: Token | null }[] = [];
  for (const m of line.matchAll(/(^|\s)@/g)) {
    const atPos = m.index + m[1]!.length;
    const rest = line.slice(atPos + 1);
    const ws = words(rest, atPos + 1);
    const tok = parseToken(
      ws.map((w) => w.f),
      today,
    );
    if (tok.used > 0) {
      if (tok.tag) tok.tag = line.slice(ws[1]!.start, ws[1]!.end).replace(/^#+/, ""); // as written: "Été", not "ete"
      const keyword = !!FEATURE_WORDS[ws[0]!.f] || TASK_WORDS.has(ws[0]!.f);
      out.push({ start: atPos, end: ws[tok.used - 1]!.end, valueStart: keyword ? ws[0]!.end : atPos + 1, tok });
    } else if (!rest || /^\s/.test(rest)) {
      out.push({ start: atPos, end: atPos + 1, valueStart: atPos + 1, tok: null });
    }
  }
  return out;
}

/** One `@` of a line (spec §5.2): a field while it's typed, a block once it has its value. */
export interface LineToken {
  /** The "@". */
  start: number;
  /** After its last word (a lone `@`: right after it). */
  end: number;
  /** After its keyword (`@deadline`), else right after the "@" (`@demain`). */
  valueStart: number;
  /** What it adds; null for `@tâche` or a lone `@` (the task alone). */
  feature: Feature | null;
  /** It has its value (`@deadline ven`, `@demain`, `@tag famille`, `@répéter jamais`): not a keyword alone. */
  complete: boolean;
  /** What it says alone. */
  when: When;
  /** A deadline's or a repetition's time was given (`@répéter chaque lundi 7h`). */
  timed: boolean;
}

/** The `@` tokens of a line, one by one. */
export function lineTokens(line: string, today: Ymd): LineToken[] {
  return scan(line, today).map(({ start, end, valueStart, tok }) => ({
    start,
    end,
    valueStart,
    feature: tok?.feature ?? null,
    complete: !!tok && (tok.valueUsed > 0 || tok.clear.length > 0),
    when: tok ? readTokens([tok], today).when : NO_WHEN,
    timed: !!tok?.moment?.time,
  }));
}

/** The keyword that names a feature, as the assistant writes it. */
export function featureWord(feature: Feature, lang: "fr" | "en"): string {
  return L[lang].features.find((f) => f[0] === feature)![1];
}

/** The word the `@` reads for a priority ("haute"). */
export function priorityWord(priority: Priority, lang: "fr" | "en"): string {
  return L[lang].priorities.find((p) => p[0] === priority)![1];
}

/** Its name and icon in the assistant ("Deadline", "flag"). */
export function featureName(feature: Feature, lang: "fr" | "en"): { name: string; icon: string } {
  const f = L[lang].features.find((x) => x[0] === feature)!;
  return { name: f[2], icon: f[3] };
}

/** Changes to make to a task: `undefined` leaves a field as it is, `null` takes it off. */
export interface TaskEdit {
  due?: string | null;
  /** RRULE. */
  repeat?: string | null;
  /** Time blocks to add. */
  blocks: Block[];
  /** Tags to add (those it has stay). */
  tags?: string[];
  priority?: Priority | null;
}

/**
 * What a line's `@` tokens change on a task that already has `current` dates. A repetition alone keeps the
 * deadline, moved to the rule's first day from it (`@chaque lundi` on a task due Tuesday: the Monday after).
 */
export function taskEdit(found: Pick<WhenToken, "when" | "dueGiven">, current: { due: string | null }): TaskEdit {
  const { when, dueGiven } = found;
  const edit: TaskEdit = { blocks: when.blocks };
  if (when.tags) edit.tags = when.tags;
  if (when.priority) edit.priority = when.priority;
  else if (when.clear?.includes("priority")) edit.priority = null;
  const clearsDue = !!when.clear?.includes("due");
  if (clearsDue) edit.due = null;
  if (when.clear?.includes("repeat")) edit.repeat = null;
  if (when.repeat) edit.repeat = when.repeat;
  if (dueGiven) edit.due = when.due;
  else if (when.repeat) edit.due = current.due && !clearsDue ? startOn(when.repeat, current.due) : when.due;
  return edit;
}

/** `value` moved to the first day on or after it that `rule` falls on, time kept. */
export function startOn(rule: string, value: string): string {
  const p = parseLocal(value);
  if (!p) return value;
  const d = firstDay(rule, p.wall);
  return p.allDay ? formatLocalDate(d) : formatLocalDateTime({ ...d, hour: p.wall.hour, minute: p.wall.minute, second: 0 });
}

/** A whole text as one moment (a form field, a picker): "ven 14h", "demain matin", "15/10". Null otherwise. */
export function parseDate(text: string, today: Ymd): string | null {
  const ws = words(text, 0);
  if (!ws.length || ws[ws.length - 1]!.end !== text.trimEnd().length) return null;
  const m = momentAt(
    ws.map((w) => w.f),
    0,
    today,
  );
  return m && m.used === ws.length ? at(m.day ?? today, m.time) : null;
}

/** A whole text as a time (a picker's time field): "14h", "14h30", "14:30", "2pm", "midi". Null otherwise. */
export function parseTime(text: string): Hm | null {
  const ws = words(text, 0);
  if (!ws.length || ws[ws.length - 1]!.end !== text.trimEnd().length) return null;
  const t = timeAt(
    ws.map((w) => w.f),
    0,
  );
  return t && t.used === ws.length ? t.time : null;
}

/** What's wrong in day / time fields: which field, and why. */
export type FieldsError = "day" | "time" | "end" | "noDay" | "noStart" | "endBefore";

/**
 * Day and time fields read each on its own (a form, a picker): the day a day alone ("ven", "15/10", not "ven
 * 14h"), each time a time alone ("14h"). Hours need a day, an end needs a start and comes after it. All empty
 * reads as nothing.
 */
export function readFields(f: { day: string; time: string; end?: string }, today: Ymd): { day: Ymd | null; start: Hm | null; end: Hm | null; error: FieldsError | null } {
  const [dayText, startText, endText] = [f.day.trim(), f.time.trim(), (f.end ?? "").trim()];
  const value = dayText ? parseDate(dayText, today) : null;
  const p = value && value.length === 10 ? parseLocal(value) : null;
  const day = p ? { year: p.wall.year, month: p.wall.month, day: p.wall.day } : null;
  const start = startText ? parseTime(startText) : null;
  const end = endText ? parseTime(endText) : null;
  const error: FieldsError | null =
    dayText && !day ? "day"
    : startText && !start ? "time"
    : endText && !end ? "end"
    : !dayText && (startText || endText) ? "noDay"
    : endText && !startText ? "noStart"
    : start && end && end.hour * 60 + end.minute <= start.hour * 60 + start.minute ? "endBefore"
    : null;
  return { day, start, end, error };
}

/** A block for a picked day: from `start` to `end` (the next day if it's not after the start), or all day. */
export function dayBlock(day: Ymd, start: Hm | null, end: Hm | null): Block {
  if (!start) return { start: formatLocalDate(day), end: formatLocalDate(addDays(day, 1)) };
  const stop = end ?? { hour: (start.hour + 1) % 24, minute: start.minute };
  const late = stop.hour * 60 + stop.minute <= start.hour * 60 + start.minute;
  return { start: at(day, start), end: at(late ? addDays(day, 1) : day, stop) };
}

/** A day, and a time if any, as a value: "2026-10-23" or "2026-10-23T14:00". */
export function dayValue(day: Ymd, time: Hm | null): string {
  return at(day, time);
}

/** A whole text as one time slot (a form field, a picker): "mar 14h-16h", "mar matin", "lun au mer". */
export function parseSlot(text: string, today: Ymd): Block | null {
  const ws = words(text, 0);
  if (!ws.length || ws[ws.length - 1]!.end !== text.trimEnd().length) return null;
  const s = slotAt(
    ws.map((w) => w.f),
    0,
    today,
  );
  return s && s.used === ws.length ? s.block : null;
}

/** A value written the way `parseDate` reads it back (a form field showing a deadline): "20/10/2026 14h30". */
export function dateText(value: string): string {
  const p = parseLocal(value);
  if (!p) return value;
  const day = `${p.wall.day}/${p.wall.month}/${p.wall.year}`;
  return p.allDay ? day : `${day} ${p.wall.hour}h${p.wall.minute ? String(p.wall.minute).padStart(2, "0") : ""}`;
}

/**
 * A block written the way `parseSlot` reads it back (a form field showing a slot picked elsewhere):
 * "20/10/2026 14h35-15h05", "20/10/2026" for a whole day, "19/10/2026-21/10/2026" for whole days. Its repetition
 * isn't written.
 */
export function slotText(block: Block): string {
  const start = dateText(block.start);
  const end = parseLocal(block.end);
  if (block.start.length === 10) {
    const last = end ? formatLocalDate(addDays(end.wall, -1)) : block.start;
    return last > block.start ? `${start}-${dateText(last)}` : start;
  }
  return end && !end.allDay ? `${start}-${end.wall.hour}h${end.wall.minute ? String(end.wall.minute).padStart(2, "0") : ""}` : start;
}

// —— repetition ——

const UNIT_NAMES = {
  fr: { DAILY: ["jour", "jours"], WEEKLY: ["semaine", "semaines"], MONTHLY: ["mois", "mois"], YEARLY: ["année", "ans"] },
  en: { DAILY: ["day", "days"], WEEKLY: ["week", "weeks"], MONTHLY: ["month", "months"], YEARLY: ["year", "years"] },
} as const;
const DAY_NAMES = {
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
  en: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
};

function ruleParts(rule: string): { freq: string; interval: number; byday: string[] } | null {
  const parts = new Map(rule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = parts.get("FREQ");
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  for (const k of parts.keys()) if (!["FREQ", "INTERVAL", "BYDAY", "WKST"].includes(k)) return null;
  const interval = Number(parts.get("INTERVAL") ?? 1);
  const byday = parts.get("BYDAY")?.split(",") ?? [];
  if (!Number.isInteger(interval) || interval < 1 || byday.some((d) => !CODES.includes(d))) return null;
  if (byday.length && (freq !== "WEEKLY" || interval > 1)) return null;
  return { freq, interval, byday };
}

/**
 * One spelling per rule, so a rule read back from the server compares equal to the one we wrote (iOS may add
 * `INTERVAL=1` or `WKST`). Rules the grammar can't say are kept as they are.
 */
export function normalizeRule(rule: string): string {
  const p = ruleParts(rule.toUpperCase());
  if (!p) return rule;
  const days = [...p.byday].sort((a, b) => ((CODES.indexOf(a) + 6) % 7) - ((CODES.indexOf(b) + 6) % 7));
  return `FREQ=${p.freq}${p.interval > 1 ? `;INTERVAL=${p.interval}` : ""}${days.length ? `;BYDAY=${days.join(",")}` : ""}`;
}

/** "chaque lundi", "tous les 2 jours", "every weekday"…; null for rules the grammar can't say. */
export function repeatLabel(rule: string, lang: "fr" | "en"): string | null {
  const p = ruleParts(rule);
  if (!p) return null;
  const and = lang === "fr" ? " et " : " and ";
  if (p.byday.length) {
    if (p.byday.join(",") === WORKWEEK.join(",")) return lang === "fr" ? "en semaine" : "every weekday";
    const names = p.byday.map((c) => DAY_NAMES[lang][CODES.indexOf(c)]!);
    return `${lang === "fr" ? "chaque" : "every"} ${names.join(and)}`;
  }
  const [one, many] = UNIT_NAMES[lang][p.freq as keyof (typeof UNIT_NAMES)["fr"]];
  if (p.interval === 1) return `${lang === "fr" ? "chaque" : "every"} ${one}`;
  if (lang === "en") return `every ${p.interval} ${many}`;
  return `${p.freq === "WEEKLY" ? "toutes" : "tous"} les ${p.interval} ${many}`;
}

/** What a task note's `repeat` holds: the English phrase when the grammar can say it, else the RRULE itself. */
export function repeatToNote(rule: string): string {
  return repeatLabel(rule, "en") ?? rule;
}

/** A task note's `repeat` (a phrase in either language, or an RRULE) → RRULE; null if not understood. */
export function repeatFromNote(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (/^FREQ=/i.test(v)) {
    try {
      return normalizeRule(ICAL.Recur.fromString(v.toUpperCase()).toString());
    } catch {
      return null;
    }
  }
  const f = words(v, 0).map((w) => w.f);
  const r = repeatAt(f, 0);
  return r && r.used === f.length ? normalizeRule(r.rule) : null;
}

/**
 * The next time a repeating task comes due after this one, and after today (or now, for a timed one): ticking a
 * task three weeks late doesn't leave it three times in the past.
 */
export function nextOccurrence(value: string, rule: string, now: { date: string; dateTime: string }): string | null {
  const p = parseLocal(value);
  if (!p) return null;
  let recur: InstanceType<typeof ICAL.Recur>;
  try {
    recur = ICAL.Recur.fromString(rule);
  } catch {
    return null;
  }
  const w = p.wall;
  const start = p.allDay
    ? ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, isDate: true })
    : ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: 0 });
  const it = recur.iterator(start);
  const floor = p.allDay ? now.date : now.dateTime;
  for (let k = 0; k < 5000; k++) {
    const t = it.next();
    if (!t) return null;
    const v = p.allDay
      ? formatLocalDate(t)
      : formatLocalDateTime({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: 0 });
    if (v > value && v > floor) return v;
  }
  return null;
}


// —— suggestions while typing ——

export interface AtItem {
  /**
   * `accept`: what's typed is the answer (ends the line); `insert`: put `text` in place of what's being typed;
   * `more`: start another `@` on the same line.
   */
  kind: "accept" | "insert" | "more";
  text: string;
  label: string;
  /** Lucide icon. */
  icon?: string;
  /** What the token would mean; shown on the right. */
  when?: When;
  hint?: string;
}

interface Words {
  /** Feature, keyword, label, icon, hint: a short example of what to type after it (2026-10-25, the user found
   *  hints of every kind and length odd), shown as one ("ex. ven 14h"). None where the next list offers every
   *  choice (2026-10-27, the user: "haute" beside Priorité read as the task's priority; a vault tag beside Tag the
   *  same). */
  features: [Feature, string, string, string, string][];
  /** `@tâche`: keyword, label (no hint: the label says it all). */
  task: [string, string];
  /** On a task already made, no hint (nothing to type): `deadline jamais`, without then with a repetition. */
  clearDue: [string, string];
  clearRepeat: string;
  never: string;
  /** high, medium, low, then none (taking it off a task): word and label. */
  priorities: [Priority | null, string, string][];
  more: string;
  days: string[];
  times: string[];
  slots: string[];
  repeats: string[];
  every: string;
  weekdays: string[];
  hour: (n: number) => string[];
  range: (n: number) => string[];
}

const L: Record<"fr" | "en", Words> = {
  fr: {
    features: [
      ["due", "deadline", "Deadline", "flag", "ven 14h"],
      ["block", "session", "Session", "clock", "mar 14h-16h"],
      ["repeat", "répéter", "Répéter", "repeat", "chaque lundi"],
      ["tag", "tag", "Tag", "tag", ""],
      ["priority", "priorité", "Priorité", "chevrons-up", ""],
    ],
    task: ["tâche", "Créer la tâche"],
    clearDue: ["Retirer la deadline", "Retirer la deadline et la répétition"],
    clearRepeat: "Ne plus répéter",
    never: "jamais",
    priorities: [["high", "haute", "Haute"], ["medium", "moyenne", "Moyenne"], ["low", "basse", "Basse"], [null, "aucune", "Retirer la priorité"]],
    more: "Autre chose (session, tag…)",
    days: ["aujourd'hui", "demain", "après-demain", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    times: ["matin", "midi", "14h", "18h"],
    slots: ["matin", "aprem", "9h-10h", "10h-12h", "14h-16h", "16h-18h"],
    repeats: ["chaque semaine", "chaque jour", "chaque mois", "chaque année", "en semaine", "tous les 2 jours", "toutes les 2 semaines"],
    every: "chaque",
    weekdays: ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
    hour: (n: number) => [`${n}h`, `${n}h30`],
    range: (n: number) => [`${n}h-${n + 1}h`, `${n}h-${n + 2}h`, `${n}h-${n + 3}h`],
  },
  en: {
    features: [
      ["due", "deadline", "Deadline", "flag", "fri 2pm"],
      ["block", "session", "Session", "clock", "tue 2pm-4pm"],
      ["repeat", "repeat", "Repeat", "repeat", "every monday"],
      ["tag", "tag", "Tag", "tag", ""],
      ["priority", "priority", "Priority", "chevrons-up", ""],
    ],
    task: ["task", "Create the task"],
    clearDue: ["Remove the deadline", "Remove the deadline and the repeat"],
    clearRepeat: "Stop repeating",
    never: "never",
    priorities: [["high", "high", "High"], ["medium", "medium", "Medium"], ["low", "low", "Low"], [null, "none", "Remove the priority"]],
    more: "Something else (session, tag…)",
    days: ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    times: ["morning", "noon", "2pm", "6pm"],
    slots: ["morning", "afternoon", "9am-10am", "10am-12pm", "2pm-4pm", "4pm-6pm"],
    repeats: ["every week", "every day", "every month", "every year", "every weekday", "every 2 days", "every 2 weeks"],
    every: "every",
    weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    hour: (n: number) => (n <= 12 ? [`${n}am`, `${n}pm`] : [`${n}h`]),
    range: (n: number) => (n <= 11 ? [`${n}am-${n + 1}am`, `${n}am-${n + 2}am`] : [`${n}h-${n + 1}h`, `${n}h-${n + 2}h`]),
  },
};

/**
 * What to offer while typing after an `@` (`typed`: the text between it and the cursor). First what to add
 * (deadline, time block, repeat), then values for it; the words that make sense stay and the rest
 * (from `from`) is what an item replaces. `wantsDay`: the value still needs a day (a calendar picker helps; with a
 * time when `feature` is the deadline). Null
 * when the typing has left the grammar: the title goes on. `editing`: the `@` is on a task already made, with or
 * without a deadline and a repetition (taking them off is offered instead of "Create the task"). `knownTags`: the
 * vault's tags, most used first, offered after `@tag`.
 */
export function suggestAt(
  typed: string,
  today: Ymd,
  lang: "fr" | "en",
  editing?: { due: boolean; repeat: boolean; priority?: boolean },
  knownTags: string[] = [],
): { from: number; items: AtItem[]; wantsDay: boolean; feature?: Feature } | null {
  const v = L[lang];
  const ws = [...typed.matchAll(/\S+/g)].map((m) => ({ f: fold(m[0]), end: m.index + m[0].length }));
  const endsWithSpace = !typed || /\s$/.test(typed);
  const complete = endsWithSpace ? ws : ws.slice(0, -1);
  const all = ws.map((w) => w.f);
  const items: AtItem[] = [];
  const featureLabel = (k: Feature) => v.features.find((x) => x[0] === k)!;

  // Step 1: nothing chosen yet. What to add, plus shortcuts for what's being typed (a day, a repetition).
  const keyword = complete.length ? FEATURE_WORDS[complete[0]!.f] : undefined;
  if (!complete.length) {
    const tail = all[0] ?? "";
    const whole = tail ? parseToken([tail], today) : null;
    if (whole && whole.used === 1 && whole.valueUsed) {
      items.push({ kind: "accept", text: typed, label: `@${typed.trim()}`, icon: "check", when: combine([whole], today) });
    }
    for (const [, word, label, icon, hint] of v.features) {
      if (fold(word).startsWith(tail) && fold(word) !== tail) items.push({ kind: "insert", text: `${word} `, label, icon, hint: hint || undefined });
    }
    if (tail) {
      for (const c of [...suggestDates(tail, today, lang).map((d) => d.word), ...v.repeats]) {
        if (!fold(c).startsWith(tail) || fold(c) === tail) continue;
        const tok = parseToken(fold(c).split(" "), today);
        if (tok.used === c.split(" ").length) items.push({ kind: "insert", text: c, label: c, when: combine([tok], today) });
        if (items.length >= 10) break;
      }
    }
    if (editing) {
      // Taking things off, ending the edit at once.
      const dueOff = `${featureLabel("due")[1]} ${v.never}`;
      const repeatOff = `${featureLabel("repeat")[1]} ${v.never}`;
      if (editing.due && fold(dueOff).startsWith(tail)) {
        items.push({ kind: "accept", text: dueOff, label: v.clearDue[editing.repeat ? 1 : 0], icon: "circle-slash" });
      }
      if (editing.repeat && fold(repeatOff).startsWith(tail)) {
        items.push({ kind: "accept", text: repeatOff, label: v.clearRepeat, icon: "circle-slash" });
      }
    } else if (fold(v.task[0]).startsWith(tail)) {
      // Nothing to add after it: the line ends and becomes a task (a lone `@` is the same).
      items.push({ kind: "accept", text: tail ? v.task[0] : "", label: v.task[1], icon: "file-check" });
    }
    if (tail && !items.length) return typingDate(tail) ? { from: 0, items: [dateHint(lang)], wantsDay: false } : null;
    return { from: 0, items, wantsDay: false };
  }

  // Step 2: a keyword (or a shortcut) was typed: values for it.
  const start = keyword ? 1 : 0;
  const parsed = parseToken(
    complete.map((w) => w.f),
    today,
  );
  if (parsed.used && !parsed.feature && !parsed.clear.length) return null; // `@tâche ` and the title goes on
  const feature = parsed.feature ?? "due";
  const keptCount = Math.max(parsed.used, start); // 0 with no keyword: maybe a date being typed ("15 oct")
  const kept = complete.slice(0, keptCount).map((w) => w.f);
  const from = keptCount ? complete[keptCount - 1]!.end + 1 : 0;
  const typedTail = fold(typed.slice(Math.min(from, typed.length))).trim();
  const tail = feature === "tag" ? typedTail.replace(/^#+/, "") : typedTail;
  const read = (extra: string): When | null => {
    const f = [...kept, ...fold(extra).split(/\s+/).filter(Boolean)];
    const tok = parseToken(f, today);
    return tok.used === f.length && tok.valueUsed ? combine([tok], today) : null;
  };

  const asTyped = tail ? read(tail) : parsed.valueUsed ? combine([parsed], today) : null;
  if (asTyped) {
    items.push({ kind: "accept", text: typed, label: `@${typed.trim()}`, icon: "check", when: asTyped });
  }

  const hasDay = !!parsed.moment?.day || !!(parsed.block && !tail);
  const candidates: string[] = [];
  const num = /^(\d{1,2})(h\d{0,2})?$/.exec(tail);
  const days = (): string[] => [...suggestDates(tail, today, lang).map((d) => d.word), ...monthDays(tail, today, lang)];
  const everyDay = tail.startsWith(fold(v.every)) ? v.weekdays.map((d) => `${v.every} ${d}`) : [];
  if (feature === "block") {
    if (num) candidates.push(...v.range(Number(num[1])));
    if (!parsed.block) candidates.push(...days());
    candidates.push(...v.slots);
    // A slot that comes back: "chaque mardi 14h-16h".
    if (!parsed.block && tail) candidates.push(...everyDay, v.repeats[0]!, v.repeats[1]!, v.repeats[4]!);
  } else if (feature === "tag") {
    if (!parsed.tag) candidates.push(...knownTags);
  } else if (feature === "priority") {
    if (!parsed.priority && !parsed.clear.length) {
      for (const [level, word, label] of v.priorities) {
        if (level === null && !editing?.priority) continue;
        if (fold(word).startsWith(tail) && fold(word) !== tail && items.length < 11) {
          // Its marks on the right, in its color (as on the chip).
          items.push(level ? { kind: "insert", text: word, label, when: { ...NO_WHEN, priority: level } } : { kind: "insert", text: word, label, icon: "circle-slash" });
        }
      }
    }
  } else if (feature === "repeat") {
    if (editing?.repeat && !parsed.repeat) candidates.push(v.never);
    candidates.push(...everyDay);
    if (!parsed.repeat) candidates.push(...v.repeats);
    candidates.push(...v.times);
  } else {
    if (editing?.due && !parsed.moment && !parsed.clear.length) candidates.push(v.never);
    if (num) candidates.push(...v.hour(Number(num[1])));
    if (!parsed.moment?.day) candidates.push(...days());
    candidates.push(...v.times);
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    const fc = fold(c);
    if (!fc.startsWith(tail) || fc === tail || seen.has(fc) || items.length >= 11) continue;
    const when = read(c);
    if (!when) continue;
    seen.add(fc);
    // A tag says it all: no reading beside it.
    items.push(feature === "tag" ? { kind: "insert", text: c, label: `#${c}`, icon: "tag" } : { kind: "insert", text: c, label: c, when });
  }
  if (asTyped) items.push({ kind: "more", text: " @", label: v.more, icon: "plus" });
  if (tail && !items.length && feature !== "tag" && typingDate(tail)) items.push(dateHint(lang));
  if (tail && !items.length) return null;
  if (!keptCount && !items.length) return null;
  const [, , label, icon, hint] = featureLabel(feature);
  if (!items.length) items.push({ kind: "insert", text: "", label, icon, hint: hint || undefined }); // the keyword alone: say what it wants
  return { from: Math.min(from, typed.length), items, wantsDay: (feature === "due" || feature === "block") && !hasDay && !tail, feature };
}

/** The start of a written date: `15/`, `15/10/20`, `2027-1`, `15 oct`. */
function typingDate(tail: string): boolean {
  return /^\d{1,2}\/(\d{1,2}(\/\d{0,4})?)?$/.test(tail) || /^\d{4}-\d{0,2}(-\d{0,2})?$/.test(tail) || /^\d{1,2} [a-z]*$/.test(tail);
}

/** Says how to write a full date while one is being typed. */
function dateHint(lang: "fr" | "en"): AtItem {
  return lang === "fr"
    ? { kind: "insert", text: "", label: "jj/mm/aaaa", icon: "calendar", hint: "15/10/2027, 15 octobre 2027" }
    : { kind: "insert", text: "", label: "dd/mm/yyyy", icon: "calendar", hint: "15/10/2027, 15 october 2027" };
}

/** `15 octobre`, `15 novembre`… for a day number being typed ("15", "15 oc"), from the next one on. */
function monthDays(tail: string, today: Ymd, lang: "fr" | "en"): string[] {
  const m = /^(\d{1,2})(?:er)? ?([a-z]*)$/.exec(tail);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 31) return [];
  const out: string[] = [];
  for (let k = 0; k < 12 && out.length < 4; k++) {
    const month = ((today.month - 1 + k) % 12) + 1;
    const year = today.year + Math.floor((today.month - 1 + k) / 12);
    const name = MONTH_NAMES[lang][month - 1]!;
    // Months whose day is still ahead, in order (this month's 15th is gone on the 16th).
    if (fold(name).startsWith(m[2]!) && resolveDate(`${m[1]}/${month}`, today)?.year === year) out.push(`${m[1]} ${name}`);
  }
  return out;
}
