/** Day vocabulary shared by the `@` grammar (`when.ts`) and the day pickers. */

export type Ymd = { year: number; month: number; day: number };

export const WEEKDAYS: Record<string, number> = {
  dim: 0, dimanche: 0, sun: 0, sunday: 0,
  lun: 1, lundi: 1, mon: 1, monday: 1,
  mar: 2, mardi: 2, tue: 2, tues: 2, tuesday: 2,
  mer: 3, mercredi: 3, wed: 3, wednesday: 3,
  jeu: 4, jeudi: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  ven: 5, vendredi: 5, fri: 5, friday: 5,
  sam: 6, samedi: 6, sat: 6, saturday: 6,
};

const RELATIVE: Record<string, number> = {
  "aujourd'hui": 0, aujourdhui: 0, auj: 0, today: 0,
  demain: 1, tomorrow: 1, tmr: 1,
  "apres-demain": 2, apresdemain: 2,
};

/** Lowercase, without accents, with straight apostrophes: what words are matched on. */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/’/g, "'").toLowerCase();

export function addDays(d: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function weekdayOf(d: Ymd): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

const valid = (y: number, mo: number, d: number) => {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/** One date word (folded): `2026-10-15`, `15/10`, `15/10/27`, `demain`, `lun`… Null if it isn't one. */
export function resolveDate(word: string, today: Ymd): Ymd | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(y, mo, d) ? { year: y, month: mo, day: d } : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(word);
  if (m) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return valid(y, mo, d) ? { year: y, month: mo, day: d } : null;
    }
    // Day/month without a year: the next time that date comes (today included).
    const base = Date.UTC(today.year, today.month - 1, today.day);
    for (const y of [today.year, today.year + 1]) {
      if (valid(y, mo, d) && Date.UTC(y, mo - 1, d) >= base) return { year: y, month: mo, day: d };
    }
    return null;
  }
  const rel = RELATIVE[word];
  if (rel !== undefined) return addDays(today, rel);
  const wd = WEEKDAYS[word];
  if (wd !== undefined) {
    // The next such day, never today ("lundi" said on a Monday means next week).
    return addDays(today, (wd - weekdayOf(today) + 7) % 7 || 7);
  }
  return null;
}

/** A day offered by a picker: the word to insert and the date it stands for today. */
export interface DateSuggestion {
  word: string;
  date: Ymd;
}

export const DAY_WORDS: Record<"fr" | "en", string[]> = {
  fr: ["aujourd'hui", "demain", "après-demain", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
  en: ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
};

const key = (d: Ymd) => d.year * 10_000 + d.month * 100 + d.day;

/**
 * Day words starting with the query (the other language's when none does), in date order, plus the query itself
 * when it already is a date no word covers (`15/10`, `2026-11-03`). With an empty query, the next eight days.
 */
export function suggestDates(query: string, today: Ymd, lang: "fr" | "en"): DateSuggestion[] {
  const q = fold(query).replace(/'/g, "");
  const matching = (l: "fr" | "en") => DAY_WORDS[l].filter((w) => fold(w).replace(/'/g, "").startsWith(q));
  let words = matching(lang);
  if (!words.length) words = matching(lang === "fr" ? "en" : "fr");
  const out: DateSuggestion[] = [];
  const seen = new Set<number>();
  for (const word of words) {
    const date = resolveDate(fold(word), today)!;
    if (!q && seen.has(key(date))) continue; // "vendredi" when it's tomorrow
    seen.add(key(date));
    out.push({ word, date });
  }
  const typed = q ? resolveDate(fold(query), today) : null;
  if (typed && !seen.has(key(typed))) out.unshift({ word: query, date: typed });
  return out.sort((a, b) => key(a.date) - key(b.date));
}
