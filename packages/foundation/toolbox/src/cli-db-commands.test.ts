import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDbArguments, runDbCommand } from "./cli-db-commands.js";
import {
  loadPostgresAdapter,
  resolvePostgresModulePath,
  type DbGeneratedTableFile,
  type DbMigrationStatusKind,
  type DbMigrationWorkspace,
  type DbPostgresAdapter,
  type DbPostgresClient,
  type DbTableDriftReport,
} from "./cli-db-loader.js";

const DAD_BIN = fileURLToPath(new URL("../bin/dad.js", import.meta.url));
const DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/app";

type FakeAdapterOverrides = Partial<DbPostgresAdapter>;

function createFakeWorkspace(root: string): DbMigrationWorkspace {
  return { root, sources: [], moduleAliases: {} };
}

function createFakeClient(): { readonly client: DbPostgresClient; readonly endSpy: ReturnType<typeof vi.fn> } {
  const endSpy = vi.fn(() => Promise.resolve(undefined));
  const client: DbPostgresClient = {
    query: vi.fn(() => Promise.resolve({ rows: [] })),
    end: endSpy,
  };
  return { client, endSpy };
}

function createFakeAdapter(overrides: FakeAdapterOverrides = {}): {
  readonly adapter: DbPostgresAdapter;
  readonly clientEndSpy: ReturnType<typeof vi.fn>;
  readonly introspectSpy: ReturnType<typeof vi.fn>;
  readonly writeSpy: ReturnType<typeof vi.fn>;
  readonly checkSpy: ReturnType<typeof vi.fn>;
  readonly migrateSpy: ReturnType<typeof vi.fn>;
  readonly appWorkspaceSpy: ReturnType<typeof vi.fn>;
  readonly defaultWorkspaceSpy: ReturnType<typeof vi.fn>;
} {
  const { client, endSpy } = createFakeClient();
  const sampleFiles: readonly DbGeneratedTableFile[] = [
    {
      outputFile: "db/orders.tables.ts",
      content: "// generated\n",
      tables: [{ schema: "public", table: "orders", exportSymbol: "orders", fingerprint: "0123456789abcdef" }],
    },
  ];
  const cleanReport: DbTableDriftReport = { ok: true, drifted: [], missing: [] };

  const introspectSpy = vi.fn(() => Promise.resolve(sampleFiles));
  const writeSpy = vi.fn(() => Promise.resolve(["db/orders.tables.ts"]));
  const checkSpy = vi.fn(() => Promise.resolve(cleanReport));
  const migrateSpy = vi.fn((_input, log: { info(context: object, message: string): void }) => {
    log.info({ event: "database.migrate.complete" }, "database is at the checked-in schema");
    return Promise.resolve();
  });
  const appWorkspaceSpy = vi.fn((root: string) => createFakeWorkspace(root));
  const defaultWorkspaceSpy = vi.fn((root: string) => createFakeWorkspace(root));
  const pendingStatus: DbMigrationStatusKind = "node-pg-pending";

  const adapter: DbPostgresAdapter = {
    connectPostgresClient: vi.fn(() => Promise.resolve(client)),
    introspectAndGenerateTables: introspectSpy,
    writeGeneratedTableFiles: writeSpy,
    checkGeneratedTableFiles: checkSpy,
    applicationMigrationWorkspace: appWorkspaceSpy,
    defaultMigrationWorkspace: defaultWorkspaceSpy,
    runDatabaseMigrations: migrateSpy,
    inspectNodePgMigrations: vi.fn(() => Promise.resolve(pendingStatus)),
    listShippedDatabaseMigrations: vi.fn(() =>
      Promise.resolve([
        {
          journalName: "20260101000000_init.migration",
          owner: "app",
          file: "migrations/20260101000000_init.migration.ts",
          sha256: "aaa",
        },
        {
          journalName: "20260102000000_orders.migration",
          owner: "orders",
          file: "domains/orders/server/migrations/20260102000000_orders.migration.ts",
          sha256: "bbb",
        },
      ]),
    ),
    readAppliedNodePgJournal: vi.fn(() =>
      Promise.resolve([
        {
          journalName: "20260101000000_init.migration",
          ranAt: new Date("2026-01-01T12:00:00.000Z"),
          sha256: "aaa",
        },
      ]),
    ),
    ...overrides,
  };

  return {
    adapter,
    clientEndSpy: endSpy,
    introspectSpy,
    writeSpy,
    checkSpy,
    migrateSpy,
    appWorkspaceSpy,
    defaultWorkspaceSpy,
  };
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dads-cli-db-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDbArguments", () => {
  it("parses generate options and prefers --database-url over DATABASE_URL", () => {
    const parsed = parseDbArguments(
      [
        "generate",
        "--database-url",
        DATABASE_URL,
        "--out",
        "src/db/tables",
        "--metadata",
        "table-meta.json",
        "--schema",
        "public, audit",
        "--json",
      ],
      { DATABASE_URL: "postgres://ignored@localhost/ignored" },
    );

    expect(parsed).toEqual({
      command: "generate",
      databaseUrl: DATABASE_URL,
      outDir: "src/db/tables",
      metadataPath: "table-meta.json",
      schemas: ["public", "audit"],
      json: true,
    });
  });

  it("falls back to DATABASE_URL from environment", () => {
    const parsed = parseDbArguments(["status"], { DATABASE_URL });
    expect(parsed).toEqual({
      command: "status",
      databaseUrl: DATABASE_URL,
      json: false,
    });
  });

  it("refuses missing database URL, unknown subcommands, and disallowed options", () => {
    expect(() => parseDbArguments(["migrate"], {})).toThrow("DATABASE_URL is required");
    expect(() => parseDbArguments([], { DATABASE_URL })).toThrow("Usage: dad db");
    expect(() => parseDbArguments(["drop"], { DATABASE_URL })).toThrow("Usage: dad db");
    expect(() => parseDbArguments(["migrate", "--out", "dir"], { DATABASE_URL })).toThrow("Unknown option --out.");
    expect(() => parseDbArguments(["status", "extra"], { DATABASE_URL })).toThrow("Unexpected argument extra.");
    expect(() => parseDbArguments(["generate", "--schema", " , "], { DATABASE_URL })).toThrow(
      "--schema requires at least one non-empty schema name.",
    );
  });
});

describe("dad db --help", () => {
  it("prints db subcommand help and includes db commands in root help", () => {
    const dbHelp = execFileSync(process.execPath, [DAD_BIN, "db", "--help"], { encoding: "utf8" });
    expect(dbHelp).toContain("Usage: dad db <generate|check|migrate|status>");
    expect(dbHelp).toContain("db generate [--database-url <url>]");
    expect(dbHelp).toContain("db check [--database-url <url>]");
    expect(dbHelp).toContain("db migrate [--database-url <url>]");
    expect(dbHelp).toContain("db status [--database-url <url>]");

    const subHelp = execFileSync(process.execPath, [DAD_BIN, "db", "generate", "--help"], { encoding: "utf8" });
    expect(subHelp).toContain("Usage: dad db <generate|check|migrate|status>");

    const rootHelp = execFileSync(process.execPath, [DAD_BIN, "--help"], { encoding: "utf8" });
    expect(rootHelp).toContain("db generate");
    expect(rootHelp).toContain("db check");
    expect(rootHelp).toContain("db migrate");
    expect(rootHelp).toContain("db status");
  });
});

describe("runDbCommand", () => {
  it("runs generate with metadata, schema filter, and JSON output, closing the client", async () => {
    const cwd = createTempDir();
    writeFileSync(
      join(cwd, "metadata.json"),
      JSON.stringify({
        tables: [{ owner: "orders", schema: "public", table: "orders", outputFile: "db/orders.tables.ts" }],
        retiredColumns: { "public.orders": ["legacy_code"] },
      }),
    );
    const { adapter, clientEndSpy, introspectSpy, writeSpy } = createFakeAdapter();
    const output: string[] = [];

    const exitCode = await runDbCommand(
      [
        "generate",
        "--database-url",
        DATABASE_URL,
        "--out",
        "db",
        "--metadata",
        "metadata.json",
        "--schema",
        "public",
        "--json",
      ],
      {
        cwd,
        env: {},
        loadAdapter: () => Promise.resolve(adapter),
        stdout: (text) => output.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(clientEndSpy).toHaveBeenCalledTimes(1);
    expect(introspectSpy).toHaveBeenCalledWith(expect.anything(), {
      schemas: ["public"],
      defaultOutputDir: "db",
      metadata: [{ owner: "orders", schema: "public", table: "orders", outputFile: "db/orders.tables.ts" }],
      retiredColumns: { "public.orders": ["legacy_code"] },
    });
    expect(writeSpy).toHaveBeenCalledWith(expect.any(Array), cwd);
    expect(JSON.parse(output.join(""))).toEqual({
      ok: true,
      command: "generate",
      outputRoot: cwd,
      files: ["db/orders.tables.ts"],
      tableCount: 1,
    });
  });

  it("returns exit code 0 when check is clean and exit code 1 when drifted or missing", async () => {
    const cwd = createTempDir();
    const clean = createFakeAdapter();
    const cleanOut: string[] = [];

    const cleanExit = await runDbCommand(["check", "--database-url", DATABASE_URL], {
      cwd,
      env: {},
      loadAdapter: () => Promise.resolve(clean.adapter),
      stdout: (text) => cleanOut.push(text),
    });

    expect(cleanExit).toBe(0);
    expect(clean.clientEndSpy).toHaveBeenCalledTimes(1);
    expect(cleanOut.join("")).toContain("up to date");

    const drifted = createFakeAdapter({
      checkGeneratedTableFiles: vi.fn(() =>
        Promise.resolve({
          ok: false,
          drifted: [
            {
              outputFile: "db/orders.tables.ts",
              expectedFingerprints: ["1111111111111111"],
              actualFingerprints: ["2222222222222222"],
            },
          ],
          missing: ["db/invoices.tables.ts"],
        }),
      ),
    });
    const driftOut: string[] = [];

    const driftExit = await runDbCommand(["check", "--database-url", DATABASE_URL, "--json"], {
      cwd,
      env: {},
      loadAdapter: () => Promise.resolve(drifted.adapter),
      stdout: (text) => driftOut.push(text),
    });

    expect(driftExit).toBe(1);
    expect(JSON.parse(driftOut.join(""))).toEqual({
      ok: false,
      command: "check",
      outputRoot: cwd,
      checkedCount: 1,
      drifted: [
        {
          outputFile: "db/orders.tables.ts",
          expectedFingerprints: ["1111111111111111"],
          actualFingerprints: ["2222222222222222"],
        },
      ],
      missing: ["db/invoices.tables.ts"],
    });
  });

  it("runs migrate using applicationMigrationWorkspace for app repos and defaultMigrationWorkspace for monorepo packages", async () => {
    const appDir = createTempDir();
    mkdirSync(join(appDir, "domains", "orders"), { recursive: true });
    const appFake = createFakeAdapter();
    const appOut: string[] = [];

    const appExit = await runDbCommand(["migrate", "--json"], {
      cwd: appDir,
      env: { DATABASE_URL },
      loadAdapter: () => Promise.resolve(appFake.adapter),
      stdout: (text) => appOut.push(text),
    });

    expect(appExit).toBe(0);
    expect(appFake.appWorkspaceSpy).toHaveBeenCalledWith(appDir);
    expect(appFake.defaultWorkspaceSpy).not.toHaveBeenCalled();
    expect(JSON.parse(appOut.join(""))).toEqual({
      ok: true,
      command: "migrate",
      events: [{ context: { event: "database.migrate.complete" }, message: "database is at the checked-in schema" }],
    });

    const monoDir = createTempDir();
    mkdirSync(join(monoDir, "packages", "server"), { recursive: true });
    const monoFake = createFakeAdapter();

    await runDbCommand(["migrate"], {
      cwd: monoDir,
      env: { DATABASE_URL },
      loadAdapter: () => Promise.resolve(monoFake.adapter),
      stdout: () => undefined,
    });

    expect(monoFake.defaultWorkspaceSpy).toHaveBeenCalledWith(monoDir);
    expect(monoFake.appWorkspaceSpy).not.toHaveBeenCalled();
  });

  it("reports applied and pending migrations for status in human and JSON modes", async () => {
    const cwd = createTempDir();
    const { adapter, clientEndSpy } = createFakeAdapter();
    const jsonOut: string[] = [];

    const exitCode = await runDbCommand(["status", "--database-url", DATABASE_URL, "--json"], {
      cwd,
      env: {},
      loadAdapter: () => Promise.resolve(adapter),
      stdout: (text) => jsonOut.push(text),
    });

    expect(exitCode).toBe(0);
    expect(clientEndSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(jsonOut.join(""))).toEqual({
      ok: true,
      command: "status",
      status: "node-pg-pending",
      shippedCount: 2,
      appliedCount: 1,
      pendingCount: 1,
      pending: [
        {
          journalName: "20260102000000_orders.migration",
          owner: "orders",
          file: "domains/orders/server/migrations/20260102000000_orders.migration.ts",
        },
      ],
      applied: [
        {
          journalName: "20260101000000_init.migration",
          ranAt: "2026-01-01T12:00:00.000Z",
          sha256: "aaa",
        },
      ],
    });

    const humanOut: string[] = [];
    await runDbCommand(["status", "--database-url", DATABASE_URL], {
      cwd,
      env: {},
      loadAdapter: () => Promise.resolve(adapter),
      stdout: (text) => humanOut.push(text),
    });
    expect(humanOut.join("")).toContain("Migration status: node-pg-pending (1 applied, 1 pending, 2 shipped)");
    expect(humanOut.join("")).toContain("20260102000000_orders.migration");
  });

  it("reports an actionable install error when @dads-framework/postgres is not installed", () => {
    const emptyDir = createTempDir();
    writeFileSync(join(emptyDir, "package.json"), JSON.stringify({ name: "empty-app" }));
    expect(() => resolvePostgresModulePath(emptyDir, undefined, false)).toThrow(
      "@dads-framework/postgres is required for dad db commands. Install it with: npm install @dads-framework/postgres",
    );
  });

  it("loads the real @dads-framework/postgres adapter dynamically in a workspace checkout", async () => {
    const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
    const adapter = await loadPostgresAdapter(repoRoot);
    expect(typeof adapter.connectPostgresClient).toBe("function");
    expect(typeof adapter.introspectAndGenerateTables).toBe("function");
    expect(typeof adapter.writeGeneratedTableFiles).toBe("function");
    expect(typeof adapter.checkGeneratedTableFiles).toBe("function");
    expect(typeof adapter.runDatabaseMigrations).toBe("function");
    expect(typeof adapter.inspectNodePgMigrations).toBe("function");
    expect(typeof adapter.listShippedDatabaseMigrations).toBe("function");
    expect(typeof adapter.readAppliedNodePgJournal).toBe("function");
  });
});
