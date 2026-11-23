import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { isRecord } from "../parse-guards.js";
import { initializeDadsProject } from "../initialize-dads-project.js";
import { checkDomainBoundaries } from "./check-domain-boundaries.js";

const roots: string[] = [];
const example = fileURLToPath(new URL("../../../../../fixtures/domain-boundaries/", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("defaults let two APIs compose different domains with a neutral library", () => {
  expect(checkDomainBoundaries(example)).toEqual({ ok: true, violations: [] });
});

test("rejects literal imports through aliases, re-exports, and relative paths", () => {
  const project = copyExample();
  const file = "domains/orders/bad-order-import.ts";
  cpSync(join(project, "examples/bad-order-import.txt"), join(project, file));
  source(
    project,
    "domains/orders/more-imports.ts",
    [
      'export { createInventory } from "@app/inventory";',
      'import type { createInventory } from "../inventory/index.js";',
      'export type InventoryFactory = typeof import("@app/inventory").createInventory;',
      "export const load = () => import(`@app/inventory`);",
      'export const loadCommonJs = () => require("../inventory/index.js");',
    ].join("\n"),
  );

  const result = checkDomainBoundaries(project);
  expect(result.ok).toBe(false);
  expect(result.violations.map(({ line }) => line)).toEqual([1, 1, 2, 3, 4, 5]);
  const issue = result.violations.find((violation) => violation.source === file);
  expect(issue).toMatchObject({
    line: 1,
    column: 1,
    target: "domains/inventory/index.ts",
    specifier: "@app/inventory",
  });
  expect(issue?.message).toContain("consuming domain");
});

test("prevents bypass through neutral library barrels and deep imports in composition", () => {
  const project = copyExample();
  source(
    project,
    "libraries/product-id/src/index.ts",
    'export { createInventory } from "../../../domains/inventory/index.js";\n',
  );
  source(
    project,
    "apps/staff/src/private.ts",
    'export { createInventory } from "../../../domains/inventory/stock.js";\n',
  );
  source(project, "assembly/public.ts", 'export { createInventory } from "../domains/inventory/index.js";\n');
  const result = checkDomainBoundaries(project);
  expect(result.violations.map(({ source }) => source)).toEqual([
    "apps/staff/src/private.ts",
    "libraries/product-id/src/index.ts",
  ]);
});

test("resolves workspace package exports through real paths", () => {
  const project = copyExample();
  const library = "libraries/product-id";
  source(
    project,
    `${library}/package.json`,
    JSON.stringify({
      name: "product-id",
      exports: { ".": "./dist/index.d.ts", "./private": "./dist/private.d.ts" },
    }),
  );
  source(project, `${library}/dist/index.d.ts`, "export type ProductId = string;\n");
  source(project, `${library}/dist/private.d.ts`, "export type PrivateId = string;\n");
  mkdirSync(join(project, "node_modules"));
  symlinkSync(join(project, library), join(project, "node_modules/product-id"), "junction");
  source(
    project,
    "domains/orders/consumer.mts",
    [
      'import type { ProductId } from "product-id";',
      'import type { PrivateId } from "product-id/private";',
      "export type Ids = ProductId | PrivateId;",
    ].join("\n"),
  );

  const result = checkDomainBoundaries(project);
  expect(result.violations).toHaveLength(1);
  const [issue] = result.violations;
  expect(issue).toMatchObject({
    source: "domains/orders/consumer.mts",
    target: "libraries/product-id/dist/private.d.ts",
    line: 2,
  });
  expect(issue?.message).toContain("public index entry point");
});

test("new starters include the boundary gate and support src/domains", () => {
  const root = temporaryRoot();
  const project = join(root, "starter");
  initializeDadsProject({
    targetDirectory: project,
    projectName: "boundary-fixture",
    mode: "new",
  });
  const manifest: unknown = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  expect(scripts).toMatchObject({ "check:boundaries": "dad check boundaries" });
  expect(isRecord(scripts) && scripts["verify:checks"]).toContain("npm run check:boundaries");
  source(project, "src/domains/inventory/index.ts", "export const stock = 1;\n");
  source(project, "src/domains/orders/index.ts", 'export { stock } from "../inventory/index.js";\n');
  expect(checkDomainBoundaries(project).violations).toHaveLength(1);
});

function copyExample(): string {
  const root = temporaryRoot();
  cpSync(example, root, {
    recursive: true,
    filter: (path) => !["node_modules", "dist"].includes(basename(path)),
  });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dads-domain-test-"));
  roots.push(root);
  return root;
}

function source(root: string, file: string, content: string): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
