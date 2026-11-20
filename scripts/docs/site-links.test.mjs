import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { loadPageExamples } from "./site-examples.mjs";
import { exampleFileReader, markdownLink } from "./site-links.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dads-doc-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map();
  const pages = new Map();
  const source = "docs/guides/start.md";
  return {
    root,
    files,
    pages,
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
        source,
        target,
      });
    },
  };
}

test("links to rendered repository Markdown and keeps the source artifact", (t) => {
  const { link, write, files } = fixture(t);
  const path = "packages/my kit/README.md";
  const markdown = "# Try it\n\nnpm run verify\n";
  write(path, markdown);

  assert.equal(
    link("../../packages/my%20kit/?view=1#try-it"),
    "https://github.com/brytoncooper/dads-framework/blob/main/packages/my%20kit/README.md?view=1#try-it",
  );
  assert.equal(files.get(`source/${path}`)?.toString(), markdown);
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

test("loads catalogue source and proof without page links", (t) => {
  const { root, files, write } = fixture(t);
  const source = "examples/sample.tsx";
  const proof = "examples/sample.test.tsx";
  write(source, "export const example = <span />;");
  write(proof, 'test("renders the example", () => {});');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "--", source, proof], { cwd: root });

  loadPageExamples(
    { path: "guide.md", examples: [{ source, proof }] },
    exampleFileReader(root, files),
  );
  assert.equal(
    files.get(`source/${source}`).toString(),
    "export const example = <span />;",
  );
  assert.ok(files.has(`source/${proof}`));
});

test("rejects private, untracked and symlink example paths", (t) => {
  const { root, files, write } = fixture(t);
  write("docs/private/secret.ts", "private example");
  write("examples/untracked.ts", "work in progress");
  symlinkSync("../docs/private/secret.ts", join(root, "examples/alias.ts"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync(
    "git",
    ["add", "--", "docs/private/secret.ts", "examples/alias.ts"],
    { cwd: root },
  );
  const readFile = exampleFileReader(root, files);

  assert.throws(() => readFile("docs/private/secret.ts"), /cannot expose/u);
  assert.throws(() => readFile("examples/alias.ts"), /point directly/u);
  assert.throws(
    () => readFile("examples/untracked.ts"),
    /tracked repository file/u,
  );
  assert.throws(() => readFile("../outside.ts"), /tracked repository file/u);
  assert.equal(files.size, 0);
});
