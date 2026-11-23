import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkPackageExamples,
  readReadmeExamples,
} from "./package-examples.mjs";

const marker = "<!-- dads:check-example -->";

function fence(language, code) {
  return ["```" + language, code, "```"].join("\n");
}

function tryIt(...blocks) {
  return ["# Package", "## Try it", ...blocks, ""].join("\n\n");
}

test("accepts command, CSS, and configuration examples", () => {
  for (const [language, code] of [
    ["sh", "dad-test --help"],
    ["powershell", "dad-test --help"],
    ["css", '@import "@dads-framework/ui/styles/index.css";'],
    ["json", '{"scripts":{"dev":"dad dev"}}'],
  ]) {
    assert.deepEqual(readReadmeExamples(tryIt(fence(language, code))), {
      errors: [],
      snippets: [],
    });
  }
});

test("checks marked TS and TSX while allowing supplemental fragments", () => {
  const typeScript = "const label = 'Example';";
  const tsx = "const content = <span>Example</span>;";
  const result = readReadmeExamples(
    tryIt(
      marker,
      fence("ts", typeScript),
      fence("ts", "const partial = importedFromTheExampleAbove;"),
      "## Further examples",
      marker,
      fence("tsx", tsx),
    ),
  );
  assert.deepEqual(result, {
    errors: [],
    snippets: [
      { extension: "ts", code: typeScript },
      { extension: "tsx", code: tsx },
    ],
  });
});

test("requires real setup or usage and a marked TypeScript example", () => {
  assert.match(readReadmeExamples("# Package").errors[0], /missing/u);
  assert.match(
    readReadmeExamples(
      tryIt("See the example elsewhere.", "## Usage", fence("sh", "npm help")),
    ).errors[0],
    /needs a labeled/u,
  );
  assert.match(
    readReadmeExamples(tryIt(fence("ts", "const sample = 1;"))).errors[0],
    /mark a TypeScript/u,
  );
  assert.match(
    readReadmeExamples(
      tryIt(marker, "Intervening text.", fence("ts", "const sample = 1;")),
    ).errors[0],
    /needs a following/u,
  );
  assert.match(
    readReadmeExamples(tryIt(fence("sh", ""), fence("unrecognized", "example")))
      .errors[0],
    /needs a labeled/u,
  );
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "dads-package-readmes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const declarations = [
    { root: "packages/example", name: "@dads-framework/example" },
    {
      root: "packages/testing/native/linux-x64-gnu",
      name: "@dads-framework/native",
    },
    { root: "packages/private", name: "@dads-framework/private" },
    { root: "fixtures/example", name: "fixture-example" },
  ];

  function write(path, data) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }

  write("dads.project.json", JSON.stringify({ packages: declarations }));
  for (const entry of declarations) {
    write(
      `${entry.root}/package.json`,
      JSON.stringify({
        name: entry.name,
        private: entry.root === "packages/private",
      }),
    );
  }
  write(
    "packages/example/README.md",
    tryIt(marker, fence("ts", "const sample = 1;")),
  );
  write(
    "packages/testing/native/linux-x64-gnu/README.md",
    tryIt(fence("sh", "dad-test --help")),
  );
  return { root, write };
}

test("checks declared public packages, including nested natives", (t) => {
  const { root, write } = repository(t);
  write("node_modules/typescript-native/bin/tsc", "");
  assert.deepEqual(checkPackageExamples(root), { packages: 2, snippets: 1 });
  assert.deepEqual(readdirSync(join(root, ".dads")), []);

  write("packages/testing/native/linux-x64-gnu/README.md", "# Missing example");
  assert.throws(
    () => checkPackageExamples(root),
    /@dads-framework\/native: missing a ## Try it/u,
  );
});

test("labels compiler errors and cleans the workspace on failure", (t) => {
  const { root, write } = repository(t);
  write(
    "node_modules/typescript-native/bin/tsc",
    [
      "const path = process.argv.at(-1);",
      'process.stdout.write(path + "(1,1): error TS2322: invalid type");',
      "process.exitCode = 1;",
    ].join("\n"),
  );
  assert.throws(
    () => checkPackageExamples(root),
    /@dads-framework\/example README\.md \(example 1\)\(1,1\): error TS2322/u,
  );
  assert.deepEqual(readdirSync(join(root, ".dads")), []);
});
