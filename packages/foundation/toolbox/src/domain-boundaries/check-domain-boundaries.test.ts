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

test("enforces workflows and integrations boundary rules with explicit glob arrays", () => {
  const project = copyExample();
  const manifest: unknown = JSON.parse(readFileSync(join(project, "dads.project.json"), "utf8"));
  if (!isRecord(manifest)) throw new Error("Expected object manifest.");
  writeFileSync(
    join(project, "dads.project.json"),
    `${JSON.stringify({
      ...manifest,
      domainBoundaries: {
        domains: ["domains/*"],
        libraries: ["libraries/*"],
        workflows: ["workflows/*"],
        integrations: ["integrations/*"],
        composition: ["src/composition", "apps/*", "assembly"],
      },
    })}\n`,
  );

  source(
    project,
    "integrations/payments/index.ts",
    'import type { ProductId } from "../../libraries/product-id/src/index.js";\nexport const charge = (id: ProductId) => id;\n',
  );
  source(
    project,
    "workflows/checkout/index.ts",
    [
      'import { createInventory } from "../../domains/inventory/index.js";',
      'import { createOrders } from "../../domains/orders/index.js";',
      'import { charge } from "../../integrations/payments/index.js";',
      'import type { ProductId } from "../../libraries/product-id/src/index.js";',
      "export const run = (id: ProductId) => ({ createInventory, createOrders, charged: charge(id) });",
      "",
    ].join("\n"),
  );
  expect(checkDomainBoundaries(project)).toEqual({ ok: true, violations: [] });

  source(
    project,
    "workflows/checkout/deep.ts",
    'export { createInventory } from "../../domains/inventory/stock.js";\n',
  );
  source(project, "domains/orders/calls-workflow.ts", 'export { run } from "../../workflows/checkout/index.js";\n');
  source(
    project,
    "libraries/product-id/src/calls-workflow.ts",
    'export { run } from "../../../workflows/checkout/index.js";\n',
  );
  source(
    project,
    "integrations/payments/bad-imports.ts",
    [
      'import { createInventory } from "../../domains/inventory/index.js";',
      'import { run } from "../../workflows/checkout/index.js";',
      "export const leaked = { createInventory, run };",
      "",
    ].join("\n"),
  );

  const result = checkDomainBoundaries(project);
  expect(result.ok).toBe(false);
  expect(result.violations.map((item) => `${item.source}:${item.line}`)).toEqual([
    "domains/orders/calls-workflow.ts:1",
    "integrations/payments/bad-imports.ts:1",
    "integrations/payments/bad-imports.ts:2",
    "libraries/product-id/src/calls-workflow.ts:1",
    "workflows/checkout/deep.ts:1",
  ]);
});

test("supports flat workflow files under workflows/ with default boundaries", () => {
  const project = copyExample();
  source(project, "workflows/fulfill-order.ts", 'export { createInventory } from "../domains/inventory/index.js";\n');
  expect(checkDomainBoundaries(project)).toEqual({ ok: true, violations: [] });

  source(
    project,
    "domains/orders/uses-flat-workflow.ts",
    'export { createInventory } from "../../workflows/fulfill-order.js";\n',
  );
  const result = checkDomainBoundaries(project);
  expect(result.ok).toBe(false);
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]?.message).toContain("cannot import workflows");
});

test("enforces intra-domain layering for pure/, contract/, and access/ modules", () => {
  const project = copyExample();
  source(project, "domains/orders/contract/types.ts", "export type OrderTotal = number;\n");
  source(
    project,
    "domains/orders/pure/pricing.ts",
    'import type { OrderTotal } from "../contract/types.js";\nexport const tax = (total: OrderTotal) => total * 0.1;\n',
  );
  source(
    project,
    "domains/orders/server/repo.ts",
    'import { tax } from "../pure/pricing.js";\nexport type RepoRow = { readonly id: string };\nexport const compute = () => tax(10);\n',
  );
  source(project, "domains/orders/access/rules.ts", "export const rules = [];\n");
  expect(checkDomainBoundaries(project)).toEqual({ ok: true, violations: [] });

  source(
    project,
    "domains/orders/pure/bad-server-import.ts",
    [
      'import type { RepoRow } from "../server/repo.js";',
      'import { compute } from "../server/repo.js";',
      "export const leaked = (row: RepoRow) => ({ row, total: compute() });",
      "",
    ].join("\n"),
  );
  source(
    project,
    "domains/orders/contract/bad-contract.ts",
    [
      'import { compute } from "../server/repo.js";',
      'import { tax } from "../pure/pricing.js";',
      "export const bad = () => compute() + tax(1);",
      "",
    ].join("\n"),
  );
  source(project, "domains/orders/access/bad-access.ts", 'export { compute } from "../server/repo.js";\n');
  source(project, "domains/orders/access.ts", 'export { compute } from "./server/repo.js";\n');

  const result = checkDomainBoundaries(project);
  expect(result.ok).toBe(false);
  expect(result.violations.map((item) => `${item.source}:${item.line}`)).toEqual([
    "domains/orders/access.ts:1",
    "domains/orders/access/bad-access.ts:1",
    "domains/orders/contract/bad-contract.ts:1",
    "domains/orders/contract/bad-contract.ts:2",
    "domains/orders/pure/bad-server-import.ts:1",
    "domains/orders/pure/bad-server-import.ts:2",
  ]);
});

test("rejects domain root index.ts barrels that mix server/ with web-client/ or ui/", () => {
  const project = copyExample();
  source(project, "domains/orders/server/plugin.ts", "export const ordersPlugin = {};\n");
  source(project, "domains/orders/web-client/index.ts", "export const ordersClient = {};\n");
  source(project, "domains/orders/ui/card.ts", "export const OrderCard = () => null;\n");
  source(project, "domains/orders/index.ts", 'export { ordersPlugin } from "./server/plugin.js";\n');
  expect(checkDomainBoundaries(project)).toEqual({ ok: true, violations: [] });

  source(
    project,
    "domains/orders/index.ts",
    [
      'export { ordersPlugin } from "./server/plugin.js";',
      'export { ordersClient } from "./web-client/index.js";',
      "",
    ].join("\n"),
  );
  const mixedWebClient = checkDomainBoundaries(project);
  expect(mixedWebClient.ok).toBe(false);
  expect(mixedWebClient.violations).toHaveLength(1);
  expect(mixedWebClient.violations[0]?.message).toContain("affected graphs");

  source(
    project,
    "domains/orders/index.ts",
    ['export { ordersPlugin } from "./server/plugin.js";', 'export { OrderCard } from "./ui/card.js";', ""].join("\n"),
  );
  const mixedUi = checkDomainBoundaries(project);
  expect(mixedUi.ok).toBe(false);
  expect(mixedUi.violations).toHaveLength(1);
  expect(mixedUi.violations[0]?.message).toContain("affected graphs");
});

test("allows top-level tests/ to import domain root barrels while rejecting deep domain internals", () => {
  const project = copyExample();
  const tsconfig: unknown = JSON.parse(readFileSync(join(project, "tsconfig.json"), "utf8"));
  if (!isRecord(tsconfig)) throw new Error("Expected object tsconfig.");
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify({ ...tsconfig, include: ["domains/**/*.ts", "libraries/**/*.ts", "src/**/*.ts", "tests/**/*.ts"] })}\n`,
  );
  source(project, "domains/orders/server/repo.ts", "export const secretRepo = 1;\n");
  source(project, "domains/orders/index.ts", 'export { secretRepo } from "./server/repo.js";\n');
  source(
    project,
    "tests/orders.integration.test.ts",
    'import { secretRepo } from "../domains/orders/index.js";\nexport const ok = secretRepo;\n',
  );
  expect(checkDomainBoundaries(project)).toEqual({ ok: true, violations: [] });

  source(
    project,
    "tests/orders-deep.integration.test.ts",
    'import { secretRepo } from "../domains/orders/server/repo.js";\nexport const bad = secretRepo;\n',
  );
  const result = checkDomainBoundaries(project);
  expect(result.ok).toBe(false);
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]).toMatchObject({
    source: "tests/orders-deep.integration.test.ts",
    target: "domains/orders/server/repo.ts",
  });
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
