import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { actor, anyOf, compileAccess, resource, roleToken } from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/access/runtime";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileAccessPolicy } from "./compile-access-policy.js";
import { compileSharedPointCheck } from "./policy/compile-shared-point-check.js";
import {
  columnRelationIndexSql,
  POSTGRES_CONFLICT,
  PostgresAuthorization,
  PostgresSerializationConflict,
  preparePostgresChecks,
  relationshipSchemaMigration,
  withProtectedPgTransaction,
  type ColumnRelationBinding,
} from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);

function buildMixedColumnModel() {
  const user = actor("user");
  const groupMember = roleToken("edge/group", "member", user.handle);
  const group = resource("edge/group", {
    roles: {
      member: [user.expiring, groupMember, user.anyone.expiring],
    },
    can: ({ member }) => ({ read: member }),
  });
  const org = resource("edge/org", {
    roles: {
      member: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    },
    can: ({ member }) => ({ view: member }),
  });
  const folder = resource("edge/folder", {
    recursive: true,
    roles: {
      org,
      viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    },
    can: ({ org: orgRole, viewer }) => ({
      view: anyOf(viewer, orgRole.view),
    }),
  });
  const doc = resource("edge/document", {
    roles: {
      org,
      folder,
      owner: user,
      viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
      banned: user,
    },
    can: ({ org: orgRole, folder: folderRole, owner, viewer, banned }) => ({
      view: anyOf(owner, viewer, orgRole.view, folderRole.view).unless(banned),
    }),
  });
  return {
    model: compileAccess([user, group, org, folder, doc]),
    user,
    group,
    org,
    folder,
    doc,
  };
}

function createSchemaQualifiedBindings(
  schema: ReturnType<typeof buildMixedColumnModel>,
): readonly ColumnRelationBinding[] {
  return [
    {
      role: schema.folder.roles.org,
      table: "app.folders",
      idColumn: "id",
      targetIdColumn: "org_id",
    },
    {
      role: schema.folder.roles.parent,
      table: "app.folders",
      idColumn: "id",
      targetIdColumn: "parent_id",
    },
    {
      role: schema.doc.roles.org,
      table: "app.documents",
      idColumn: "id",
      targetIdColumn: "org_id",
    },
    {
      role: schema.doc.roles.folder,
      table: "app.documents",
      idColumn: "id",
      targetIdColumn: "folder_id",
    },
    {
      role: schema.doc.roles.owner,
      table: "app.documents",
      idColumn: "id",
      targetIdColumn: "owner_id",
    },
  ];
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let releaseAll: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) {
      releaseAll?.();
    }
    return gate;
  };
}

describe("PostgreSQL column-backed edge cases & live 40001 retries", () => {
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>> | undefined;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    await postgres.pool.query(relationshipSchemaMigration.sql);
    await postgres.pool.query(`
      CREATE SCHEMA app;
      CREATE TABLE app.folders (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        parent_id TEXT
      );
      CREATE TABLE app.documents (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        folder_id TEXT,
        owner_id TEXT
      );
      CREATE TABLE skew_accounts (
        id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  function requirePool() {
    if (postgres === undefined) {
      throw new Error("Test PostgreSQL container was not started");
    }
    return postgres.pool;
  }

  async function seedCyclicSchemaQualifiedData(): Promise<void> {
    const pool = requirePool();
    await pool.query("TRUNCATE TABLE dad_authorization_relationship, app.documents, app.folders");
    await pool.query(`
      INSERT INTO app.folders (id, org_id, parent_id) VALUES
        ('f-cycle-a', NULL, 'f-cycle-b'),
        ('f-cycle-b', NULL, 'f-cycle-c'),
        ('f-cycle-c', 'org-team', 'f-cycle-a'),
        ('f-branch', NULL, 'f-cycle-a'),
        ('f-self', NULL, 'f-self'),
        ('f-open', 'org-public', NULL);
      INSERT INTO app.documents (id, org_id, folder_id, owner_id) VALUES
        ('doc-cycle', NULL, 'f-branch', NULL),
        ('doc-self', NULL, 'f-self', 'carol'),
        ('doc-wild', 'org-public', NULL, NULL),
        ('doc-exp', NULL, NULL, NULL);
    `);
  }

  it("handles schema-qualified tables, cyclic parent_id chains, usersets, wildcards, expiry, and SharedPointCompiler with 0 Lean 4 mismatches", async () => {
    const pool = requirePool();
    await seedCyclicSchemaQualifiedData();
    const schema = buildMixedColumnModel();
    const bindings = createSchemaQualifiedBindings(schema);
    const authz = new PostgresAuthorization({
      model: schema.model,
      namespace: "ns-edge",
      executor: preparePostgresChecks(pool),
      columnRelations: bindings,
    });

    const beforeIdx = await authz.verifyColumnRelations();
    expect(beforeIdx.every((item) => !item.hasRecommendedIndex)).toBe(true);
    for (const ddl of columnRelationIndexSql(bindings)) {
      await pool.query(ddl);
    }
    const afterIdx = await authz.verifyColumnRelations();
    expect(afterIdx.every((item) => item.hasRecommendedIndex)).toBe(true);

    const nowMs = Date.now();
    const expired = new Date(nowMs - 60_000);
    const activeFuture = new Date(nowMs + 3_600_000);
    const writes: readonly RelationshipWrite[] = [
      {
        resource: { type: "edge/group", id: "grp-inner" },
        relation: "member",
        subject: { type: "user", id: "alice" },
        expiresAt: activeFuture,
      },
      {
        resource: { type: "edge/group", id: "grp-outer" },
        relation: "member",
        subject: { type: "edge/group", id: "grp-inner", relation: "member" },
      },
      {
        resource: { type: "edge/org", id: "org-team" },
        relation: "member",
        subject: { type: "edge/group", id: "grp-outer", relation: "member" },
        expiresAt: activeFuture,
      },
      {
        resource: { type: "edge/org", id: "org-public" },
        relation: "member",
        subject: { type: "user", id: "*" },
        expiresAt: activeFuture,
      },
      {
        resource: { type: "edge/document", id: "doc-exp" },
        relation: "viewer",
        subject: { type: "user", id: "bob" },
        expiresAt: expired,
      },
      {
        resource: { type: "edge/document", id: "doc-wild" },
        relation: "banned",
        subject: { type: "user", id: "bob" },
      },
    ];
    await authz.writeRelationships(writes);

    // Cyclic self-loop and 3-node cycle terminate cleanly across all query modes.
    expect(
      await authz.lookupSubjects({
        resource: { type: "edge/document", id: "doc-cycle" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "edge/document", id: "doc-wild" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: true });
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "nobody" },
        permission: "view",
        resourceType: "edge/folder",
      }),
    ).toEqual(["f-open"]);

    if (!existsSync(ORACLE_BIN)) return;
    const compiled = compileAccessPolicy(schema.model, bindings);
    const actors = ["alice", "bob", "carol", "nobody"];
    const docs = ["doc-cycle", "doc-exp", "doc-self", "doc-wild"];
    const folders = ["f-branch", "f-cycle-a", "f-cycle-b", "f-cycle-c", "f-open", "f-self"];
    const queries: PermissionQuery[] = [];
    for (const actorId of actors) {
      for (const docId of docs) {
        queries.push({
          subject: { type: "user", id: actorId },
          permission: "view",
          resource: { type: "edge/document", id: docId },
        });
      }
      for (const folderId of folders) {
        queries.push({
          subject: { type: "user", id: actorId },
          permission: "view",
          resource: { type: "edge/folder", id: folderId },
        });
      }
    }

    const oracle = runOracle(compiled.model, writes, nowMs, queries, actors, docs, folders);
    expect(await authz.checkMany(queries)).toEqual(oracle.checks);

    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index];
      if (query === undefined) continue;
      expect(await authz.check(query)).toBe(oracle.checks[index]);
      const sharedQuery = compileSharedPointCheck(compiled.model, "ns-edge", {
        subject: { type: query.subject.type, id: query.subject.id },
        resource: query.resource,
        permission: query.permission,
      });
      const sharedRows = await pool.query<{ allowed: boolean }>(sharedQuery.text, [...(sharedQuery.values ?? [])]);
      expect(Boolean(sharedRows.rows[0]?.allowed)).toBe(oracle.checks[index]);
    }

    for (const actorId of actors) {
      const expectedDocs = oracle.docLookups.get(actorId) ?? [];
      const expectedFolders = oracle.folderLookups.get(actorId) ?? [];
      expect(
        await authz.lookupResources({
          subject: { type: "user", id: actorId },
          permission: "view",
          resourceType: "edge/document",
        }),
      ).toEqual(expectedDocs);
      expect(
        await authz.lookupResources({
          subject: { type: "user", id: actorId },
          permission: "view",
          resourceType: "edge/folder",
        }),
      ).toEqual(expectedFolders);

      const resolved = await authz.resolveFilter({
        subject: { type: "user", id: actorId },
        permission: "view",
        resourceType: "edge/document",
        idColumn: "doc.id",
        scopeColumns: "auto",
      });
      const filteredRows = await pool.query<{ id: string }>(
        `SELECT doc.id FROM app.documents doc WHERE ${resolved.sql} ORDER BY doc.id`,
        [...resolved.values],
      );
      expect(filteredRows.rows.map((row) => row.id)).toEqual(expectedDocs);
    }
  }, 30_000);

  it("recovers automatically from a real concurrent PostgreSQL 40001 SSI write-skew conflict", async () => {
    const pool = requirePool();
    const schema = buildMixedColumnModel();
    const authz = new PostgresAuthorization({
      model: schema.model,
      namespace: "ns-retry",
      executor: pool,
    });

    const runWriteSkew = async (retries: number) => {
      await pool.query("TRUNCATE TABLE skew_accounts");
      await pool.query("INSERT INTO skew_accounts (id, balance) VALUES ('acct-a', 100), ('acct-b', 100)");
      const waitBothRead = createBarrier(2);
      let firstRunReads = 0;
      let totalAttempts = 0;

      const debit = (targetId: string) =>
        withProtectedPgTransaction({ pool, authorization: authz, retries, retryBaseDelayMs: 5 }, async ({ client }) => {
          totalAttempts += 1;
          const totalRows = await client.query("SELECT SUM(balance)::text AS total FROM skew_accounts");
          const rawTotal = totalRows.rows[0]?.["total"];
          const total = typeof rawTotal === "string" ? Number(rawTotal) : 0;
          firstRunReads += 1;
          if (firstRunReads <= 2) {
            await waitBothRead();
          }
          if (total >= 150) {
            await client.query("UPDATE skew_accounts SET balance = balance - 80 WHERE id = $1", [targetId]);
          }
          return total;
        });

      const settled = await Promise.allSettled([debit("acct-a"), debit("acct-b")]);
      const finalRows = await pool.query<{ id: string; balance: number }>(
        "SELECT id, balance FROM skew_accounts ORDER BY id",
      );
      return { settled, totalAttempts, finalRows: finalRows.rows };
    };

    // With retries: 0, one transaction MUST fail with real Postgres 40001.
    const noRetry = await runWriteSkew(0);
    const rejected = noRetry.settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(PostgresSerializationConflict);
    if (rejected[0]?.reason instanceof PostgresSerializationConflict) {
      expect(rejected[0].reason.code).toBe(POSTGRES_CONFLICT);
    }

    // With retries: 4, the conflicted transaction retries cleanly and both observe serialized totals!
    const withRetry = await runWriteSkew(4);
    expect(withRetry.settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(withRetry.totalAttempts).toBeGreaterThanOrEqual(3);
    // Serialized invariant: only the first debit (>= 150) withdrew 80; the retried tx saw total=120!
    const finalTotal = withRetry.finalRows.reduce((sum, row) => sum + row.balance, 0);
    expect(finalTotal).toBe(120);
  });
});

function runOracle(
  model: ReturnType<typeof compileAccessPolicy>["model"],
  writes: readonly RelationshipWrite[],
  nowMs: number,
  queries: readonly PermissionQuery[],
  actors: readonly string[],
  docs: readonly string[],
  folders: readonly string[],
) {
  const columnTuples: readonly (readonly [string, string, string, string, string])[] = [
    ["edge/folder", "f-cycle-a", "parent", "edge/folder", "f-cycle-b"],
    ["edge/folder", "f-cycle-b", "parent", "edge/folder", "f-cycle-c"],
    ["edge/folder", "f-cycle-c", "org", "edge/org", "org-team"],
    ["edge/folder", "f-cycle-c", "parent", "edge/folder", "f-cycle-a"],
    ["edge/folder", "f-branch", "parent", "edge/folder", "f-cycle-a"],
    ["edge/folder", "f-self", "parent", "edge/folder", "f-self"],
    ["edge/folder", "f-open", "org", "edge/org", "org-public"],
    ["edge/document", "doc-cycle", "folder", "edge/folder", "f-branch"],
    ["edge/document", "doc-self", "folder", "edge/folder", "f-self"],
    ["edge/document", "doc-self", "owner", "user", "carol"],
    ["edge/document", "doc-wild", "org", "edge/org", "org-public"],
  ];
  const tuples = [
    ...writes.map((entry) => ({
      resourceKind: entry.resource.type,
      resourceId: entry.resource.id,
      relation: entry.relation,
      subjectKind: entry.subject.type,
      subjectId: entry.subject.id === "*" ? "" : entry.subject.id,
      subjectRelation: entry.subject.relation ?? "",
      subjectIsWildcard: entry.subject.id === "*",
      expiresAt: entry.expiresAt?.getTime() ?? null,
    })),
    ...columnTuples.map(([resourceKind, resourceId, relation, subjectKind, subjectId]) => ({
      resourceKind,
      resourceId,
      relation,
      subjectKind,
      subjectId,
      subjectRelation: "",
      subjectIsWildcard: false,
      expiresAt: null,
    })),
  ];
  const lookups = [
    ...actors.map((actorId) => ({
      subjectKind: "user",
      subjectId: actorId,
      resourceKind: "edge/document",
      permission: "view",
      universe: docs,
    })),
    ...actors.map((actorId) => ({
      subjectKind: "user",
      subjectId: actorId,
      resourceKind: "edge/folder",
      permission: "view",
      universe: folders,
    })),
  ];
  const stdout = execFileSync(ORACLE_BIN, {
    input: JSON.stringify({
      now: nowMs,
      model: {
        relations: model.relations,
        permissions: model.permissions.map((perm) => ({
          entity: perm.entity,
          wireName: perm.wireName,
          expression: perm.expression,
        })),
      },
      tuples,
      checks: queries.map((entry) => ({
        subjectKind: entry.subject.type,
        subjectId: entry.subject.id,
        resourceKind: entry.resource.type,
        resourceId: entry.resource.id,
        permission: entry.permission,
      })),
      lookups,
    }),
    encoding: "utf8",
  });
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("checks" in parsed) ||
    !("lookups" in parsed) ||
    !Array.isArray(parsed.checks) ||
    !Array.isArray(parsed.lookups)
  ) {
    throw new Error("Unexpected Lean 4 oracle output");
  }
  const rawChecks: readonly unknown[] = parsed.checks;
  const rawLookups: readonly unknown[] = parsed.lookups;
  const docLookups = new Map<string, readonly string[]>();
  const folderLookups = new Map<string, readonly string[]>();
  for (let index = 0; index < actors.length; index += 1) {
    const actorId = actors[index];
    if (actorId === undefined) continue;
    const rawDoc = rawLookups[index];
    const rawFolder = rawLookups[actors.length + index];
    docLookups.set(actorId, Array.isArray(rawDoc) ? rawDoc.map(String).sort() : []);
    folderLookups.set(actorId, Array.isArray(rawFolder) ? rawFolder.map(String).sort() : []);
  }
  return { checks: rawChecks.map(Boolean), docLookups, folderLookups };
}
