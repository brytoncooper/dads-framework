/**
 * The literals a renderer puts on a screen, and which of them are words.
 *
 * The seams are found by syntax, so the interesting cases are the branches —
 * a fallback after `??`, both arms of a conditional — and the filter that
 * keeps copy keys, data tokens, codes and paths from reading as copy.
 */

import { describe, expect, it } from "vitest";
import { isHardcodedCopy, renderedCopySpans } from "./rendered-copy.js";
import { ts } from "./typescript-program.js";

function spansOf(text: string): readonly string[] {
  const source = ts.createSourceFile(
    "view.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return renderedCopySpans(source).map(
    (span) => `${span.seam}: ${span.text.replace(/\s+/g, " ").trim()}`,
  );
}

describe("rendered copy", () => {
  it("finds literals at every seam, branches included", () => {
    const text = [
      "const view = (",
      '  <p aria-label={ready ? "Ready" : "Waiting"}>',
      "    Orders",
      '    {name ?? "Unnamed"}',
      "  </p>",
      ");",
      'toast.success("Saved");',
      'const item = { label: "Open" };',
    ].join("\n");
    expect(spansOf(text)).toStrictEqual([
      "aria-label prop: Ready",
      "aria-label prop: Waiting",
      "JSX text: Orders",
      "JSX text: Unnamed",
      "toast: Saved",
      "property: Open",
    ]);
  });

  it("counts words and leaves data alone", () => {
    expect(isHardcodedCopy("No orders yet")).toBe(true);
    expect(isHardcodedCopy("Save")).toBe(true);
    for (const data of [
      "orders.empty.title",
      "primary",
      "NOT_FOUND",
      "/orders",
      "42",
    ]) {
      expect({ data, copy: isHardcodedCopy(data) }).toStrictEqual({
        data,
        copy: false,
      });
    }
  });
});
