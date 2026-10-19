import { readFileSync } from "node:fs";

export const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8").replace(/\n<!-- status \d+ -->\s*$/, "");
