import { parseZed } from "@dads-framework/access";
import { describe, expect, it } from "vitest";

import type { PgMigrationExecutor } from "../access-migrations/sql-migration-types.js";
import {
  createAuthzedMigrationSource,
  type AuthzedExportResponseLike,
  type AuthzedV1ClientLike,
  type SpiceDbExportedTuple,
  type SpiceDbMigrationSource,
} from "./authzed-client-adapter.js";
import { migrateSpiceDbToPostgres } from "./migrate-spicedb-to-postgres.js";
import { verifySpiceDbPostgresParity, type ParityAuthorizationClient } from "./verify-parity.js";

type RecordedQuery = {
  readonly text: string;
  readonly values?: unknown[];
};

function createRecordingPg(): {
  readonly executor: PgMigrationExecutor;
  readonly queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const executor: PgMigrationExecutor = {
    query(text, values) {
      queries.push({ text, ...(values === undefined ? {} : { values }) });
      return Promise.resolve({ rows: [] });
    },
  };
  return { executor, queries };
}

async function* yieldPages<T>(pages: readonly T[]): AsyncGenerator<T> {
  for (const page of pages) {
    await Promise.resolve();
    yield page;
  }
}

describe("migrateSpiceDbToPostgres", () => {
  it("fails fast with a line-numbered error on unsupported caveats before touching Postgres", async () => {
    const { executor, queries } = createRecordingPg();
    let exportCalled = false;

    const source: SpiceDbMigrationSource = {
      readSchema: () =>
        Promise.resolve({
          schemaText: [
            "definition user {}",
            "caveat ip_allowed(ip string) {",
            "  ip == '127.0.0.1'",
            "}",
            "definition document {",
            "  relation viewer: user with ip_allowed",
            "}",
          ].join("\n"),
          zedToken: "tok-caveat",
        }),
      exportRelationships: () => {
        exportCalled = true;
        return yieldPages([]);
      },
    };

    await expect(
      migrateSpiceDbToPostgres({
        spiceDb: source,
        postgres: executor,
        namespace: "acme",
      }),
    ).rejects.toThrow(/line 2:.*caveat/i);

    expect(exportCalled).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it("streams tuples from an Authzed v1 client in batches, preserving subject_relation, wildcards, and expires_at", async () => {
    const { executor, queries } = createRecordingPg();
    const expiresAtSec = Math.floor(Date.UTC(2027, 0, 15, 8, 30, 0) / 1000);
    const expectedExpiry = new Date(expiresAtSec * 1000 + 250);

    const schemaText = [
      "use expiration",
      "",
      "definition user {}",
      "definition group {",
      "  relation member: user",
      "}",
      "definition workspace {",
      "  relation member: user with expiration | group#member | user:*",
      "  permission view = member",
      "}",
    ].join("\n");

    const chunks: readonly AuthzedExportResponseLike[] = [
      {
        relationships: [
          {
            resource: { objectType: "workspace", objectId: "ws_1" },
            relation: "member",
            subject: {
              object: { objectType: "user", objectId: "alice" },
              optionalRelation: "",
            },
            optionalExpiresAt: {
              seconds: String(expiresAtSec),
              nanos: 250_000_000,
            },
          },
          {
            resource: { objectType: "workspace", objectId: "ws_1" },
            relation: "member",
            subject: {
              object: { objectType: "group", objectId: "eng" },
              optionalRelation: "member",
            },
          },
        ],
      },
      {
        relationships: [
          {
            resource: { objectType: "workspace", objectId: "ws_pub" },
            relation: "member",
            subject: {
              object: { objectType: "user", objectId: "*" },
            },
          },
        ],
      },
    ];

    const fakeAuthzedClient: AuthzedV1ClientLike = {
      promises: {
        readSchema: () =>
          Promise.resolve({
            schemaText,
            readAt: { token: "zed-tok-123" },
          }),
      },
      exportBulkRelationships: () => yieldPages(chunks),
    };

    const seenBatches: (readonly SpiceDbExportedTuple[])[] = [];
    const result = await migrateSpiceDbToPostgres({
      spiceDb: fakeAuthzedClient,
      postgres: executor,
      namespace: "acme",
      batchSize: 2,
      onBatch: (batch) => seenBatches.push(batch),
    });

    expect(result.schemaZed).toBe(schemaText);
    expect(result.zedToken).toBe("zed-tok-123");
    expect(result.exportedCount).toBe(3);
    expect(result.writtenCount).toBe(3);
    expect(result.definitions.map((def) => def.wireName)).toEqual(["user", "group", "workspace"]);
    expect(result.generatedTypeScript).toContain("user.expiring");
    expect(result.generatedTypeScript).toContain("group.roles.member");
    expect(result.generatedTypeScript).toContain("user.anyone");
    expect(seenBatches).toHaveLength(2);
    expect(seenBatches[0]).toHaveLength(2);
    expect(seenBatches[1]).toHaveLength(1);

    // 2 DDL statements + 2 batched INSERT ... ON CONFLICT DO UPDATE statements
    expect(queries).toHaveLength(4);
    expect(queries[0]?.text).toContain("CREATE TABLE IF NOT EXISTS dad_authorization_relationship");
    expect(queries[1]?.text).toContain("ADD COLUMN IF NOT EXISTS expires_at");

    const firstInsertValues = queries[2]?.values;
    expect(firstInsertValues).toEqual([
      "acme",
      ["workspace", "workspace"],
      ["ws_1", "ws_1"],
      ["member", "member"],
      ["user", "group"],
      ["alice", "eng"],
      ["", "member"],
      [false, false],
      [expectedExpiry, null],
    ]);

    const secondInsertValues = queries[3]?.values;
    expect(secondInsertValues).toEqual([
      "acme",
      ["workspace"],
      ["ws_pub"],
      ["member"],
      ["user"],
      [""],
      [""],
      [true],
      [null],
    ]);
  });

  it("rejects caveated tuples received from ExportBulkRelationships", async () => {
    const { executor } = createRecordingPg();
    const source = createAuthzedMigrationSource({
      promises: {
        readSchema: () =>
          Promise.resolve({
            schemaText: "definition user {}\ndefinition doc {\n  relation viewer: user\n}",
          }),
      },
      exportBulkRelationships: () =>
        yieldPages([
          {
            relationships: [
              {
                resource: { objectType: "doc", objectId: "d1" },
                relation: "viewer",
                subject: { object: { objectType: "user", objectId: "alice" } },
                optionalCaveat: { caveatName: "region_check" },
              },
            ],
          },
        ]),
    });

    await expect(
      migrateSpiceDbToPostgres({
        spiceDb: source,
        postgres: executor,
        namespace: "acme",
      }),
    ).rejects.toThrow(/caveat "region_check"/);
  });
});

describe("verifySpiceDbPostgresParity", () => {
  it("auto-derives check and lookup queries from schema + tuples and reports 0 mismatches when decisions match", async () => {
    const definitions = parseZed(`
      definition user {}
      definition document {
        relation viewer: user
        permission view = viewer
      }
    `);
    const tuples: readonly SpiceDbExportedTuple[] = [
      {
        resource: { type: "document", id: "d1" },
        relation: "viewer",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "document", id: "d2" },
        relation: "viewer",
        subject: { type: "user", id: "bob" },
      },
    ];

    const allowMap = new Map<string, readonly string[]>([
      ["alice", ["d1"]],
      ["bob", ["d2"]],
    ]);

    const makeClient = (): ParityAuthorizationClient => ({
      check: (q) => Promise.resolve((allowMap.get(q.subject.id) ?? []).includes(q.resource.id)),
      lookupResources: (q) => Promise.resolve(allowMap.get(q.subject.id) ?? []),
    });

    const report = await verifySpiceDbPostgresParity({
      spiceDb: makeClient(),
      postgres: makeClient(),
      definitions,
      tuples,
    });

    // 3 subjects (alice, bob, __parity_stranger__) * (2 checks + 1 lookup) = 9
    expect(report.total).toBe(9);
    expect(report.matched).toBe(9);
    expect(report.mismatches).toEqual([]);
  });

  it("reports check and lookup-resources mismatches clearly", async () => {
    const spiceClient: ParityAuthorizationClient = {
      check: () => Promise.resolve(true),
      lookupResources: () => Promise.resolve(["d1", "d2"]),
    };
    const pgClient: ParityAuthorizationClient = {
      check: () => Promise.resolve(false),
      lookupResources: () => Promise.resolve(["d1"]),
    };

    const report = await verifySpiceDbPostgresParity({
      spiceDb: spiceClient,
      postgres: pgClient,
      checkQueries: [
        {
          subject: { type: "user", id: "alice" },
          permission: "view",
          resource: { type: "document", id: "d2" },
        },
      ],
      lookupQueries: [
        {
          subject: { type: "user", id: "alice" },
          permission: "view",
          resourceType: "document",
        },
      ],
    });

    expect(report.total).toBe(2);
    expect(report.matched).toBe(0);
    expect(report.mismatches).toEqual([
      {
        kind: "check",
        query: {
          subject: { type: "user", id: "alice" },
          permission: "view",
          resource: { type: "document", id: "d2" },
        },
        spiceDb: true,
        postgres: false,
      },
      {
        kind: "lookup-resources",
        query: {
          subject: { type: "user", id: "alice" },
          permission: "view",
          resourceType: "document",
        },
        spiceDb: ["d1", "d2"],
        postgres: ["d1"],
      },
    ]);
  });
});
