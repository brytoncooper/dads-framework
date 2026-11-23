import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      dependencies: { "@dads-framework/core": "0.1.0" },
    }),
  );
  setup("apps/customer/app.ts", api);
  setup("apps/staff/app.ts", api);
  setup("assembly/migrations.ts", "// dad:add imports\nconst migrations = [\n  // dad:add migrations\n];\n");
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
  expect(read("domains/inventory/pure/inventory.ts")).toContain("export function normalizeInventory(");
  expect(read("domains/inventory/pure/inventory.test.ts")).toContain("normalizeInventory");

  add("domain", "orders");
  const ordersContract = read("domains/orders/contract/index.ts");
  expect(ordersContract).toContain('import { entityIdSchema } from "@dads-framework/core/contract";');
  expect(ordersContract).toContain('export const orderIdSchema = entityIdSchema("OrderId", "Order identifier.");');
  expect(ordersContract).toContain("export type OrderId = z.infer<typeof orderIdSchema>;");
  expect(ordersContract).toContain("id: orderIdSchema,");

  const ordersAccess = read("domains/orders/access/index.ts");
  expect(ordersAccess).toContain('import { orderIdSchema } from "../contract/index.js";');
  expect(ordersAccess).toContain('resource("order", {');
  expect(ordersAccess).toContain("id: orderIdSchema,");

  const ordersPure = read("domains/orders/pure/order.ts");
  expect(ordersPure).toContain('import type { OrderId } from "../contract/index.js";');
  expect(ordersPure).toContain("readonly id: OrderId;");
  expect(ordersPure).toContain("export function normalizeOrder(");
  expect(read("domains/orders/pure/order.test.ts")).toContain("mintEntityId(orderIdSchema)");

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

  const generatedAccess = read("domains/inventory/access/warehouse.ts");
  expect(generatedAccess).toContain('resource("inventory/warehouse"');
  expect(generatedAccess).toContain("roles: { editor: account }");
  expect(generatedAccess).not.toContain("entityHandle");
  expect(generatedAccess).not.toContain('kind: "record"');
  expect(generatedAccess).not.toContain("accountEntity");

  const generatedEndpointTest = read("domains/inventory/server/status-endpoint.test.ts");
  expect(generatedEndpointTest).toContain("account.wireName");
  expect(generatedEndpointTest).not.toContain("accountEntity");

  add("domain", "inventory", "--api", "staff");
  expect(read("apps/staff/app.ts")).toContain("inventoryPlugin,");
  expect(read("apps/customer/app.ts")).toBe(api);
});

it("chains resource pieces, preserves migration identity, and selects only the requested API", () => {
  const args = ["resource", "catalog", "--domain", "inventory", "--api", "customer"];
  expect(add(...args).files).toContain("domains/inventory/server/catalog-resource.test.ts");
  expect(read("apps/customer/app.ts")).toContain("inventoryPlugin,");
  expect(read("apps/staff/app.ts")).toBe(api);
  expect(read("domains/inventory/contract/catalog-resource.ts")).toContain("...expectedRowVersionFields");
  expect(read("domains/inventory/server/catalog-writer.ts")).toContain("updateAtRowVersion");
  expect(read("domains/inventory/web-client/catalog-client.ts")).toContain("saveWithRefresh");
  const generatedGuards = read("domains/inventory/access/catalog-guards.ts");
  expect(generatedGuards).toContain("requires(");
  expect(generatedGuards).not.toContain('kind: "permission"');
  expect(generatedGuards).not.toContain("accountEntity");

  const generatedProof = read("domains/inventory/server/catalog-resource.test.ts");
  expect(generatedProof).toContain("@dads-framework/access/testing");
  expect(generatedProof).toContain("account.wireName");
  expect(generatedProof).not.toContain("accountEntity");
  expect(generatedProof).not.toContain("@dads-framework/spicedb-access/testing");

  expect(read("assembly/migrations.ts")).toContain("inventoryMigrations,");
  const web = read("domains/inventory/web-client/index.ts");
  expect(web).toContain('export { listCatalog, readCatalog, saveCatalog } from "./catalog-client.js";');
  expect(web).toContain('export { CatalogListPage, CatalogDetailPage } from "./catalog-pages.js";');
  expect(add(...args).files).toEqual([]);
  expect(readdirSync(join(root, "domains/inventory/server/migrations"))).toHaveLength(1);
});

it("preflights invalid selections and collisions before writing and supports dry runs", () => {
  expect(() => add("resource", "catalog", "--api", "unknown")).toThrow("Required registry");
  expect(existsSync(join(root, "domains/catalog"))).toBe(false);

  const preview = add("resource", "catalog", "--api", "customer", "--dry-run");
  expect(preview.files).toContain("apps/customer/app.ts");
  expect(preview.dryRun).toBe(true);
  expect(read("apps/customer/app.ts")).toBe(api);

  setup("domains/catalog/server/catalog-table.ts", "locally authored");
  expect(() => add("resource", "catalog", "--api", "customer")).toThrow("File already exists");
  expect(read("domains/catalog/server/catalog-table.ts")).toBe("locally authored");
  expect(existsSync(join(root, "domains/catalog/index.ts"))).toBe(false);
});

it("scaffolds workflow and integration modules and refuses invalid names or collisions", () => {
  const workflowPreview = add("workflow", "fulfill-order", "--dry-run");
  expect(workflowPreview.files).toEqual(["workflows/fulfill-order.test.ts", "workflows/fulfill-order.ts"]);
  expect(existsSync(join(root, "workflows/fulfill-order.ts"))).toBe(false);

  const workflowResult = add("workflow", "fulfill-order");
  expect(workflowResult.files).toEqual(["workflows/fulfill-order.test.ts", "workflows/fulfill-order.ts"]);
  expect(read("workflows/fulfill-order.ts")).toContain("export async function runFulfillOrder(");
  expect(read("workflows/fulfill-order.test.ts")).toContain("runFulfillOrder");
  expect(add("workflow", "fulfill-order").files).toEqual([]);

  const integrationPreview = add("integration", "payment-gateway", "--dry-run");
  expect(integrationPreview.files).toEqual([
    "integrations/payment-gateway/index.ts",
    "integrations/payment-gateway/payment-gateway.test.ts",
  ]);
  expect(existsSync(join(root, "integrations/payment-gateway/index.ts"))).toBe(false);

  const integrationResult = add("integration", "payment-gateway");
  expect(integrationResult.files).toEqual([
    "integrations/payment-gateway/index.ts",
    "integrations/payment-gateway/payment-gateway.test.ts",
  ]);
  expect(read("integrations/payment-gateway/index.ts")).toContain("export function createPaymentGatewayAdapter(");
  expect(read("integrations/payment-gateway/payment-gateway.test.ts")).toContain("createPaymentGatewayAdapter");
  expect(add("integration", "payment-gateway").files).toEqual([]);

  expect(() => add("workflow", "BadName")).toThrow("lowercase kebab-case");
  expect(() => add("integration", "bad_name")).toThrow("lowercase kebab-case");
  expect(() => add("workflow", "checkout", "--domain", "orders")).toThrow("--domain is not used for workflow.");
  expect(() => add("integration", "stripe", "--domain", "orders")).toThrow("--domain is not used for integration.");
  expect(() => add("workflow", "checkout", "--api", "customer")).toThrow(
    "--api is allowed for domain, endpoint, and resource.",
  );

  setup("workflows/existing-flow.ts", "locally authored");
  expect(() => add("workflow", "existing-flow")).toThrow("File already exists");
  expect(existsSync(join(root, "workflows/existing-flow.test.ts"))).toBe(false);

  setup("integrations/existing-vendor/index.ts", "locally authored");
  expect(() => add("integration", "existing-vendor")).toThrow("File already exists");
  expect(existsSync(join(root, "integrations/existing-vendor/existing-vendor.test.ts"))).toBe(false);
});
