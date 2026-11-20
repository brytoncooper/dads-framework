/**
 * Counted lines: non-blank, non-comment, and nothing clever.
 *
 * The file budget is only fair if reformatting cannot move a number and
 * writing documentation cannot either, which makes the interesting cases the
 * ones where a comment is not a comment: a URL inside a string, a template
 * literal that spans lines, a Rust character literal holding a quote, and a
 * raw string holding what looks like a comment. Each of those has cost a
 * counter its credibility somewhere, so each of them is written down here.
 */

import { describe, expect, it } from "vitest";
import { countCodeLines } from "./counted-lines.js";

describe("counted lines", () => {
  it("ignores blanks and comments but not code that looks like one", () => {
    const source = [
      "// a leading comment",
      "",
      'const url = "http://example.com"; // trailing comment',
      "/* a block",
      "   that spans lines */",
      "call(); /* trailing block */ other();",
      "/** a doc comment */",
      "const template = `a",
      "// still inside the template",
      "b`;",
      "   ",
    ].join("\n");

    expect(countCodeLines(source, "src/a.ts")).toBe(5);
  });

  it("does not let a Rust char literal or raw string swallow the file", () => {
    const source = [
      "// a doc line",
      "/// another",
      "let quote = '\"';",
      'let path = r#"https://example.com // not a comment"#;',
      'let lifetime: &\'static str = "x"; // trailing',
      "fn main() {}",
    ].join("\n");

    expect(countCodeLines(source, "crates/a/src/lib.rs")).toBe(4);
  });
});
