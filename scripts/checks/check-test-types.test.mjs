import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  listPackageDirectories,
  planTestProjects,
} from "./check-test-types.mjs";

test("plans test types for direct and grouped package workspaces", (context) => {
  const root = mkdtempSync(join(tmpdir(), "dads-test-types-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  for (const file of [
    "packages/contract/package.json",
    "packages/contract/src/id.test.ts",
    "packages/contract/tsconfig.tests.json",
    "packages/access/package.json",
    "packages/access/src/access.test.tsx",
    "packages/server/http/package.json",
    "packages/server/http/src/route.test.ts",
    "packages/server/http/tsconfig.tests.json",
  ]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }

  const plan = planTestProjects({
    root,
    packageDirectories: listPackageDirectories(root),
  });

  assert.deepEqual(plan, {
    projects: [
      "packages/contract/tsconfig.tests.json",
      "packages/server/http/tsconfig.tests.json",
    ],
    missing: ["packages/access"],
    stale: [],
  });
});
