import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { sourceExcerpt } from "./site-excerpt.mjs";

function select(text, details = {}, links = ["source/sample.ts"]) {
  const token = `<!-- dads:excerpt ${JSON.stringify({
    path: "sample.ts",
    language: "ts",
    from: "begin",
    through: "end",
    ...details,
  })} -->\n`;
  return sourceExcerpt({
    token,
    page: "guide.md",
    linkedSources: new Set(links),
    files: new Map([["source/sample.ts", Buffer.from(text)]]),
  });
}

test("includes the exact selected source lines", () => {
  assert.deepEqual(select("first\r\nbegin\r\n  <type>\r\nend\r\nlast"), {
    language: "ts",
    excerpt: "begin\n  <type>\nend",
  });
});

test("rejects stale, ambiguous, and inverted selections", () => {
  assert.throws(
    () => select("begin\nfinish"),
    /exactly one line matching "end"/u,
  );
  assert.throws(
    () => select("begin\nbegin\nend"),
    /exactly one line matching "begin"/u,
  );
  assert.throws(
    () => select("begin\nend\nend"),
    /exactly one line matching "end"/u,
  );
  assert.throws(() => select("end\nbegin"), /end line precedes/u);
});

test("requires a link in the same guide even when the source is copied", () => {
  assert.throws(() => select("begin\nend", {}, []), /link to sample.ts/u);
});

test("leaves ordinary comments alone", () => {
  assert.equal(
    sourceExcerpt({ token: "<!-- explanatory note -->" }),
    undefined,
  );
});
