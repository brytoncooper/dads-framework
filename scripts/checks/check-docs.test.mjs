import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkDocs } from "./check-docs.mjs";

const commands = [
  { name: "plan", options: ["--manifest", "--report", "--json"] },
  { name: "init", options: ["--manifest", "--force", "--json"] },
];

const conformantReadme = [
  "# `@dads-framework/testing`",
  "",
  "Plans and runs only the tests a change can affect.",
  "",
  "## Try it",
  "",
  "```sh",
  "npx dad-test plan --json",
  "```",
  "",
  "## Commands",
  "",
  "- `dad-test plan --manifest <path> --report [path] --json`",
  "- `dad-test init --manifest <path> --force --json`",
  "",
  "## What it refuses to do",
  "",
  "It refuses to guess a task it cannot see in the manifest.",
  "",
].join("\n");

/**
 * Writes the smallest workspace `checkDocs` reads: a conformance list, one
 * package manifest nested the way a domain folder nests it, and that
 * package's README.
 */
function createWorkspace(readme) {
  const root = mkdtempSync(join(tmpdir(), "dads-check-docs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "readme-conformance.json"),
    `${JSON.stringify({ packages: ["@dads-framework/testing"] }, null, 2)}\n`,
  );

  const packageDirectory = join(root, "packages", "testing", "core");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@dads-framework/testing" }, null, 2)}\n`,
  );
  writeFileSync(join(packageDirectory, "README.md"), readme);
  return root;
}

function checkWorkspace(t, readme) {
  const root = createWorkspace(readme);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return checkDocs({ root, commands });
}

test("a conformant README passes", (t) => {
  const result = checkWorkspace(t, conformantReadme);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "docs: conformant (1 packages, 2 commands)\n");
});

test("a missing refusal heading fails", (t) => {
  const readme = conformantReadme.replace("## What it refuses to do", "## What it will not do");

  const result = checkWorkspace(t, readme);

  assert.equal(result.exitCode, 1);
  assert.equal(result.output, 'packages/testing/core/README.md: no "## What it refuses to do" heading\n');
});

test("a README that omits an option fails", (t) => {
  const readme = conformantReadme.replace(" --report [path]", "");

  const result = checkWorkspace(t, readme);

  assert.equal(result.exitCode, 1);
  assert.equal(result.output, "packages/testing/core/README.md: does not document --report (accepted by plan)\n");
});

test("a README missing the H1, the paragraph, and the example reports all three", (t) => {
  const result = checkWorkspace(
    t,
    ["Prose where the H1 should be.", "", "## What it refuses to do", "", "Nothing, apparently.", ""].join("\n"),
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /first non-empty line is not an H1 heading/);
  assert.match(result.output, /no paragraph between the H1/);
  assert.match(result.output, /no fenced code block/);
});

test("a subpath is checked against the README in its owning package", (t) => {
  const root = createWorkspace(conformantReadme);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "packages/testing/core");
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@dads-framework/testing",
      exports: { "./nx": "./dist/nx/index.js" },
    }),
  );
  writeFileSync(
    join(root, "docs/readme-conformance.json"),
    JSON.stringify({ packages: ["@dads-framework/testing/nx"] }),
  );
  const missingReadme = checkDocs({ root, commands });
  assert.match(missingReadme.output, /packages\/testing\/core\/nx\/README.md: missing/u);

  mkdirSync(join(packageDirectory, "nx"));
  writeFileSync(join(packageDirectory, "nx/README.md"), conformantReadme);
  assert.equal(checkDocs({ root, commands }).exitCode, 0);

  writeFileSync(
    join(root, "docs/readme-conformance.json"),
    JSON.stringify({ packages: ["@dads-framework/testing/missing"] }),
  );
  const missingExport = checkDocs({ root, commands });
  assert.match(missingExport.output, /no package or exported subpath/u);
});
