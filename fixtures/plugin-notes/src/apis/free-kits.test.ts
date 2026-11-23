import { join } from "node:path";

import { auditDepsService, auditService, createAuditPlugin } from "@dads-framework/audit";
import { configurePluginAuditTriggers } from "@dads-framework/audit/schema";
import { FakeAuthorization } from "@dads-framework/spicedb-access/testing";
import { createFeatureFlagsPlugin, featureFlagDepsService, featureFlagsService } from "@dads-framework/feature-flags";
import {
  FakeTenantDirectory,
  featureFlagDefinitionFactory,
  FixedClock,
  InMemoryFeatureFlagStore,
} from "@dads-framework/feature-flags/testing";
import { createFeatureFlagRoutesPlugin } from "@dads-framework/feature-flags/http";
import { featureFlagsPostgresSchema } from "@dads-framework/feature-flags/postgres";
import { buildTestApp } from "@dads-framework/http/testing";
import { discoverDomainMigrations } from "@dads-framework/postgres/migrations";
import {
  defaultMigrationWorkspace,
  listShippedDatabaseMigrations,
} from "@dads-framework/postgres/migrations/journal-status";
import { composeApi, providePlugin } from "@dads-framework/core/plugin";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it, vi } from "vitest";

const clock = new FixedClock(new Date("2026-11-19T12:00:00Z"));
const definition = featureFlagDefinitionFactory({ slug: "notes.public" });
const flagDeps = providePlugin("flag-host", featureFlagDepsService, () => ({
  clock,
  store: new InMemoryFeatureFlagStore(),
  tenants: new FakeTenantDirectory(),
}));
const auditDeps = providePlugin("audit-host", auditDepsService, () => ({
  clock,
  db: drizzle.mock(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const flags = createFeatureFlagsPlugin({
  definitions: [definition],
  publicSlugs: [definition.slug],
});
const audit = createAuditPlugin({
  requestLogRetentionDays: 90,
  clientDiagnosticsRetentionDays: 30,
  untrackedTables: ["short_lived_tokens"],
  scopes: [{ table: "notes", columns: { workspace: "workspace_key" } }],
});
const services = [flagDeps, auditDeps, flags, audit.audit, featureFlagsPostgresSchema];

it("declares the free kits once and lets hosts select their routes and jobs", async () => {
  const publicApi = composeApi("public", {
    services,
    routes: [createFeatureFlagRoutesPlugin(), audit.routes],
    jobs: [],
  });
  const workerApi = composeApi("worker", {
    services,
    routes: [],
    jobs: [audit.jobs],
  });
  const publicRun = await publicApi.start();
  const workerRun = await workerApi.start();
  const authorization = new FakeAuthorization({});
  const publicHttp = await buildTestApp({
    routes: publicRun.routes,
    authorization,
  });
  const workerHttp = await buildTestApp({
    routes: [],
    authorization,
  });
  try {
    expect(publicApi.flags).toEqual([definition]);
    expect(publicRun.read(featureFlagsService)).toBe(publicRun.read(flags));
    expect(publicRun.read(auditService)).toBe(publicRun.read(audit.audit));
    expect(publicRun.jobs).toEqual([]);
    expect(workerRun.routes).toEqual([]);
    expect(workerRun.jobs.map(({ name }) => name)).toEqual([
      "audit.prune-request-log",
      "audit.prune-client-diagnostics",
    ]);
    expect((await publicHttp.inject({ url: "/feature-state/public" })).statusCode).toBe(200);
    expect((await publicHttp.inject({ url: "/feature-flags" })).statusCode).toBe(404);
    expect((await workerHttp.inject({ url: "/feature-state/public" })).statusCode).toBe(404);
    const report = {
      method: "POST",
      url: "/client-diagnostics",
      payload: {},
    } as const;
    expect((await publicHttp.inject(report)).statusCode).toBe(400);
    expect((await workerHttp.inject(report)).statusCode).toBe(404);
  } finally {
    await Promise.all([publicHttp.close(), workerHttp.close(), publicRun.stop(), workerRun.stop()]);
  }
});

it("feeds declared audit policy and original migration files to the host", async () => {
  const api = composeApi("maintenance", { services, routes: [], jobs: [] });
  const root = join(import.meta.dirname, "..", "..", "..", "..");
  const workspace = {
    root,
    sources: api.migrationSources(root),
    moduleAliases: {},
  };
  const migrations = await discoverDomainMigrations({ workspace });
  expect(new Set(migrations.map(({ owner }) => owner))).toEqual(new Set(["audit", "feature-flags-postgres"]));
  const packaged = (await listShippedDatabaseMigrations(workspace))
    .filter(({ owner }) => owner === "feature-flags-postgres")
    .map(({ journalName, sha256 }) => ({ journalName, sha256 }));
  const historical = (await listShippedDatabaseMigrations(defaultMigrationWorkspace(root)))
    .filter(({ owner }) => owner === "feature-flags-postgres")
    .map(({ journalName, sha256 }) => ({ journalName, sha256 }));
  expect(packaged).toHaveLength(1);
  expect(packaged).toEqual(historical);
  expect(api.untrackedAuditTables).toContain("short_lived_tokens");
  const sql = vi.fn<(statement: string) => void>();
  configurePluginAuditTriggers({ sql }, api, { notes: { keyColumns: ["id"] } });
  expect(sql).toHaveBeenCalledWith(expect.stringContaining(`'{"workspace":"workspace_key"}'`));
  expect(sql).toHaveBeenCalledWith('DROP TRIGGER IF EXISTS audit_record ON public."short_lived_tokens"');
});
