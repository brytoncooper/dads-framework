import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorContext } from "../../doctor-context.js";
import { crossDomainForeignKeysSignal } from "./cross-domain-foreign-keys.js";

const tempDirs: string[] = [];

function createWorkspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dads-cross-domain-fk-"));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cross-domain-foreign-keys signal", () => {
  it("is disabled by default when dads.project.json does not opt into strictForeignKeys", async () => {
    const baseFiles = {
      "domains/accounts/server/migrations/001_accounts.sql": "CREATE TABLE accounts (id uuid PRIMARY KEY);\n",
      "domains/orders/server/migrations/001_orders.sql":
        "CREATE TABLE orders (id uuid PRIMARY KEY, account_id uuid REFERENCES accounts(id));\n",
    };

    const withoutManifest = createWorkspace(baseFiles);
    const defaultOff = await crossDomainForeignKeysSignal.run(createDoctorContext({ root: withoutManifest }));
    expect(defaultOff.size).toBe(0);

    const omittedFlag = createWorkspace({
      "dads.project.json": JSON.stringify({ schemaVersion: 1, packages: [] }),
      ...baseFiles,
    });
    const omittedResult = await crossDomainForeignKeysSignal.run(createDoctorContext({ root: omittedFlag }));
    expect(omittedResult.size).toBe(0);

    const explicitFalse = createWorkspace({
      "dads.project.json": JSON.stringify({ schemaVersion: 1, strictForeignKeys: false, packages: [] }),
      ...baseFiles,
    });
    const falseResult = await crossDomainForeignKeysSignal.run(createDoctorContext({ root: explicitFalse }));
    expect(falseResult.size).toBe(0);
  });

  it("flags cross-domain SQL foreign keys and allows same-domain foreign keys when strictForeignKeys is true", async () => {
    const root = createWorkspace({
      "dads.project.json": JSON.stringify({ schemaVersion: 1, strictForeignKeys: true, packages: [] }),
      "domains/accounts/server/migrations/20260101000000_accounts.sql": [
        'CREATE TABLE IF NOT EXISTS "public"."accounts" (',
        "  id uuid PRIMARY KEY",
        ");",
      ].join("\n"),
      "domains/orders/server/migrations/20260102000000_orders.sql": [
        "CREATE TABLE orders (",
        "  id uuid PRIMARY KEY,",
        "  account_id uuid NOT NULL REFERENCES public.accounts(id)",
        ");",
        "CREATE TABLE order_items (",
        "  id uuid PRIMARY KEY,",
        "  order_id uuid NOT NULL REFERENCES orders(id)",
        ");",
      ].join("\n"),
    });

    const readings = await crossDomainForeignKeysSignal.run(createDoctorContext({ root }));
    expect(readings.get("domains/accounts/server/migrations/20260101000000_accounts.sql")?.value).toBe(0);

    const ordersReading = readings.get("domains/orders/server/migrations/20260102000000_orders.sql");
    expect(ordersReading?.value).toBe(1);
    expect(ordersReading?.evidence).toHaveLength(1);
    expect(ordersReading?.evidence[0]?.line).toBe(3);
    expect(ordersReading?.evidence[0]?.name).toContain('domain "orders"');
    expect(ordersReading?.evidence[0]?.name).toContain('domain "accounts"');
    expect(ordersReading?.evidence[0]?.name).toContain("declareCrossDomainReferences");
    expect(ordersReading?.evidence[0]?.name).toContain("checkCrossDomainReferences");
    expect(ordersReading?.evidence[0]?.name).toContain("@dads-framework/core/references");
  });

  it("detects node-pg-migrate references options and ignores comments or non-domain tables", async () => {
    const root = createWorkspace({
      "dads.project.json": JSON.stringify({ schemaVersion: 1, strictForeignKeys: true, packages: [] }),
      "domains/billing/server/migrations/20260101000000_invoices.migration.ts": [
        "export function up(pgm: { createTable: Function }) {",
        '  pgm.createTable("invoices", { id: { type: "uuid", primaryKey: true } });',
        '  pgm.createTable({ schema: "billing", name: "invoice_lines" }, { id: { type: "uuid" } });',
        "}",
      ].join("\n"),
      "domains/shipping/server/migrations/20260102000000_shipments.migration.ts": [
        "export function up(pgm: { createTable: Function }) {",
        "  // REFERENCES invoices(id) inside a comment should be ignored",
        "  /* references: 'invoices' inside a block comment should be ignored */",
        '  pgm.createTable("shipments", {',
        '    id: { type: "uuid", primaryKey: true },',
        '    invoice_id: { type: "uuid", references: "invoices" },',
        '    line_id: { type: "uuid", references: { schema: "billing", name: "invoice_lines" } },',
        '    parent_shipment_id: { type: "uuid", references: "shipments" },',
        '    tenant_id: { type: "uuid", references: "external_tenants" },',
        "  });",
        "}",
      ].join("\n"),
    });

    const readings = await crossDomainForeignKeysSignal.run(createDoctorContext({ root }));
    expect(readings.get("domains/billing/server/migrations/20260101000000_invoices.migration.ts")?.value).toBe(0);

    const shipments = readings.get("domains/shipping/server/migrations/20260102000000_shipments.migration.ts");
    expect(shipments?.value).toBe(2);
    expect(shipments?.evidence.map((entry) => entry.line)).toEqual([6, 7]);
  });
});
