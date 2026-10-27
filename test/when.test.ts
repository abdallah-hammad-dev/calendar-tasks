import { describe, expect, it } from "vitest";
import { suggestDates } from "../src/editor/date-token";
import {
  dateText,
  dayBlock,
  slotText,
  dayValue,
  parseSlot,
  featureWord,
  findWhen,
  lineTokens,
  nextOccurrence,
  normalizeRule,
  parseDate,
  parseTime,
  readFields,
  repeatFromNote,
  repeatLabel,
  repeatToNote,
  startOn,
  suggestAt,
  taskEdit,
} from "../src/editor/when";

const TODAY = { year: 2026, month: 10, day: 15 }; // a Thursday
const when = (line: string) => findWhen(line, TODAY)?.when ?? null;
const due = (line: string) => when(line)?.due ?? null;
const cut = (line: string) => findWhen(line, TODAY)!.spans.map((s) => line.slice(s.start, s.end)).join(" | ");

describe("the @ grammar: days and times", () => {
  it("reads explicit dates", () => {
    expect(due("Rapport @2026-11-03")).toBe("2026-11-03");
    expect(due("Rapport @3/11")).toBe("2026-11-03");
    expect(due("Rapport @15/10")).toBe("2026-10-15"); // today counts
    expect(due("Rapport @14/10")).toBe("2027-10-14"); // passed: next year
    expect(due("Rapport @3/11/27")).toBe("2027-11-03");
  });

  it("reads French and English words", () => {
    expect(due("Appeler @demain")).toBe("2026-10-16");
    expect(due("Appeler @tomorrow")).toBe("2026-10-16");
    expect(due("Appeler @aujourd'hui")).toBe("2026-10-15");
    expect(due("Appeler @Aujourd’hui")).toBe("2026-10-15");
    expect(due("Appeler @après-demain")).toBe("2026-10-17");
    expect(due("Appeler @lun")).toBe("2026-10-19");
    expect(due("Appeler @jeu")).toBe("2026-10-22"); // never today
    expect(due("Appeler @friday")).toBe("2026-10-16");
    expect(due("Appeler @lundi prochain")).toBe("2026-10-19");
    expect(due("Appeler @next monday")).toBe("2026-10-19");
    expect(due("Appeler @dans 3 jours")).toBe("2026-10-18");
    expect(due("Appeler @in 2 weeks")).toBe("2026-10-29");
    expect(due("Appeler @dans 1 mois")).toBe("2026-11-15");
  });

  it("reads times, alone (today) or after a day", () => {
    expect(due("Démo @lun 14h")).toBe("2026-10-19T14:00");
    expect(due("Démo @lun 9h30")).toBe("2026-10-19T09:30");
    expect(due("Démo @3/11 14:30")).toBe("2026-11-03T14:30");
    expect(due("Démo @lun à 14h")).toBe("2026-10-19T14:00");
    expect(due("Démo @demain matin")).toBe("2026-10-16T09:00");
    expect(due("Démo @demain soir")).toBe("2026-10-16T18:00");
    expect(due("Démo @18h")).toBe("2026-10-15T18:00");
    expect(due("Demo @friday 2pm")).toBe("2026-10-16T14:00");
    expect(due("Demo @friday 2:30pm")).toBe("2026-10-16T14:30");
    expect(due("Demo @friday 12am")).toBe("2026-10-16T00:00");
    expect(due("Demo @friday 12 pm")).toBe("2026-10-16T12:00");
    expect(due("Demo @friday at 9am")).toBe("2026-10-16T09:00");
  });

  it("stops where the words stop meaning a date, so the rest stays in the title", () => {
    expect(cut("Préparer slides @lun 14h [[Olera]]")).toBe("@lun 14h");
    expect(cut("Appeler @demain pour le devis")).toBe("@demain");
    expect(cut("Démo @demain 25h")).toBe("@demain");
    expect(cut("Démo @demain, puis le reste")).toBe("@demain");
  });

  it("ignores emails, unknown words and mid-word @", () => {
    expect(findWhen("Écrire à abd@bench.test", TODAY)).toBeNull();
    expect(findWhen("Voir @quelquechose", TODAY)).toBeNull();
    expect(findWhen("Prix 3@15/10", TODAY)).toBeNull();
    expect(findWhen("Rapport @31/02", TODAY)).toBeNull();
  });

  it("takes a lone @, 'tâche' or a keyword without a value as a task without a date", () => {
    const none = { due: null, repeat: null, blocks: [] };
    expect(when("Acheter du lait @")).toEqual(none);
    expect(cut("Acheter @ du lait")).toBe("@");
    expect(cut("Acheter du lait @tâche")).toBe("@tâche");
    expect(when("Acheter du lait @task")).toEqual(none);
    expect(findWhen("Acheter du lait @sans date", TODAY)).toBeNull(); // the old keyword is gone
    expect(when("Acheter du lait @deadline jamais")).toEqual({ ...none, clear: ["due", "repeat"] }); // on a task made, takes them off
    expect(cut("Acheter du lait @deadline")).toBe("@deadline");
    expect(when("Acheter du lait @deadline")).toEqual(none);
  });
});

describe("the @ grammar: one thing per @", () => {
  it("reads a deadline after its keyword, or straight after @", () => {
    expect(due("Rapport @deadline ven 18h")).toBe("2026-10-16T18:00");
    expect(due("Rapport @échéance ven")).toBe("2026-10-16");
    expect(due("Rapport @due fri")).toBe("2026-10-16");
  });

  it("keeps each @ to one thing", () => {
    expect(cut("Mémoire @ven @session mar")).toBe("@ven | @session mar");
    expect(cut("Mémoire @ven session mar")).toBe("@ven"); // without its own @, "session" is the title
  });

  it("reads time blocks: a range, a duration, a part of the day, or a whole day", () => {
    const blocks = (line: string) => when(line)!.blocks;
    expect(blocks("Rapport @session mar 14h-16h")).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T16:00" }]);
    // Its name until 2026-10-20 isn't a keyword any more: the line keeps it as text.
    expect(when("Rapport @créneau mar 14h-16h")?.blocks ?? []).toEqual([]);
    expect(blocks("Rapport @session mar 14h à 16h30")).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T16:30" }]);
    expect(blocks("Rapport @session demain 9h")).toEqual([{ start: "2026-10-16T09:00", end: "2026-10-16T10:00" }]);
    expect(blocks("Rapport @session tue 2pm for 90min")).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T15:30" }]);
    expect(blocks("Rapport @session mar matin")).toEqual([{ start: "2026-10-20T09:00", end: "2026-10-20T12:00" }]);
    expect(blocks("Rapport @session mar")).toEqual([{ start: "2026-10-20", end: "2026-10-21" }]);
    expect(blocks("Rapport @session 23h-1h")).toEqual([{ start: "2026-10-15T23:00", end: "2026-10-16T01:00" }]);
    expect(blocks("Rapport @session lun au mer")).toEqual([{ start: "2026-10-19", end: "2026-10-22" }]);
    expect(blocks("Rapport @session lun-mer")).toEqual([{ start: "2026-10-19", end: "2026-10-22" }]);
    expect(blocks("Rapport @session 20/10 to 22/10")).toEqual([{ start: "2026-10-20", end: "2026-10-23" }]);
    expect(blocks("Rapport @session mar à 14h")).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T15:00" }]);
    expect(when("Rapport @ven 18h @session mar 14h-16h @session jeu 10h-12h")).toMatchObject({
      due: "2026-10-16T18:00",
      blocks: [
        { start: "2026-10-20T14:00", end: "2026-10-20T16:00" },
        { start: "2026-10-22T10:00", end: "2026-10-22T12:00" },
      ],
    });
  });

  it("reads repetitions, after their keyword or straight after @, and starts them on their first day", () => {
    expect(when("Sport @chaque lundi")).toMatchObject({ due: "2026-10-19", repeat: "FREQ=WEEKLY;BYDAY=MO" });
    expect(when("Sport @répéter chaque lundi 7h")).toMatchObject({ due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO" });
    expect(when("Sport @tous les lundis et jeudis")).toMatchObject({ due: "2026-10-15", repeat: "FREQ=WEEKLY;BYDAY=MO,TH" });
    expect(when("Courses @chaque semaine")).toMatchObject({ due: "2026-10-15", repeat: "FREQ=WEEKLY" });
    expect(when("Courses @sam @chaque semaine")).toMatchObject({ due: "2026-10-17", repeat: "FREQ=WEEKLY" });
    expect(when("Arroser @tous les 2 jours")).toMatchObject({ repeat: "FREQ=DAILY;INTERVAL=2" });
    expect(when("Loyer @1/11 @répéter chaque mois")).toMatchObject({ due: "2026-11-01", repeat: "FREQ=MONTHLY" });
    expect(when("Stand-up @en semaine 9h")).toMatchObject({ due: "2026-10-15T09:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" });
    expect(when("Run @repeat every 2 weeks")).toMatchObject({ repeat: "FREQ=WEEKLY;INTERVAL=2" });
    expect(when("Review @weekly")).toMatchObject({ repeat: "FREQ=WEEKLY" });
  });

  it("reads one tag per @tag, as written, with or without #", () => {
    expect(when("Appeler mamie @tag Été @demain @tag #urgent")).toMatchObject({ due: "2026-10-16", tags: ["Été", "urgent"] });
    expect(cut("Appeler @tag famille le soir")).toBe("@tag famille"); // one tag: the title goes on
    expect(when("Appeler @tag famille @tag Famille")!.tags).toEqual(["famille"]);
    expect(cut("Payer @tag 2026")).toBe("@tag"); // not a tag: the number stays in the title
    expect(when("Payer @tag 2026")!.tags).toBeUndefined();
    expect(taskEdit(findWhen("@tag famille", TODAY)!, { due: "2026-10-20" })).toEqual({ blocks: [], tags: ["famille"] });
  });
});

describe("repetition rules", () => {
  it("says them in both languages, and reads them back", () => {
    const rules = ["FREQ=DAILY", "FREQ=DAILY;INTERVAL=2", "FREQ=WEEKLY", "FREQ=WEEKLY;INTERVAL=3", "FREQ=WEEKLY;BYDAY=MO,TH",
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "FREQ=MONTHLY", "FREQ=YEARLY"];
    for (const r of rules) {
      expect(repeatFromNote(repeatToNote(r))).toBe(r);
      expect(repeatFromNote(repeatLabel(r, "fr"))).toBe(r);
    }
    expect(repeatLabel("FREQ=WEEKLY;BYDAY=MO,TH", "fr")).toBe("chaque lundi et jeudi");
    expect(repeatLabel("FREQ=WEEKLY;INTERVAL=2", "fr")).toBe("toutes les 2 semaines");
    expect(repeatLabel("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "en")).toBe("every weekday");
  });

  it("keeps rules it can't say, and spells equal rules the same way", () => {
    expect(repeatToNote("FREQ=MONTHLY;BYMONTHDAY=15")).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    expect(repeatFromNote("FREQ=MONTHLY;BYMONTHDAY=15")).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    expect(normalizeRule("FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH,MO")).toBe("FREQ=WEEKLY;BYDAY=MO,TH");
    expect(repeatFromNote("n'importe quoi")).toBeNull();
  });

  it("finds the next date after this one and after today", () => {
    const now = { date: "2026-10-15", dateTime: "2026-10-15T10:00" };
    expect(nextOccurrence("2026-10-16", "FREQ=WEEKLY", now)).toBe("2026-10-23");
    expect(nextOccurrence("2026-10-19T07:00", "FREQ=WEEKLY;BYDAY=MO,TH", now)).toBe("2026-10-22T07:00");
    expect(nextOccurrence("2026-09-01", "FREQ=WEEKLY", now)).toBe("2026-10-20"); // weeks late: next one ahead
    expect(nextOccurrence("2026-10-31", "FREQ=MONTHLY", now)).toBe("2026-12-31"); // no 31 November (RFC 5545)
    expect(nextOccurrence("2026-10-15", "FREQ=DAILY", now)).toBe("2026-10-16");
  });

});

describe("suggestions while typing after @", () => {
  const items = (typed: string) =>
    suggestAt(typed, TODAY, "fr")?.items.map((i) => (i.kind === "accept" ? `✓${i.label}` : i.kind === "more" ? "+" : i.label)) ?? null;

  it("first offers what to add", () => {
    expect(items("")).toEqual(["Deadline", "Session", "Répéter", "Tag", "Priorité", "✓Créer la tâche"]);
    expect(items("se")).toEqual(["Session"]);
    expect(items("tâ")).toEqual(["Tag", "✓Créer la tâche"]);
    // Every hint is a short example of what to type, and parses as one.
    for (const lang of ["fr", "en"] as const) {
      for (const i of suggestAt("", TODAY, lang)!.items) if (i.hint) expect(cut(`x @${i.text}${i.hint}`)).toBe(`@${i.text}${i.hint}`);
    }
    expect(suggestAt("tâ", TODAY, "fr")!.items[1]!.text).toBe("tâche");
    expect(items("tâche ")).toBeNull(); // nothing to add after it: the title goes on
  });

  it("offers shortcuts for a day or a repetition being typed", () => {
    expect(items("dem")).toEqual(["demain"]);
    expect(items("ven")).toEqual(["✓@ven", "vendredi"]);
    expect(items("ch")).toContain("chaque semaine");
  });

  it("then offers values for what was chosen", () => {
    expect(items("deadline ")!.slice(0, 3)).toEqual(["aujourd'hui", "demain", "après-demain"]);
    expect(suggestAt("deadline ", TODAY, "fr")!.wantsDay).toBe(true);
    const afterDay = items("deadline ven ")!;
    expect(afterDay[0]).toBe("✓@deadline ven");
    expect(afterDay).toContain("matin");
    expect(afterDay.at(-1)).toBe("+");
    expect(items("session mar ")).toEqual(expect.arrayContaining(["✓@session mar", "14h-16h", "matin"]));
    expect(items("session mar 14")).toEqual(["14h-15h", "14h-16h", "14h-17h"]);
    expect(items("répéter ")!.slice(0, 2)).toEqual(["chaque semaine", "chaque jour"]);
    expect(items("répéter chaque l")).toEqual(["chaque lundi"]);
  });

  it("offers the vault's tags after @tag, and takes a new one", () => {
    const tags = (typed: string) =>
      suggestAt(typed, TODAY, "fr", undefined, ["famille", "Été", "urgent", "projets/factures"])?.items.map((i) =>
        i.kind === "accept" ? `✓${i.label}` : i.kind === "more" ? "+" : i.label,
      ) ?? null;
    expect(tags("tag ")).toEqual(["#famille", "#Été", "#urgent", "#projets/factures"]);
    // Its example is the vault's most used tag, none without one: never a word of ours.
    expect(suggestAt("", TODAY, "fr", undefined, ["olera", "famille"])!.items.find((i) => i.label === "Tag")!.hint).toBe("olera");
    expect(suggestAt("", TODAY, "fr")!.items.find((i) => i.label === "Tag")!.hint).toBeUndefined();
    expect(suggestAt("tag ", TODAY, "fr")!.wantsDay).toBe(false);
    expect(tags("tag e")).toEqual(["✓@tag e", "#Été", "+"]);
    expect(tags("tag #fa")).toEqual(["✓@tag #fa", "#famille", "+"]);
    expect(tags("tag nouveau")).toEqual(["✓@tag nouveau", "+"]);
    expect(tags("tag famille ")).toEqual(["✓@tag famille", "+"]);
    expect(tags("tag famille le")).toBeNull(); // the title goes on
    expect(suggestAt("tag famille", TODAY, "fr", undefined, ["famille"])!.items[0]).toMatchObject({ when: { tags: ["famille"] } });
  });

  it("gives up once the title starts again", () => {
    expect(items("deadline ven pour")).toBeNull();
    expect(items("quelquechose")).toBeNull();
  });
});

describe("slot pickers", () => {
  it("reads a whole answer as one slot, and nothing else", () => {
    expect(parseSlot("mar 14h-16h", TODAY)).toEqual({ start: "2026-10-20T14:00", end: "2026-10-20T16:00" });
    expect(parseSlot("lun au mer", TODAY)).toEqual({ start: "2026-10-19", end: "2026-10-22" });
    expect(parseSlot("mar chez Paul", TODAY)).toBeNull();
    expect(parseSlot("", TODAY)).toBeNull();
  });
});

describe("day pickers", () => {
  it("reads a whole answer, time included, and nothing else", () => {
    expect(parseDate("ven 14h", TODAY)).toBe("2026-10-16T14:00");
    expect(parseDate(" demain ", TODAY)).toBe("2026-10-16");
    expect(parseDate("demain matin", TODAY)).toBe("2026-10-16T09:00");
    expect(parseDate("15/10", TODAY)).toBe("2026-10-15");
    expect(parseDate("demain chez Paul", TODAY)).toBeNull();
    expect(parseDate("chaque lundi", TODAY)).toBeNull();
    expect(parseDate("", TODAY)).toBeNull();
  });
});

describe("suggestDates", () => {
  const words = (q: string, lang: "fr" | "en" = "fr") => suggestDates(q, TODAY, lang).map((s) => s.word);

  it("offers the next eight days, one word each", () => {
    expect(words("")).toEqual(["aujourd'hui", "demain", "après-demain", "dimanche", "lundi", "mardi", "mercredi", "jeudi"]);
    expect(words("", "en")).toEqual(["today", "tomorrow", "saturday", "sunday", "monday", "tuesday", "wednesday", "thursday"]);
  });

  it("filters by what was typed, ignoring accents, in either language", () => {
    expect(words("d")).toEqual(["demain", "dimanche"]);
    expect(words("apres")).toEqual(["après-demain"]);
    expect(words("fri")).toEqual(["friday"]);
    expect(words("15/10")).toEqual(["15/10"]);
  });

  it("only offers words the grammar reads back to the same date", () => {
    for (const lang of ["fr", "en"] as const) {
      for (const s of suggestDates("", TODAY, lang)) {
        const [y, m, d] = due(`x @${s.word}`)!.split("-").map(Number);
        expect({ year: y, month: m, day: d }).toEqual(s.date);
      }
    }
  });
});

describe("full dates", () => {
  it("reads a year, and month names in both languages", () => {
    expect(due("Visa @15/10/2027")).toBe("2027-10-15");
    expect(due("Visa @15/10/27")).toBe("2027-10-15");
    expect(due("Visa @15 octobre")).toBe("2026-10-15"); // today counts
    expect(due("Visa @14 octobre")).toBe("2027-10-14"); // passed: next year
    expect(due("Visa @20 octobre 2028")).toBe("2028-10-20");
    expect(due("Visa @1er novembre 14h")).toBe("2026-11-01T14:00");
    expect(due("Visa @oct 20")).toBe("2026-10-20");
    expect(due("Visa @deadline 3 déc")).toBe("2026-12-03");
    expect(when("Visa @session 20 oct 14h-16h")!.blocks).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T16:00" }]);
  });

  it("keeps the list open while a date is typed, and lists days in date order", () => {
    const items = (typed: string) => suggestAt(typed, TODAY, "fr")?.items.map((i) => (i.kind === "accept" ? `✓${i.label}` : i.label)) ?? null;
    expect(items("15/10/2")).toEqual(["jj/mm/aaaa"]);
    expect(items("deadline 15/")).toEqual(["jj/mm/aaaa"]);
    expect(items("deadline 15/10/2027")![0]).toBe("✓@deadline 15/10/2027");
    expect(items("deadline 20 n")).toEqual(["20 novembre"]);
    expect(items("deadline 20")).toEqual(expect.arrayContaining(["20h", "20 octobre", "20 novembre"]));
    expect(items("deadline ")!.slice(0, 8)).toEqual(["aujourd'hui", "demain", "après-demain", "dimanche", "lundi", "mardi", "mercredi", "jeudi"]);
  });
});

describe("time blocks that come back", () => {
  const blocks = (line: string) => when(line)!.blocks;

  it("reads a repetition inside the slot, starting on its first day", () => {
    expect(blocks("Mémoire @session chaque mardi 14h-16h")).toEqual([
      { start: "2026-10-20T14:00", end: "2026-10-20T16:00", repeat: "FREQ=WEEKLY;BYDAY=TU" },
    ]);
    expect(blocks("Sport @session en semaine 7h-8h")).toEqual([
      { start: "2026-10-15T07:00", end: "2026-10-15T08:00", repeat: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
    ]);
    expect(blocks("Revue @session chaque semaine ven matin")).toEqual([
      { start: "2026-10-16T09:00", end: "2026-10-16T12:00", repeat: "FREQ=WEEKLY" },
    ]);
    expect(blocks("Atelier @session chaque lundi")).toEqual([{ start: "2026-10-19", end: "2026-10-20", repeat: "FREQ=WEEKLY;BYDAY=MO" }]);
    // The task itself doesn't repeat.
    expect(when("Mémoire @session chaque mardi 14h-16h")).toMatchObject({ due: null, repeat: null });
  });

  it("is offered while typing a slot", () => {
    const items = (typed: string) => suggestAt(typed, TODAY, "fr")?.items.map((i) => (i.kind === "accept" ? `✓${i.label}` : i.label)) ?? null;
    expect(items("session chaque m")).toEqual(["chaque mardi", "chaque mercredi"]);
    expect(items("session chaque mardi ")).toEqual(expect.arrayContaining(["✓@session chaque mardi", "14h-16h", "matin"]));
  });
});

describe("changing a task already made", () => {
  const edit = (line: string, current: string | null) => taskEdit(findWhen(line, TODAY)!, { due: current });

  it("sets what is written, and only that", () => {
    expect(edit("@ven", "2026-10-20")).toEqual({ due: "2026-10-16", blocks: [] });
    expect(edit("@session mar 14h-16h", "2026-10-20")).toEqual({ blocks: [{ start: "2026-10-20T14:00", end: "2026-10-20T16:00" }] });
    expect(edit("@répéter chaque lundi 7h", "2026-10-20")).toEqual({ due: "2026-10-19T07:00", repeat: "FREQ=WEEKLY;BYDAY=MO", blocks: [] });
  });

  it("keeps the deadline when only a repetition is added, moved onto the rule's day", () => {
    expect(edit("@chaque semaine", "2026-10-20T14:00")).toMatchObject({ due: "2026-10-20T14:00", repeat: "FREQ=WEEKLY" });
    expect(edit("@chaque lundi", "2026-10-20T14:00")).toMatchObject({ due: "2026-10-26T14:00" });
    expect(edit("@chaque lundi", null)).toMatchObject({ due: "2026-10-19" });
    expect(startOn("FREQ=WEEKLY;BYDAY=MO", "2026-10-19")).toBe("2026-10-19");
  });

  it("takes the deadline or the repetition off", () => {
    expect(edit("@deadline jamais", "2026-10-20")).toEqual({ due: null, repeat: null, blocks: [] });
    expect(edit("@due never", "2026-10-20")).toEqual({ due: null, repeat: null, blocks: [] });
    expect(edit("@répéter jamais", "2026-10-20")).toEqual({ repeat: null, blocks: [] });
    expect(edit("@repeat never", null)).toEqual({ repeat: null, blocks: [] });
  });

  it("reads a picker's time field, and writes the day and time back", () => {
    expect(parseTime("14h")).toEqual({ hour: 14, minute: 0 });
    expect(parseTime("9h30")).toEqual({ hour: 9, minute: 30 });
    expect(parseTime("2:15pm")).toEqual({ hour: 14, minute: 15 });
    expect(parseTime("midi")).toEqual({ hour: 12, minute: 0 });
    expect(parseTime("demain")).toBeNull();
    expect(parseTime("25h")).toBeNull();
    const v = dayValue({ year: 2026, month: 10, day: 23 }, { hour: 14, minute: 0 });
    expect(v).toBe("2026-10-23T14:00");
    expect(parseDate(dateText(v), TODAY)).toBe(v);
    expect(dayValue({ year: 2026, month: 10, day: 23 }, null)).toBe("2026-10-23");
  });

  it("makes a block from a day picked in the calendar, with or without times", () => {
    const day = { year: 2026, month: 10, day: 25 };
    expect(dayBlock(day, { hour: 14, minute: 0 }, { hour: 16, minute: 0 })).toEqual({ start: "2026-10-25T14:00", end: "2026-10-25T16:00" });
    expect(dayBlock(day, { hour: 14, minute: 0 }, null)).toEqual({ start: "2026-10-25T14:00", end: "2026-10-25T15:00" });
    expect(dayBlock(day, { hour: 23, minute: 30 }, null)).toEqual({ start: "2026-10-25T23:30", end: "2026-10-26T00:30" });
    expect(dayBlock(day, null, null)).toEqual({ start: "2026-10-25", end: "2026-10-26" });
  });

  it("writes a deadline back the way a form field reads it", () => {
    for (const v of ["2026-10-14", "2026-10-20T14:30", "2027-01-05T09:00"]) expect(parseDate(dateText(v), TODAY)).toBe(v);
    expect(dateText("2026-10-20T14:00")).toBe("20/10/2026 14h");
  });

  it("offers taking things off instead of \"Create the task\"", () => {
    const items = (typed: string, editing: { due: boolean; repeat: boolean }) =>
      suggestAt(typed, TODAY, "fr", editing)?.items.map((i) => (i.kind === "accept" ? `✓${i.label}` : i.label)) ?? null;
    expect(items("", { due: true, repeat: true })).toEqual(["Deadline", "Session", "Répéter", "Tag", "Priorité", "✓Retirer la deadline et la répétition", "✓Ne plus répéter"]);
    expect(items("", { due: true, repeat: false })).toEqual(["Deadline", "Session", "Répéter", "Tag", "Priorité", "✓Retirer la deadline"]);
    expect(items("", { due: false, repeat: false })).toEqual(["Deadline", "Session", "Répéter", "Tag", "Priorité"]);
    expect(items("répéter ", { due: true, repeat: true })![0]).toBe("jamais");
    expect(items("deadline ", { due: true, repeat: false })![0]).toBe("jamais");
    expect(items("deadline ", { due: false, repeat: false })).not.toContain("jamais");
    const off = suggestAt("", TODAY, "fr", { due: true, repeat: true })!.items.filter((i) => i.kind === "accept");
    expect(off.map((i) => i.text)).toEqual(["deadline jamais", "répéter jamais"]);
  });
});

describe("slots written back as text", () => {
  const today = { year: 2026, month: 10, day: 18 };
  it("reads back what it writes, to the minute, a whole day too", () => {
    for (const block of [
      { start: "2026-10-20T14:35", end: "2026-10-20T15:05" },
      { start: "2026-10-20T09:00", end: "2026-10-20T10:00" },
      { start: "2026-10-20T23:30", end: "2026-10-21T00:15" },
      { start: "2026-10-20", end: "2026-10-21" },
      { start: "2026-10-19", end: "2026-10-22" },
    ]) {
      expect(parseSlot(slotText(block), today)).toEqual(block);
    }
    expect(slotText({ start: "2026-10-20T14:35", end: "2026-10-20T15:05" })).toBe("20/10/2026 14h35-15h05");
    expect(slotText({ start: "2026-10-19", end: "2026-10-22" })).toBe("19/10/2026-21/10/2026");
  });
});

describe("readFields", () => {
  const today = { year: 2026, month: 10, day: 18 };
  it("reads a day and a time, each in its field", () => {
    expect(readFields({ day: "23/10/2026", time: "18h" }, today)).toEqual({ day: { year: 2026, month: 10, day: 23 }, start: { hour: 18, minute: 0 }, end: null, error: null });
    expect(readFields({ day: "ven", time: "", end: "" }, today)).toMatchObject({ day: { year: 2026, month: 10, day: 23 }, start: null, error: null });
    expect(readFields({ day: "", time: "", end: "" }, today)).toEqual({ day: null, start: null, end: null, error: null });
  });

  it("says which field is wrong, and why", () => {
    expect(readFields({ day: "ven 14h", time: "" }, today).error).toBe("day");
    expect(readFields({ day: "15/20/2000", time: "" }, today).error).toBe("day");
    expect(readFields({ day: "ven", time: "25h" }, today).error).toBe("time");
    expect(readFields({ day: "ven", time: "14h", end: "plus tard" }, today).error).toBe("end");
    expect(readFields({ day: "", time: "14h" }, today).error).toBe("noDay");
    expect(readFields({ day: "ven", time: "", end: "16h" }, today).error).toBe("noStart");
    expect(readFields({ day: "ven", time: "16h", end: "14h" }, today).error).toBe("endBefore");
  });
});

describe("lineTokens", () => {
  const toks = (line: string) =>
    lineTokens(line, TODAY).map((t) => ({ text: line.slice(t.start, t.end), value: line.slice(t.valueStart, t.end), feature: t.feature, complete: t.complete }));

  it("splits a line into its @, each with where its value starts", () => {
    expect(toks("Appeler @deadline ven 14h @tag Été @demain")).toEqual([
      { text: "@deadline ven 14h", value: " ven 14h", feature: "due", complete: true },
      { text: "@tag Été", value: " Été", feature: "tag", complete: true },
      { text: "@demain", value: "demain", feature: "due", complete: true },
    ]);
  });

  it("says when an @ has no value yet: a keyword alone, the task alone", () => {
    expect(toks("Appeler @deadline")).toEqual([{ text: "@deadline", value: "", feature: "due", complete: false }]);
    expect(toks("Appeler @ et @tâche")).toEqual([
      { text: "@", value: "", feature: null, complete: false },
      { text: "@tâche", value: "", feature: null, complete: false },
    ]);
    expect(toks("Appeler @répéter jamais")[0]).toMatchObject({ feature: "repeat", complete: true });
    expect(toks("écrire à paul@exemple.fr")).toEqual([]);
  });

  it("reads each one alone", () => {
    const [due, tag, block] = lineTokens("@ven 14h @tag famille @session mar 14h-16h", TODAY);
    expect(due!.when.due).toBe("2026-10-16T14:00");
    expect(due!.timed).toBe(true);
    expect(tag!.when.tags).toEqual(["famille"]);
    expect(block!.when.blocks).toEqual([{ start: "2026-10-20T14:00", end: "2026-10-20T16:00" }]);
    expect(featureWord("repeat", "fr")).toBe("répéter");
  });
});

describe("priority", () => {
  it("is one @ with its level, in French or English, and makes a task", () => {
    expect(when("- [ ] Rapport @priorité haute")).toMatchObject({ priority: "high" });
    expect(when("- [ ] Rapport @priority low")).toMatchObject({ priority: "low" });
    expect(when("- [ ] Rapport @prio moyenne")).toMatchObject({ priority: "medium" });
    expect(cut("Rapport @priorité basse pour lundi")).toBe("@priorité basse");
    expect(lineTokens("@priorité haute", TODAY)[0]).toMatchObject({ feature: "priority", complete: true });
    expect(lineTokens("@priorité", TODAY)[0]).toMatchObject({ feature: "priority", complete: false });
  });

  it("is changed or taken off a task already made", () => {
    expect(taskEdit(findWhen("@priorité basse", TODAY)!, { due: null })).toMatchObject({ priority: "low" });
    expect(taskEdit(findWhen("@priorité aucune", TODAY)!, { due: null })).toMatchObject({ priority: null });
    expect(taskEdit(findWhen("@demain", TODAY)!, { due: null }).priority).toBeUndefined();
  });

  it("is offered by the assistant, then its levels (and none on a task that has one)", () => {
    expect(suggestAt("", TODAY, "fr")!.items.map((i) => i.label)).toContain("Priorité");
    expect(suggestAt("priorité ", TODAY, "fr")!.items.map((i) => `${i.label} ${i.when?.priority}`)).toEqual(["Haute high", "Moyenne medium", "Basse low"]);
    expect(suggestAt("priorité ", TODAY, "fr", { due: false, repeat: false, priority: true })!.items.map((i) => i.label)).toContain("Retirer la priorité");
    expect(suggestAt("priorité h", TODAY, "fr")!.items.map((i) => i.text)).toEqual(["haute"]);
    expect(suggestAt("priority hi", TODAY, "en")!.items.map((i) => i.text)).toEqual(["high"]);
  });
});
