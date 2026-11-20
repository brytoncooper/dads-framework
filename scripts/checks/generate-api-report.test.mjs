import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { diffLines, resolveEntryPoints } from "./generate-api-report-lib.mjs";
import { main } from "./generate-api-report.mjs";

const PACKAGE_NAME = "@dads-example/widget";
const PACKAGE_DIRECTORY = "packages/example/widget";
const REPORT_PATH = `${PACKAGE_DIRECTORY}/api-report.md`;

const INDEX_DECLARATIONS = `export declare function createWidget(name: string): Widget;
export declare function renameWidget(widget: Widget, name: string): Widget;
export type Widget = {
    name: string;
};
export { WIDGET_VERSION } from "./version.js";
`;

const VERSION_DECLARATIONS = `export declare const WIDGET_VERSION: "1";
`;

const FENCE = "```";

const EXPECTED_REPORT = `# API report: ${PACKAGE_NAME}

Published: no

Regenerate with \`npm run api-report\`.

Entry point: ${PACKAGE_NAME}

${FENCE}
- const WIDGET_VERSION: export declare const WIDGET_VERSION: "1";
- type Widget: export type Widget = { name: string; };
- function createWidget: export declare function createWidget(name: string): Widget;
- function renameWidget: export declare function renameWidget(widget: Widget, name: string): Widget;
${FENCE}
`;

/** A repository root holding one publishable package with emitted types. */
function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "api-report-"));
  const directory = join(root, PACKAGE_DIRECTORY);
  try {
    mkdirSync(join(directory, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dads.project.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packages: [
          {
            name: PACKAGE_NAME,
            root: PACKAGE_DIRECTORY,
            published: false,
          },
        ],
      })}\n`,
    );
    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify({
        name: PACKAGE_NAME,
        version: "0.0.0",
        type: "module",
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        },
        publishConfig: { access: "public" },
      })}\n`,
    );
    writeFileSync(join(directory, "dist", "index.d.ts"), INDEX_DECLARATIONS);
    writeFileSync(
      join(directory, "dist", "version.d.ts"),
      VERSION_DECLARATIONS,
    );
    run({ root, directory });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("writes one line per export, sorted by name", () => {
  withFixture(({ root, directory }) => {
    const result = main([], { root });

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /1 of 1 reports rewritten/);
    assert.equal(
      readFileSync(join(directory, "api-report.md"), "utf8"),
      EXPECTED_REPORT,
    );
  });
});

test("a second write leaves an up-to-date report untouched", () => {
  withFixture(({ root }) => {
    main([], { root });
    const result = main([], { root });

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /\(unchanged\)/);
    assert.match(result.output, /0 of 1 reports rewritten/);
  });
});

test("--check passes on a committed report and writes nothing", () => {
  withFixture(({ root, directory }) => {
    main([], { root });
    writeFileSync(join(directory, "dist", "index.d.ts"), INDEX_DECLARATIONS);

    const result = main(["--check"], { root });

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /api-report: clean \(1 packages\)/);
    assert.equal(
      readFileSync(join(directory, "api-report.md"), "utf8"),
      EXPECTED_REPORT,
    );
  });
});

test("--check fails with a diff when the surface changes", () => {
  withFixture(({ root, directory }) => {
    main([], { root });
    writeFileSync(
      join(directory, "dist", "index.d.ts"),
      INDEX_DECLARATIONS.replace(
        "renameWidget(widget: Widget, name: string)",
        "relabelWidget(widget: Widget, label: string)",
      ),
    );

    const result = main(["--check"], { root });

    assert.equal(result.exitCode, 1);
    assert.match(
      result.output,
      new RegExp(`--- ${REPORT_PATH} \\(committed\\)`),
    );
    assert.match(
      result.output,
      new RegExp(`\\+\\+\\+ ${REPORT_PATH} \\(regenerated\\)`),
    );
    assert.match(result.output, /^-- function renameWidget: /m);
    assert.match(result.output, /^\+- function relabelWidget: /m);
    assert.match(result.output, /1 report\(s\) out of date/);
    assert.equal(
      readFileSync(join(directory, "api-report.md"), "utf8"),
      EXPECTED_REPORT,
    );
  });
});

// The compiler prints a union in type-creation order, so the same surface can
// be emitted with its members in a different order by a fresh build and by an
// incremental one. Both orders must render as the same report line, or
// `--check` fails on a line nobody wrote.
const UNION_DECLARATIONS = `export type Outcome = "blocked" | "no-op" | "ready";
export declare function decide(input: { mode: "fast" | "slow"; }): Outcome | undefined;
`;

const REORDERED_UNION_DECLARATIONS = `export type Outcome = "ready" | "blocked" | "no-op";
export declare function decide(input: { mode: "slow" | "fast"; }): undefined | Outcome;
`;

test("a reordered union is the same report line, not a diff", () => {
  withFixture(({ root, directory }) => {
    const index = join(directory, "dist", "index.d.ts");
    writeFileSync(index, UNION_DECLARATIONS);
    main([], { root });
    const written = readFileSync(join(directory, "api-report.md"), "utf8");

    writeFileSync(index, REORDERED_UNION_DECLARATIONS);
    const result = main(["--check"], { root });

    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /api-report: clean/);
    assert.ok(
      written.includes(
        '- type Outcome: export type Outcome = "blocked" | "no-op" | "ready";',
      ),
      written,
    );
    assert.ok(
      written.includes(
        "- function decide: export declare function decide(input: " +
          '{ mode: "fast" | "slow"; }): Outcome | undefined;',
      ),
      written,
    );
  });
});

test("--json reports the surface machine-readably", () => {
  withFixture(({ root }) => {
    const result = main(["--json"], { root });
    const payload = JSON.parse(result.output);

    assert.equal(result.exitCode, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "write");
    assert.deepEqual(payload.packages, [
      {
        changed: true,
        diff: [],
        entryPoints: 1,
        exports: 4,
        name: PACKAGE_NAME,
        published: false,
        report: REPORT_PATH,
      },
    ]);
  });
});

test("missing declarations point at typecheck, in both modes", () => {
  withFixture(({ root, directory }) => {
    rmSync(join(directory, "dist"), { recursive: true, force: true });

    for (const argv of [[], ["--check"]]) {
      const result = main(argv, { root });

      assert.equal(result.exitCode, 1);
      assert.match(result.output, /run npm run typecheck first/);
    }
  });
});

test("--package narrows the run and rejects an unknown name", () => {
  withFixture(({ root }) => {
    assert.equal(main(["--package", PACKAGE_NAME], { root }).exitCode, 0);

    const result = main(["--package", "@dads-example/absent"], { root });

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /No publishable package is named/);
  });
});

test("an unknown argument fails instead of being ignored", () => {
  withFixture(({ root }) => {
    const result = main(["--fix"], { root });

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Unknown argument --fix/);
  });
});

test("entry points cover subpaths, conditions, and the types fallback", () => {
  assert.deepEqual(
    resolveEntryPoints({
      name: "@dads-example/widget",
      exports: {
        "./testing": { types: "./dist/testing/index.d.ts" },
        ".": { import: "./dist/index.js" },
        "./generated/*": { types: "./dist/generated/*.d.ts" },
      },
    }),
    [
      {
        subpath: ".",
        specifier: "@dads-example/widget",
        target: "./dist/index.d.ts",
      },
      {
        subpath: "./testing",
        specifier: "@dads-example/widget/testing",
        target: "./dist/testing/index.d.ts",
      },
    ],
  );

  assert.deepEqual(
    resolveEntryPoints({ name: "legacy", types: "./dist/index.d.ts" }),
    [{ subpath: ".", specifier: "legacy", target: "./dist/index.d.ts" }],
  );
});

test("the diff keeps context and caps its own length", () => {
  const before = ["a", "b", "c", "d", "e"].join("\n");
  const after = ["a", "b", "C", "d", "e"].join("\n");

  assert.deepEqual(diffLines(before, after), [
    " a",
    " b",
    "-c",
    "+C",
    " d",
    " e",
  ]);

  const long = diffLines(
    "",
    Array.from({ length: 90 }, (_, i) => i).join("\n"),
  );
  assert.equal(long.length, 61);
  assert.equal(long.at(-1), "... 30 more diff lines");
});
