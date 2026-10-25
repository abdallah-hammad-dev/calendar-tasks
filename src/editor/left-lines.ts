import type { ChangeSet, EditorState } from "@codemirror/state";
import { findTags } from "../tasks/tags";
import { parseLinkLine, parseTaskLine } from "./convert";

/** A line to look at once left: `- [ ] …` (to convert), or `- [[Task]] …` with an `@` or a `#tag` after the link (to apply). */
function watched(text: string): boolean {
  if (parseTaskLine(text)) return true;
  const link = parseLinkLine(text);
  if (!link) return false;
  const tail = text.slice(link.end);
  return /(^|\s)@/.test(tail) || findTags(tail).tags.length > 0;
}

/**
 * Task lines (see `watched`) the cursor just left, in the new document: the line it was on when the selection
 * moved, and every pasted or dropped line it isn't on. A line copied from elsewhere often ends with a newline, so
 * the cursor lands below it without ever being on it.
 */
export function leftTaskLines(
  before: EditorState,
  after: EditorState,
  changes: ChangeSet,
  selectionMoved: boolean,
  pasted: boolean,
): { from: number; text: string }[] {
  const doc = after.doc;
  const cursor = doc.lineAt(after.selection.main.head).number;
  const left = new Map<number, string>();
  const add = (n: number): void => {
    if (n === cursor || left.has(n)) return;
    const line = doc.line(n);
    if (watched(line.text)) left.set(n, line.text);
  };
  if (selectionMoved) {
    const old = before.doc.lineAt(before.selection.main.head);
    if (watched(old.text)) add(doc.lineAt(Math.min(changes.mapPos(old.from, -1), doc.length)).number);
  }
  if (pasted) {
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) add(n);
    });
  }
  return [...left].map(([n, text]) => ({ from: doc.line(n).from, text }));
}
