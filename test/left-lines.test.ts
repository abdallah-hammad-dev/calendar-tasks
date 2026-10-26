import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { cursorTaskLine, leftTaskLines } from "../src/editor/left-lines";

/** Applies one edit and returns the task lines it left, as their text. */
function left(doc: string, cursor: number, spec: TransactionSpec, pasted = false): string[] {
  const before = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
  const tr = before.update(spec);
  return leftTaskLines(before, tr.state, tr.changes, tr.selection !== undefined, pasted).map((l) => l.text);
}

const TASK = "- [ ] Test @demain 14h";

describe("leftTaskLines", () => {
  it("reports the task line when Enter moves the cursor below it", () => {
    const end = TASK.length;
    expect(left(TASK, end, { changes: { from: end, insert: "\n- [ ] " }, selection: { anchor: end + 7 } })).toEqual([TASK]);
  });

  it("reports the line when the day picker's Enter writes the day and a new line in one go", () => {
    const doc = "- [ ] Acheter du lait @dem";
    const insert = "@demain\n- [ ] ";
    const at = doc.indexOf("@");
    expect(left(doc, doc.length, { changes: { from: at, to: doc.length, insert }, selection: { anchor: at + insert.length } })).toEqual([
      "- [ ] Acheter du lait @demain",
    ]);
  });

  it("says nothing while typing on the line", () => {
    expect(left("- [ ] Test @demain 14", 21, { changes: { from: 21, insert: "h" }, selection: { anchor: 22 } })).toEqual([]);
  });

  it("reports a pasted line that ended with a newline (the cursor never was on it)", () => {
    const text = `${TASK}\n`;
    expect(left("", 0, { changes: { from: 0, insert: text }, selection: { anchor: text.length } }, true)).toEqual([TASK]);
  });

  it("leaves the pasted line the cursor ends on for later", () => {
    const text = `- [ ] A @demain\n${TASK}`;
    expect(left("", 0, { changes: { from: 0, insert: text }, selection: { anchor: text.length } }, true)).toEqual([
      "- [ ] A @demain",
    ]);
  });

  it("ignores lines changed by anything but a paste (undo, sync from another device…)", () => {
    expect(left("x\n", 2, { changes: { from: 0, to: 1, insert: TASK } })).toEqual([]);
  });

  it("reports a converted task line with an @ or a #tag after its link, and not without one", () => {
    const line = "- [[Rapport]] @ven";
    expect(left(`${line}\nx`, 3, { selection: { anchor: line.length + 1 } })).toEqual([line]);
    expect(left("- [[Rapport]]\nx", 3, { selection: { anchor: 14 } })).toEqual([]);
    expect(left("- [[Rapport]] #famille\nx", 3, { selection: { anchor: 23 } })).toEqual(["- [[Rapport]] #famille"]);
    expect(left("- [[Rapport]] C#\nx", 3, { selection: { anchor: 17 } })).toEqual([]);
    expect(left("- [[Rapport]]@ven\nx", 3, { selection: { anchor: 18 } })).toEqual(["- [[Rapport]]@ven"]); // glued to the link
  });
});

describe("cursorTaskLine", () => {
  const at = (doc: string, cursor: number) => cursorTaskLine(EditorState.create({ doc, selection: EditorSelection.cursor(cursor) }));

  it("gives the cursor's line when the editor loses focus on a task line", () => {
    expect(at(`x\n${TASK}`, 4)).toEqual({ from: 2, text: TASK });
    expect(at("x\n- [[Rapport]] #famille", 5)).toEqual({ from: 2, text: "- [[Rapport]] #famille" });
  });

  it("gives nothing on other lines", () => {
    expect(at(`${TASK}\nx`, TASK.length + 1)).toBeNull();
    expect(at("- [[Rapport]]", 5)).toBeNull();
  });
});
