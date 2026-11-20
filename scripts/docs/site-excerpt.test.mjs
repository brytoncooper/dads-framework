import assert from "node:assert/strict";
import test from "node:test";

import { expandPageExamples, sourceExcerpt } from "./site-excerpt.mjs";
import { renderPage } from "./site-render.mjs";

function directive(details = {}) {
  return `<!-- dads:excerpt ${JSON.stringify({
    path: "sample.ts",
    language: "ts",
    from: "begin",
    through: "end",
    ...details,
  })} -->\n`;
}

function select(text, details) {
  return sourceExcerpt({
    token: directive(details),
    page: "guide.md",
    readFile: () => text,
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

test("leaves ordinary comments alone", () => {
  assert.equal(
    sourceExcerpt({ token: "<!-- explanatory note -->" }),
    undefined,
  );
});

function guide(markdown) {
  return {
    slug: "guide",
    title: "Guide",
    owner: "docs",
    path: "guide.md",
    section: "Guides",
    markdown,
  };
}

test("renders standalone TSX excerpts in agent Markdown and HTML", () => {
  const fragment = "begin\n  <div>```</div>\nend";
  const page = guide(
    `# Guide\n\n${directive({ path: "sample.tsx", language: "tsx" })}\nNext.\n`,
  );
  page.markdown = expandPageExamples(page, (path) => {
    assert.equal(path, "sample.tsx");
    return fragment;
  });
  assert.equal(
    page.markdown,
    "# Guide\n\n````tsx\n" + fragment + "\n````\n\nNext.\n",
  );
  const html = renderPage({ page, pages: [page] });
  assert.match(
    html,
    /<code class="language-tsx">begin\n {2}&lt;div&gt;`{3}&lt;\/div&gt;\nend/u,
  );
  assert.doesNotMatch(html, /sample\.tsx|dads:excerpt/u);
});

test("allows labeled instructional fences and validates JSON", () => {
  const markdown = [
    "# Guide",
    "",
    "```sh",
    "npm run verify",
    "```",
    "",
    "~~~bash",
    "npm run verify",
    "~~~",
    "",
    "```json",
    '{"allow": false}',
    "```",
    "",
    "```http",
    "HTTP/1.1 403 Forbidden",
    "```",
    "",
    "```text",
    "No matching tenant",
    "```",
  ].join("\n");
  assert.equal(expandPageExamples(guide(markdown)), markdown);
  assert.throws(
    () =>
      expandPageExamples(
        guide(markdown.replace('{"allow": false}', "{allow: false}")),
      ),
    /guide\.md: invalid JSON code block/u,
  );
});

test("rejects authored executable, unlabeled, and indented code blocks", () => {
  for (const markdown of [
    "# Guide\n\n```ts\nconst value = 1;\n```\n",
    "# Guide\n\n~~~tsx\n<div />\n~~~\n",
    "# Guide\n\n> ```js\n> 42\n> ```\n",
    "# Guide\n\n```\nconst value = 1;\n```\n",
    "# Guide\n\n    const value = 1;\n",
  ]) {
    assert.throws(
      () => expandPageExamples(guide(markdown)),
      /source-backed excerpt/u,
    );
  }
});
