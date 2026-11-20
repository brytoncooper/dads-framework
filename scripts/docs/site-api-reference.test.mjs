import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport } from "../checks/generate-api-report-lib.mjs";
import { apiReferenceMarkdown } from "./site-api-reference.mjs";
import { renderPage } from "./site-render.mjs";

const name = "@dads-framework/sample";
const readme = "packages/sample/README.md";
const pagePath = "docs/site/reference/api-sample.md";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dads-site-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "packages/sample");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, readme), "# Sample package\n");
  writeFileSync(
    join(directory, "root.d.ts"),
    "export declare const read: string;\n",
  );
  writeFileSync(
    join(directory, "testing.d.ts"),
    [
      "export declare function read(key: string): number;",
      "export declare function read(key: number): string;",
      "export declare const Read: `value-${string}`;",
      "",
    ].join("\n"),
  );
  return {
    root,
    report: buildReport(
      {
        directory,
        name,
        manifest: {
          name,
          exports: { ".": "./root.d.ts", "./testing": "./testing.d.ts" },
        },
      },
      false,
    ),
  };
}

test("the rendered reference links every emitted symbol and keeps overloads", (t) => {
  const { root, report } = fixture(t);
  const markdown = apiReferenceMarkdown({
    name,
    readme,
    purpose: "Read sample records.",
    sections: report.sections,
  });
  const page = {
    title: name,
    owner: name,
    path: pagePath,
    slug: "api-sample",
    section: "API reference",
    markdown,
  };
  const files = new Map();
  const html = renderPage({
    root,
    page,
    pages: [page],
    byPath: new Map(),
    files,
  });

  assert.match(html, /id="api-report-dads-frameworksample"/u);
  assert.ok(
    html.includes(
      'href="https://github.com/brytoncooper/dads-framework/blob/main/packages/sample/README.md"',
    ),
  );
  assert.match(
    html,
    /href="https:\/\/www\.npmjs\.com\/package\/@dads-framework\/sample"/u,
  );
  assert.equal(
    files.get(`source/${readme}`).toString("utf8"),
    "# Sample package\n",
  );
  assert.doesNotMatch(html, /Published:/u);

  const ids = [...html.matchAll(/<h[1-4] id="([^"]+)"/gu)].map(([, id]) => id);
  const targets = [...html.matchAll(/href="#([^"]+)"/gu)]
    .map(([, id]) => id)
    .slice(1);
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(targets, [
    "import-dads-frameworksample",
    "import-dads-frameworksampletesting",
    "read",
    "read-testing",
    "read-testing-1",
  ]);
  assert.ok(targets.every((target) => ids.includes(target)));
  for (const { exports } of report.sections) {
    for (const { signature } of exports)
      assert.ok(markdown.split("\n").includes(signature));
  }
});

test("a large import path adds letter navigation without rendering every signature", () => {
  const exports = Array.from({ length: 205 }, (_, index) => {
    const name = `${index % 2 === 0 ? "Arrow" : "Box"}${index}`;
    return { name, kind: "const", signature: `declare const ${name}: string;` };
  });
  const markdown = apiReferenceMarkdown({
    name,
    readme,
    purpose: "Read sample records.",
    sections: [{ specifier: `${name}/icons`, exports }],
  });

  assert.match(markdown, /### Symbols A/u);
  assert.match(markdown, /### Symbols B/u);
  assert.match(markdown, /103 symbols\. Examples:/u);
  assert.match(markdown, /102 symbols\. Examples:/u);
  assert.match(markdown, /Markdown source/u);
  assert.doesNotMatch(markdown, /declare const/u);
});
