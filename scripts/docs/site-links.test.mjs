import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { sourceExcerpt } from "./site-excerpt.mjs";
import { markdownLink } from "./site-links.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dads-doc-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map();
  const pages = new Map();
  const linkedSources = new Set();
  const source = "docs/guides/start.md";
  return {
    files,
    pages,
    linkedSources,
    source,
    write(path, text) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    link(target) {
      return markdownLink({
        root,
        pages,
        files,
        linkedSources,
        source,
        target,
      });
    },
  };
}

test("links to rendered repository Markdown and keeps its local excerpt proof", (t) => {
  const { link, write, files, linkedSources, source } = fixture(t);
  const path = "packages/my kit/README.md";
  const markdown = "# Try it\n\nnpm run verify\n";
  write(path, markdown);

  assert.equal(
    link("../../packages/my%20kit/?view=1#try-it"),
    "https://github.com/brytoncooper/dads-framework/blob/main/packages/my%20kit/README.md?view=1#try-it",
  );
  assert.equal(files.get(`source/${path}`)?.toString(), markdown);
  const selection = {
    path,
    language: "sh",
    from: "npm run verify",
    through: "npm run verify",
  };
  const excerpt = sourceExcerpt({
    token: `<!-- dads:excerpt ${JSON.stringify(selection)} -->`,
    page: source,
    linkedSources,
    files,
  });
  assert.deepEqual(excerpt, { language: "sh", excerpt: "npm run verify" });
});

test("catalogued links, including directory README targets, stay on the site", (t) => {
  const { link, write, pages } = fixture(t);
  write("docs/reference/README.md", "# Reference\n");
  pages.set("docs/reference/README.md", { slug: "reference" });

  assert.equal(
    link("../reference/README.md#options"),
    "reference.html#options",
  );
  assert.equal(link("../reference/#options"), "reference.html#options");
});

test("keeps source links local and refuses private paths before routing", (t) => {
  const { link, write, files, pages } = fixture(t);
  write("examples/route.ts", "export const route = {};\n");
  pages.set("docs/private/README.md", { slug: "private" });

  assert.equal(
    link("../../examples/route.ts#L1"),
    "source/examples/route.ts#L1",
  );
  assert.ok(files.has("source/examples/route.ts"));
  assert.throws(() => link("../private/README.md"), /cannot expose/u);
  assert.throws(() => link("../../../README.md"), /cannot expose/u);
  assert.throws(() => link("./missing.md"), /has no file or directory README/u);
});
