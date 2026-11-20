import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { generateProjectArtifact } from "../cli-generator-commands.js";
import { parseGeneratorArguments } from "./generator-arguments.js";

const api = `// dad:add imports

const domains = [
  // dad:add domains
];
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dads-resource-gen-"));
  setup("dads.project.json", "{}");
  setup(
    "package.json",
    JSON.stringify({
      dependencies: { "@dads-framework/plugin": "0.1.0" },
    }),
  );
  setup("apps/customer/app.ts", api);
  setup("apps/staff/app.ts", api);
  setup(
    "assembly/migrations.ts",
    "// dad:add imports\nconst migrations = [\n  // dad:add migrations\n];\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup(path: string, source: string) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

function add(...args: string[]) {
  return generateProjectArtifact(root, parseGeneratorArguments(args));
}

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

it("generates all individual artifacts with no implicit API registration", () => {
  add("domain", "inventory");
  expect(read("apps/customer/app.ts")).toBe(api);
  expect(read("apps/staff/app.ts")).toBe(api);

  const commands = [
    ["endpoint", "status", "server/status-endpoint.ts"],
    ["table", "warehouse", "server/warehouse-table.ts"],
    ["access", "warehouse", "access/warehouse.ts"],
    ["flag", "beta", "server/beta-flag.ts"],
    ["email", "notice", "server/email/notice.ts"],
    ["page", "overview", "web-client/overview-page.ts"],
  ];
  for (const [kind, name, output] of commands) {
    if (kind === undefined || name === undefined || output === undefined) {
      throw new Error("Incomplete generator proof case.");
    }
    const artifact = `domains/inventory/${output}`;
    expect(add(kind, name, "--domain", "inventory").files).toContain(artifact);
    expect(add(kind, name, "--domain", "inventory").files).toEqual([]);
  }

  expect(read("apps/customer/app.ts")).toBe(api);
  expect(read("apps/staff/app.ts")).toBe(api);
  add("domain", "inventory", "--api", "staff");
  expect(read("apps/staff/app.ts")).toContain("inventoryPlugin,");
  expect(read("apps/customer/app.ts")).toBe(api);
});

it("chains resource pieces, preserves migration identity, and selects only the requested API", () => {
  const args = [
    "resource",
    "catalog",
    "--domain",
    "inventory",
    "--api",
    "customer",
  ];
  expect(add(...args).files).toContain(
    "domains/inventory/server/catalog-resource.test.ts",
  );
  expect(read("apps/customer/app.ts")).toContain("inventoryPlugin,");
  expect(read("apps/staff/app.ts")).toBe(api);
  expect(read("domains/inventory/contract/catalog-resource.ts")).toContain(
    "...expectedRowVersionFields",
  );
  expect(read("domains/inventory/server/catalog-writer.ts")).toContain(
    "updateAtRowVersion",
  );
  expect(read("domains/inventory/web-client/catalog-client.ts")).toContain(
    "saveWithRefresh",
  );
  expect(read("assembly/migrations.ts")).toContain("inventoryMigrations,");
  const web = read("domains/inventory/web-client/index.ts");
  expect(web).toContain(
    'export { listCatalog, readCatalog, saveCatalog } from "./catalog-client.js";',
  );
  expect(web).toContain(
    'export { CatalogListPage, CatalogDetailPage } from "./catalog-pages.js";',
  );
  expect(add(...args).files).toEqual([]);
  expect(
    readdirSync(join(root, "domains/inventory/server/migrations")),
  ).toHaveLength(1);
});

it("preflights invalid selections and collisions before writing and supports dry runs", () => {
  expect(() => add("resource", "catalog", "--api", "unknown")).toThrow(
    "Required registry",
  );
  expect(existsSync(join(root, "domains/catalog"))).toBe(false);

  const preview = add("resource", "catalog", "--api", "customer", "--dry-run");
  expect(preview.files).toContain("apps/customer/app.ts");
  expect(preview.dryRun).toBe(true);
  expect(read("apps/customer/app.ts")).toBe(api);

  setup("domains/catalog/server/catalog-table.ts", "locally authored");
  expect(() => add("resource", "catalog", "--api", "customer")).toThrow(
    "File already exists",
  );
  expect(read("domains/catalog/server/catalog-table.ts")).toBe(
    "locally authored",
  );
  expect(existsSync(join(root, "domains/catalog/index.ts"))).toBe(false);
});
