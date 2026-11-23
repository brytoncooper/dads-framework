/**
 * Mechanical purity enforcement for `pure/` directories.
 *
 * Clean pure modules (including `import type`, `new Date(timestamp)`, and
 * injected `clock` parameters) score 0; forbidden I/O/framework value imports
 * and ambient nondeterminism calls are flagged with file, line, and name.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorContext } from "../../doctor-context.js";
import { impureCodeSignal } from "./impure-code.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function measure(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "dads-impure-code-"));
  roots.push(root);
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const context = createDoctorContext({ root });
  return impureCodeSignal.run(context);
}

describe("impure-code signal", () => {
  it("scores 0 on clean pure modules using type-only imports, explicit dates, and injected clocks", async () => {
    const readings = await measure({
      "domains/orders/pure/order.ts": [
        'import type { Stats } from "node:fs";',
        'import { type Pool } from "pg";',
        'export type { HttpRoute } from "@dads-framework/http";',
        'import { z } from "zod";',
        "",
        "export type Clock = { readonly now: () => number };",
        "export type OrderInput = { readonly total: number; readonly createdAtMs: number };",
        "export type References = { readonly stats?: Stats; readonly pool?: Pool };",
        "",
        "export const OrderSchema = z.object({ total: z.number() });",
        "",
        "export function formatOrder(input: OrderInput, clock: Clock, client: { fetch: (u: string) => string }) {",
        "  const created = new Date(input.createdAtMs);",
        '  const epoch = new Date("2026-01-01T00:00:00Z");',
        "  return { created, epoch, now: clock.now(), remote: client.fetch('/status') };",
        "}",
        "",
      ].join("\n"),
    });

    expect(readings.get("domains/orders/pure/order.ts")).toStrictEqual({ value: 0, evidence: [] });
  });

  it("ignores files outside pure/ and test/spec/test-support files inside pure/", async () => {
    const readings = await measure({
      "domains/orders/server/repo.ts": 'import pg from "pg";\nexport const now = () => Date.now() + (pg ? 0 : 1);\n',
      "domains/orders/pure/order.test.ts":
        'import { readFileSync } from "node:fs";\nexport const x = [readFileSync, Date.now()];\n',
      "domains/orders/pure/order.spec.ts": "export const x = Math.random();\n",
      "domains/orders/pure/order.test-support.ts": "export const x = process.env;\n",
      "domains/orders/pure/clean.ts": "export const add = (a: number, b: number) => a + b;\n",
    });

    expect([...readings.keys()]).toStrictEqual(["domains/orders/pure/clean.ts"]);
    expect(readings.get("domains/orders/pure/clean.ts")?.value).toBe(0);
  });

  it("flags every forbidden Node built-in, vendor library, and framework I/O value import", async () => {
    const forbiddenSpecifiers = [
      "node:fs",
      "node:fs/promises",
      "node:http",
      "node:http2",
      "node:https",
      "node:net",
      "node:dgram",
      "node:dns",
      "node:tls",
      "node:child_process",
      "node:crypto",
      "node:worker_threads",
      "node:sqlite",
      "fs",
      "http",
      "https",
      "net",
      "child_process",
      "crypto",
      "pg",
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "fastify",
      "better-auth",
      "resend",
      "bullmq",
      "@dads-framework/postgres",
      "@dads-framework/http",
      "@dads-framework/email",
      "@dads-framework/object-storage",
      "@dads-framework/job-queue",
      "@dads-framework/postgres-access",
      "@dads-framework/spicedb-access",
      "@dads-framework/sqlite-access",
      "@dads-framework/identity",
    ];

    const files: Record<string, string> = {};
    for (const [index, specifier] of forbiddenSpecifiers.entries()) {
      files[`pure/case-${index}.ts`] = `import * as mod from "${specifier}";\nexport const ref = mod;\n`;
    }
    files["pure/dynamic.ts"] = [
      'export const a = () => import("node:fs");',
      'export const b = () => require("pg");',
      'export { Pool } from "pg";',
      "",
    ].join("\n");

    const readings = await measure(files);
    for (const [index, specifier] of forbiddenSpecifiers.entries()) {
      const reading = readings.get(`pure/case-${index}.ts`);
      expect(reading?.value, `expected ${specifier} to be flagged`).toBe(1);
      expect(reading?.evidence[0]?.name).toBe(`import ${specifier}`);
    }
    expect(readings.get("pure/dynamic.ts")?.evidence.map((item) => item.name)).toStrictEqual([
      "import pg",
      "import node:fs",
      "import pg",
    ]);
  });

  it("flags every ambient nondeterminism call and read", async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["date-now", "export const v = () => Date.now();\n", "Date.now()"],
      ["new-date", "export const v = () => new Date();\n", "new Date()"],
      ["math-random", "export const v = () => Math.random();\n", "Math.random()"],
      ["random-uuid", "export const v = () => crypto.randomUUID();\n", "crypto.randomUUID()"],
      ["process-env", "export const v = () => process.env.API_KEY;\n", "process.env"],
      ["process-env-index", 'export const v = () => process["env"];\n', "process.env"],
      ["global-fetch", 'export const v = () => fetch("https://example.test");\n', "fetch()"],
      ["global-this-fetch", 'export const v = () => globalThis.fetch("https://example.test");\n', "fetch()"],
      ["set-timeout", "export const v = () => setTimeout(() => undefined, 10);\n", "setTimeout()"],
      ["set-interval", "export const v = () => setInterval(() => undefined, 10);\n", "setInterval()"],
      ["performance-now", "export const v = () => performance.now();\n", "performance.now()"],
    ];

    const files: Record<string, string> = {};
    for (const [name, code] of cases) {
      files[`domains/billing/pure/${name}.ts`] = code;
    }

    const readings = await measure(files);
    for (const [name, , expectedEvidence] of cases) {
      const reading = readings.get(`domains/billing/pure/${name}.ts`);
      expect(reading?.value, `expected ${name} to be flagged`).toBe(1);
      expect(reading?.evidence[0]?.name).toBe(expectedEvidence);
    }
  });
});
