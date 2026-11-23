import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitAccessIr, parseZed } from "@dads-framework/access";
import { describe, expect, it } from "vitest";

import type { PgMigrationExecutor } from "../access-migrations/sql-migration-types.js";
import { buildAccessModelFromIr } from "./access-model-from-ir.js";
import type { SpiceDbExportedTuple, SpiceDbMigrationSource } from "./authzed-client-adapter.js";
import { parseImportSpiceDbArgs } from "./cli-args.js";
import { runImportSpiceDbCli, type ImportSpiceDbCliConnectors } from "./cli.js";
import type { ParityAuthorizationClient } from "./verify-parity.js";

const SAMPLE_SCHEMA = [
  "use expiration",
  "",
  "definition user {}",
  "definition document {",
  "  relation viewer: user | user with expiration",
  "  permission view = viewer",
  "}",
].join("\n");

const SAMPLE_TUPLES: readonly SpiceDbExportedTuple[] = [
  {
    resource: { type: "document", id: "doc_1" },
    relation: "viewer",
    subject: { type: "user", id: "alice" },
  },
  {
    resource: { type: "document", id: "doc_2" },
    relation: "viewer",
    subject: { type: "user", id: "bob" },
  },
];

const DEFAULT_ENV = {
  SPICEDB_TOKEN: "tok",
  DATABASE_URL: "postgres://localhost/db",
};

const BASE_LIVE_ARGS = [
  "--endpoint",
  "localhost:50051",
  "--token",
  "tok",
  "--database-url",
  "postgres://localhost/app",
];

async function* yieldPages<T>(pages: readonly T[]): AsyncGenerator<T> {
  for (const page of pages) {
    await Promise.resolve();
    yield page;
  }
}

function createFakeConnectors(options?: {
  readonly schemaText?: string;
  readonly tuples?: readonly SpiceDbExportedTuple[];
  readonly spiceParity?: ParityAuthorizationClient;
  readonly pgParity?: ParityAuthorizationClient;
}) {
  const queries: { readonly text: string; readonly values?: unknown[] }[] = [];
  const spiceConnectCalls: {
    readonly endpoint: string;
    readonly token: string;
    readonly insecure: boolean;
  }[] = [];
  const pgConnectCalls: { readonly databaseUrl: string }[] = [];
  let spiceClosed = false;
  let pgClosed = false;
  let parityModelEntities: readonly string[] = [];

  const schemaText = options?.schemaText ?? SAMPLE_SCHEMA;
  const tuples = options?.tuples ?? SAMPLE_TUPLES;
  const source: SpiceDbMigrationSource = {
    readSchema: () => Promise.resolve({ schemaText, zedToken: "tok-42" }),
    exportRelationships: () => yieldPages([tuples]),
  };
  const executor: PgMigrationExecutor = {
    query(text, values) {
      queries.push({ text, ...(values === undefined ? {} : { values }) });
      return Promise.resolve({ rows: [] });
    },
  };

  const connectors: ImportSpiceDbCliConnectors = {
    connectSpiceDb(input) {
      spiceConnectCalls.push(input);
      return Promise.resolve({
        source,
        ...(options?.spiceParity === undefined ? {} : { parityClient: options.spiceParity }),
        close: () => {
          spiceClosed = true;
        },
      });
    },
    connectPostgres(input) {
      pgConnectCalls.push(input);
      const pgParity = options?.pgParity;
      return Promise.resolve({
        executor,
        ...(pgParity === undefined
          ? {}
          : {
              createParityClient: ({ model }) => {
                parityModelEntities = model.definitions.map((def) => def.entity.wireName);
                return pgParity;
              },
            }),
        close: () => {
          pgClosed = true;
        },
      });
    },
  };

  return {
    connectors,
    queries,
    spiceConnectCalls,
    pgConnectCalls,
    isSpiceClosed: () => spiceClosed,
    isPgClosed: () => pgClosed,
    getParityModelEntities: () => parityModelEntities,
  };
}

function makeAllowMapClient(allowMap: ReadonlyMap<string, readonly string[]>): ParityAuthorizationClient {
  return {
    check: (q) => Promise.resolve((allowMap.get(q.subject.id) ?? []).includes(q.resource.id)),
    lookupResources: (q) => Promise.resolve(allowMap.get(q.subject.id) ?? []),
  };
}

describe("parseImportSpiceDbArgs", () => {
  it("parses all flags and defaults cleanly", () => {
    const parsed = parseImportSpiceDbArgs([
      "--endpoint",
      "localhost:50051",
      "--token",
      "secret-key",
      "--database-url",
      "postgres://user:pass@localhost:5432/app",
      "--namespace",
      "acme",
      "--out",
      "./access.ts",
      "--batch-size",
      "250",
      "--verify",
      "--insecure",
      "--json",
    ]);

    expect(parsed).toEqual({
      kind: "options",
      options: {
        endpoint: "localhost:50051",
        token: "secret-key",
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        namespace: "acme",
        out: "./access.ts",
        batchSize: 250,
        verify: true,
        insecure: true,
        dryRun: false,
        json: true,
      },
    });
  });

  it("supports --flag=value syntax and SPICEDB_TOKEN / DATABASE_URL env fallbacks", () => {
    const parsed = parseImportSpiceDbArgs(["--endpoint=spicedb.internal:50051"], {
      SPICEDB_TOKEN: "env-token",
      DATABASE_URL: "postgres://localhost/envdb",
    });

    expect(parsed).toEqual({
      kind: "options",
      options: {
        endpoint: "spicedb.internal:50051",
        token: "env-token",
        databaseUrl: "postgres://localhost/envdb",
        namespace: "default",
        verify: false,
        insecure: false,
        dryRun: false,
        json: false,
      },
    });
  });

  it("prefers explicit CLI flags over environment variables", () => {
    const parsed = parseImportSpiceDbArgs(
      ["--endpoint", "localhost:50051", "--token", "cli-token", "--database-url", "postgres://localhost/clidb"],
      {
        SPICEDB_TOKEN: "env-token",
        DATABASE_URL: "postgres://localhost/envdb",
      },
    );

    expect(parsed.kind).toBe("options");
    if (parsed.kind === "options") {
      expect(parsed.options.token).toBe("cli-token");
      expect(parsed.options.databaseUrl).toBe("postgres://localhost/clidb");
    }
  });

  it("allows --dry-run without --database-url and rejects --dry-run with --verify", () => {
    const dryRun = parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "--dry-run"], { SPICEDB_TOKEN: "tok" });
    expect(dryRun.kind).toBe("options");
    if (dryRun.kind === "options") {
      expect(dryRun.options.dryRun).toBe(true);
      expect(dryRun.options.databaseUrl).toBeUndefined();
    }

    const conflict = parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "--dry-run", "--verify"], DEFAULT_ENV);
    expect(conflict.kind).toBe("error");
    if (conflict.kind === "error") expect(conflict.message).toContain("--verify");
  });

  it("returns help for --help and -h even when required flags are absent", () => {
    expect(parseImportSpiceDbArgs(["--help"]).kind).toBe("help");
    expect(parseImportSpiceDbArgs(["-h"]).kind).toBe("help");
    const help = parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "-h"]);
    expect(help.kind).toBe("help");
    if (help.kind === "help") {
      expect(help.usage).toContain("dads-import-spicedb");
      expect(help.usage).toContain("--verify");
    }
  });

  it("rejects missing required flags, invalid --batch-size, duplicate flags, and unknown flags", () => {
    expect(parseImportSpiceDbArgs([], DEFAULT_ENV).kind).toBe("error");
    expect(
      parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "--database-url", "postgres://localhost/db"]).kind,
    ).toBe("error");
    expect(parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "--token", "tok"]).kind).toBe("error");

    for (const bad of ["0", "-3", "1.5", "abc", "10ms"]) {
      const result = parseImportSpiceDbArgs(["--endpoint", "localhost:50051", "--batch-size", bad], DEFAULT_ENV);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toContain("--batch-size");
      }
    }

    const dupValue = parseImportSpiceDbArgs(["--endpoint", "a:50051", "--endpoint", "b:50051"], DEFAULT_ENV);
    expect(dupValue.kind).toBe("error");
    if (dupValue.kind === "error") {
      expect(dupValue.message).toContain("Duplicate flag: --endpoint");
    }

    const dupBool = parseImportSpiceDbArgs(["--endpoint", "a:50051", "--verify", "--verify"], DEFAULT_ENV);
    expect(dupBool.kind).toBe("error");
    if (dupBool.kind === "error") {
      expect(dupBool.message).toContain("Duplicate flag: --verify");
    }

    const unknown = parseImportSpiceDbArgs(["--nope"], DEFAULT_ENV);
    expect(unknown.kind).toBe("error");
    if (unknown.kind === "error") {
      expect(unknown.message).toContain("Unknown flag: --nope");
    }

    const missingVal = parseImportSpiceDbArgs(["--endpoint", "--token", "tok"]);
    expect(missingVal.kind).toBe("error");
    if (missingVal.kind === "error") {
      expect(missingVal.message).toContain("--endpoint");
    }
  });
});

describe("buildAccessModelFromIr", () => {
  it("round-trips parsed SpiceDB IR including expiration, wildcards, usersets, arrows, and exclusions", () => {
    const zed = [
      "use expiration",
      "definition user {}",
      "definition group { relation member: user }",
      "definition workspace {",
      "  relation member: user with expiration | group#member | user:*",
      "  relation banned: user",
      "  permission view = member - banned",
      "}",
      "definition document {",
      "  relation parent: workspace",
      "  relation editor: user",
      "  relation approved: user",
      "  permission view = parent->view",
      "  permission publish = editor & approved",
      "}",
    ].join("\n");

    const parsed = parseZed(zed);
    expect(emitAccessIr(buildAccessModelFromIr(parsed))).toEqual(parsed);
  });
});

describe("runImportSpiceDbCli", () => {
  it("prints usage and exits 0 on --help without connecting", async () => {
    const fakes = createFakeConnectors();
    const result = await runImportSpiceDbCli({
      argv: ["--help"],
      connectors: fakes.connectors,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: dads-import-spicedb");
    expect(result.stderr).toBe("");
    expect(fakes.spiceConnectCalls).toHaveLength(0);
    expect(fakes.pgConnectCalls).toHaveLength(0);
  });

  it("migrates schema and tuples, batches Postgres upserts, and closes both connectors", async () => {
    const fakes = createFakeConnectors();
    const result = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--namespace", "prod", "--batch-size", "1", "--insecure"],
      connectors: fakes.connectors,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('Migrated 2 relationships (2 upserted) into Postgres namespace "prod"');
    expect(fakes.spiceConnectCalls).toEqual([{ endpoint: "localhost:50051", token: "tok", insecure: true }]);
    expect(fakes.pgConnectCalls).toEqual([{ databaseUrl: "postgres://localhost/app" }]);
    // 2 DDL statements + 2 batch inserts (batchSize = 1 for 2 tuples)
    expect(fakes.queries).toHaveLength(4);
    expect(fakes.isSpiceClosed()).toBe(true);
    expect(fakes.isPgClosed()).toBe(true);
  });

  it("supports --dry-run without connecting to Postgres or writing --out to disk", async () => {
    const fakes = createFakeConnectors();
    let wroteFile = false;
    const result = await runImportSpiceDbCli({
      argv: ["--endpoint", "localhost:50051", "--dry-run", "--out", "/tmp/should-not-be-written.ts"],
      env: { SPICEDB_TOKEN: "env-tok" },
      connectors: {
        ...fakes.connectors,
        writeFile: () => {
          wroteFile = true;
          return Promise.resolve();
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Dry run: parsed 2 definitions");
    expect(result.stdout).toContain("export const access = compileAccess(");
    expect(fakes.pgConnectCalls).toHaveLength(0);
    expect(fakes.queries).toHaveLength(0);
    expect(wroteFile).toBe(false);
    expect(fakes.isSpiceClosed()).toBe(true);
  });

  it("writes the generated TypeScript access model to disk when --out is given", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dads-import-spicedb-"));
    try {
      const outPath = join(tempDir, "nested", "access-model.ts");
      const fakes = createFakeConnectors();
      const result = await runImportSpiceDbCli({
        argv: [...BASE_LIVE_ARGS, "--out", outPath],
        connectors: fakes.connectors,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Wrote generated TypeScript access model to ${outPath}`);
      const written = await readFile(outPath, "utf8");
      expect(written).toContain("export const access = compileAccess(");
      expect(written).toContain("user.expiring");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes --verify when SpiceDB and Postgres decisions match", async () => {
    const allowMap = new Map<string, readonly string[]>([
      ["alice", ["doc_1"]],
      ["bob", ["doc_2"]],
    ]);
    const fakes = createFakeConnectors({
      spiceParity: makeAllowMapClient(allowMap),
      pgParity: makeAllowMapClient(allowMap),
    });

    const result = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--verify"],
      connectors: fakes.connectors,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Parity verified: 9/9 queries matched (0 mismatches).");
    expect(fakes.getParityModelEntities()).toEqual(["user", "document"]);
  });

  it("fails with exitCode 1 when --verify detects parity mismatches (text and --json)", async () => {
    const spiceMap = new Map<string, readonly string[]>([
      ["alice", ["doc_1"]],
      ["bob", ["doc_2"]],
    ]);
    const pgMap = new Map<string, readonly string[]>([["alice", ["doc_1"]]]);

    const textFakes = createFakeConnectors({
      spiceParity: makeAllowMapClient(spiceMap),
      pgParity: makeAllowMapClient(pgMap),
    });
    const textResult = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--verify"],
      connectors: textFakes.connectors,
    });
    expect(textResult.exitCode).toBe(1);
    expect(textResult.stderr).toContain("Parity check failed");
    expect(textResult.stderr).toContain("mismatches");

    const jsonFakes = createFakeConnectors({
      spiceParity: makeAllowMapClient(spiceMap),
      pgParity: makeAllowMapClient(pgMap),
    });
    const jsonResult = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--verify", "--json"],
      connectors: jsonFakes.connectors,
    });
    expect(jsonResult.exitCode).toBe(1);
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      ok: false,
      dryRun: false,
      namespace: "default",
      exportedCount: 2,
      writtenCount: 2,
      parity: { total: 9, matched: 7 },
    });
  });

  it("emits structured JSON on success and --dry-run", async () => {
    const liveFakes = createFakeConnectors();
    const liveResult = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--json"],
      connectors: liveFakes.connectors,
    });
    expect(liveResult.exitCode).toBe(0);
    expect(JSON.parse(liveResult.stdout)).toMatchObject({
      ok: true,
      dryRun: false,
      endpoint: "localhost:50051",
      namespace: "default",
      definitions: ["user", "document"],
      exportedCount: 2,
      writtenCount: 2,
      zedToken: "tok-42",
    });

    const dryFakes = createFakeConnectors();
    const dryResult = await runImportSpiceDbCli({
      argv: ["--endpoint", "localhost:50051", "--token", "tok", "--dry-run", "--json"],
      connectors: dryFakes.connectors,
    });
    expect(dryResult.exitCode).toBe(0);
    expect(JSON.parse(dryResult.stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      definitions: ["user", "document"],
      zedToken: "tok-42",
    });
  });

  it("returns exitCode 1 and closes connections on schema caveat failure", async () => {
    const fakes = createFakeConnectors({
      schemaText: [
        "definition user {}",
        "caveat only_us(region string) { region == 'us' }",
        "definition document { relation viewer: user with only_us }",
      ].join("\n"),
    });

    const result = await runImportSpiceDbCli({
      argv: [...BASE_LIVE_ARGS, "--json"],
      connectors: fakes.connectors,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    expect(result.stderr).toMatch(/caveat/i);
    expect(fakes.isSpiceClosed()).toBe(true);
    expect(fakes.isPgClosed()).toBe(true);
  });
});
