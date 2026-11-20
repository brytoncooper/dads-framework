import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDependencyBoundaries,
  render,
} from "./check-dependency-boundaries.mjs";

/**
 * Every fixture is a `dads.project.json`, a `package.json`, and whatever source
 * or emitted `.d.ts` the gate under test reads — all in memory, so no test here
 * depends on the state of the repository it is running in.
 */
function createWorld(files) {
  const contents = new Map(Object.entries(files));
  return {
    exists: (path) => contents.has(path),
    read: (path) => {
      const value = contents.get(path);
      if (value === undefined) throw new Error(`no such file: ${path}`);
      return value;
    },
    listFiles: (directory) =>
      [...contents.keys()]
        .filter((path) => path.startsWith(`${directory}/`))
        .sort(),
  };
}

function declaration(overrides = {}) {
  return {
    name: "@fixture/one",
    root: "packages/one",
    responsibility: "Proves one boundary gate.",
    kind: "core",
    allowedDependencies: [],
    verification: [],
    skills: [],
    ...overrides,
  };
}

function projectFile(...packages) {
  return JSON.stringify({ schemaVersion: 1, packages });
}

function manifest(overrides = {}) {
  return JSON.stringify({
    name: "@fixture/one",
    version: "0.0.0",
    ...overrides,
  });
}

function gatesOf(result) {
  return result.violations.map((violation) => violation.gate);
}

// ---------------------------------------------------------------------------
// Gate: imports
// ---------------------------------------------------------------------------

test("a production import of an unlisted package is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/src/index.ts": 'import { z } from "zod";\n',
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["imports"]);
  assert.equal(result.violations[0].dependency, "zod");
  assert.equal(result.violations[0].file, "packages/one/src/index.ts");
});

test("relative, builtin, and allowed imports pass", () => {
  const world = createWorld({
    "dads.project.json": projectFile(
      declaration({ allowedDependencies: ["zod"] }),
    ),
    "packages/one/src/index.ts":
      'import { readFileSync } from "node:fs";\nimport { z } from "zod";\nimport { local } from "./local.js";\nimport { deep } from "zod/v4";\n',
  });

  assert.deepEqual(checkDependencyBoundaries(world).violations, []);
});

test("test files are outside the import gate", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/src/index.test.ts": 'import { expect } from "vitest";\n',
  });

  assert.deepEqual(checkDependencyBoundaries(world).violations, []);
});

// ---------------------------------------------------------------------------
// Gate: declared dependencies
// ---------------------------------------------------------------------------

test("an installed dependency the declaration omits is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({ dependencies: { pg: "^8.13.0" } }),
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["declared-dependencies"]);
  assert.match(result.violations[0].message, /declares "pg" in dependencies/u);
});

test("a peer dependency the declaration omits is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      peerDependencies: { react: ">=18" },
    }),
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["declared-dependencies"]);
  assert.match(
    result.violations[0].message,
    /declares "react" in peerDependencies/u,
  );
});

test("a third-party allowance nothing installs is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(
      declaration({ allowedDependencies: ["drizzle-orm"] }),
    ),
    "packages/one/package.json": manifest(),
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["declared-dependencies"]);
  assert.match(result.violations[0].message, /allows "drizzle-orm"/u);
});

test("a workspace allowance needs no manifest entry", () => {
  const world = createWorld({
    "dads.project.json": projectFile(
      declaration({ allowedDependencies: ["@fixture/two"] }),
      declaration({ name: "@fixture/two", root: "packages/two" }),
    ),
    "packages/one/package.json": manifest(),
    "packages/two/package.json": manifest({ name: "@fixture/two" }),
  });

  assert.deepEqual(checkDependencyBoundaries(world).violations, []);
});

test("devDependencies are outside the declaration gate", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      devDependencies: { vitest: "^4.1.0" },
    }),
  });

  assert.deepEqual(checkDependencyBoundaries(world).violations, []);
});

test("a package without a manifest is only held to the import gate", () => {
  const world = createWorld({
    "dads.project.json": projectFile(
      declaration({ name: "crate", root: "crates/one" }),
    ),
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(result.violations, []);
  assert.equal(result.checkedPackages, 1);
});

// ---------------------------------------------------------------------------
// Gate: public surface
// ---------------------------------------------------------------------------

test("a foreign type in a published surface is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
    }),
    "packages/one/dist/index.d.ts":
      'import type { Pool } from "pg";\nexport declare function open(): Pool;\n',
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["public-surface"]);
  assert.equal(result.violations[0].dependency, "pg");
  assert.deepEqual(result.skippedSurfaces, []);
});

test("an inline import() type in a published surface is a violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
    }),
    "packages/one/dist/index.d.ts":
      'export declare const client: import("@tanstack/react-query").QueryClient;\n',
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["public-surface"]);
  assert.equal(result.violations[0].dependency, "@tanstack/react-query");
});

test("the package itself, an allowed dependency, and node: all pass", () => {
  const world = createWorld({
    "dads.project.json": projectFile(
      declaration({ allowedDependencies: ["zod"] }),
    ),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
      dependencies: { zod: "^4.0.0" },
    }),
    "packages/one/dist/index.d.ts":
      'import type { z } from "zod";\nimport type { Field } from "@fixture/one/fields";\nimport type { Stats } from "node:fs";\nexport type { Local } from "./local.js";\n',
  });

  assert.deepEqual(checkDependencyBoundaries(world).violations, []);
});

test("an exports subpath surface is checked too", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./testing": {
          types: "./dist/testing/index.d.ts",
          default: "./dist/testing/index.js",
        },
      },
    }),
    "packages/one/dist/index.d.ts": "export declare const one: 1;\n",
    "packages/one/dist/testing/index.d.ts":
      'export type { Harness } from "vitest";\n',
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(gatesOf(result), ["public-surface"]);
  assert.equal(
    result.violations[0].file,
    "packages/one/dist/testing/index.d.ts",
  );
});

test("an unbuilt package is skipped, not failed", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
    }),
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.skippedSurfaces, ["@fixture/one"]);
});

test("an unpublished package has no public surface to check", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest(),
    "packages/one/dist/index.d.ts": 'export type { Pool } from "pg";\n',
  });

  const result = checkDependencyBoundaries(world);

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.skippedSurfaces, []);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

test("--json reports ok and every violation", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/src/index.ts": 'import { z } from "zod";\n',
  });

  const parsed = JSON.parse(render(checkDependencyBoundaries(world), true));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.violations.length, 1);
  assert.equal(parsed.checkedPackages, 1);
});

test("human output names the gate, and the skip is not a failure", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/package.json": manifest({
      publishConfig: { access: "public" },
    }),
  });

  const output = render(checkDependencyBoundaries(world), false);

  assert.match(output, /public-surface: skipped \(no dist\)/u);
  assert.match(output, /dependency boundaries: ok — 1 packages/u);
});

test("human output ends with the violation count", () => {
  const world = createWorld({
    "dads.project.json": projectFile(declaration()),
    "packages/one/src/index.ts": 'import { z } from "zod";\n',
  });

  const output = render(checkDependencyBoundaries(world), false);

  assert.match(output, /^imports: @fixture\/one imports "zod"/u);
  assert.match(output, /dependency boundaries: 1 violation\n$/u);
});
