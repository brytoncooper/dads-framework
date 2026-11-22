import { v1 } from "@authzed/authzed-node";
import {
  actor,
  anyOf,
  compileAccess,
  resource,
  roleToken,
} from "@dads-framework/access";
import { SpiceDbAuthorization } from "@dads-framework/authorization";
import { startTestSpiceDb } from "@dads-framework/authorization/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import {
  PostgresAuthorization,
  relationshipSchemaMigration,
  type ColumnRelationBinding,
} from "@dads-framework/postgres-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SpiceDbExportedTuple } from "../spicedb-to-postgres/authzed-client-adapter.js";
import { verifySpiceDbPostgresParity } from "../spicedb-to-postgres/verify-parity.js";
import {
  columnRelationOutboxTriggerSql,
  migratePostgresToSpiceDb,
} from "./index.js";

function buildExitRampModel() {
  const user = actor("user");
  const groupMember = roleToken("exit/group", "member", user.handle);
  const group = resource("exit/group", {
    roles: { member: [user.expiring, groupMember] },
    can: ({ member }) => ({ read: member }),
  });
  const org = resource("exit/org", {
    roles: {
      admin: user,
      member: [user.expiring, group.roles.member, user.anyone],
    },
    can: ({ admin, member }) => ({
      view: anyOf(admin, member),
      manage: admin,
    }),
  });
  const folder = resource("exit/folder", {
    recursive: true,
    roles: { org, viewer: user },
    can: ({ org: orgRole, viewer }) => ({
      view: anyOf(viewer, orgRole.view),
    }),
  });
  const doc = resource("exit/document", {
    roles: {
      org,
      folder,
      owner: user,
      banned: user,
    },
    can: ({ org: orgRole, folder: folderRole, owner, banned }) => ({
      view: anyOf(owner, orgRole.view, folderRole.view).unless(banned),
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

describe("Live Docker Postgres (with columnRelations) -> SpiceDB migration & parity", () => {
  const disposers: (() => Promise<void>)[] = [];
  let postgres:
    Awaited<ReturnType<typeof startUnmigratedTestPostgres>> | undefined;
  let spice: Awaited<ReturnType<typeof startTestSpiceDb>> | undefined;
  let rawSpiceClient: v1.ZedClientInterface | undefined;
  let spiceAuth: SpiceDbAuthorization | undefined;

  beforeAll(async () => {
    const [startedPg, startedSpice] = await Promise.all([
      startUnmigratedTestPostgres(),
      startTestSpiceDb(),
    ]);
    postgres = startedPg;
    spice = startedSpice;
    disposers.push(
      () => startedPg.stop(),
      () => startedSpice.stop(),
    );

    rawSpiceClient = v1.NewClient(
      startedSpice.presharedKey,
      startedSpice.endpoint,
      v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
    );
    disposers.push(() => {
      rawSpiceClient?.close();
      return Promise.resolve();
    });
    spiceAuth = new SpiceDbAuthorization({
      endpoint: startedSpice.endpoint,
      presharedKey: startedSpice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });

    await startedPg.pool.query(relationshipSchemaMigration.sql);
    await startedPg.pool.query(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        parent_id TEXT
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        folder_id TEXT,
        owner_id TEXT
      );
      CREATE TABLE authorization_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key text NOT NULL UNIQUE,
        operation text NOT NULL,
        resource_type text NOT NULL,
        resource_id text NOT NULL,
        relation text NOT NULL,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        subject_relation text,
        owner_partition_id uuid,
        status text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        enqueued_at timestamptz NOT NULL
      );
    `);
  }, 180_000);

  afterAll(async () => {
    for (const dispose of disposers.reverse()) {
      await dispose();
    }
  }, 60_000);

  it("exports tuple table + columnRelations into live SpiceDB with 0 parity mismatches and installs working outbox triggers", async () => {
    if (
      postgres === undefined ||
      spice === undefined ||
      rawSpiceClient === undefined ||
      spiceAuth === undefined
    ) {
      throw new Error("Docker containers were not started");
    }
    const pool = postgres.pool;
    const schema = buildExitRampModel();
    const bindings: readonly ColumnRelationBinding[] = [
      {
        role: schema.folder.roles.org,
        table: "folders",
        idColumn: "id",
        targetIdColumn: "org_id",
      },
      {
        role: schema.folder.roles.parent,
        table: "folders",
        idColumn: "id",
        targetIdColumn: "parent_id",
      },
      {
        role: schema.doc.roles.org,
        table: "documents",
        idColumn: "id",
        targetIdColumn: "org_id",
      },
      {
        role: schema.doc.roles.folder,
        table: "documents",
        idColumn: "id",
        targetIdColumn: "folder_id",
      },
      {
        role: schema.doc.roles.owner,
        table: "documents",
        idColumn: "id",
        targetIdColumn: "owner_id",
      },
    ];

    const pgAuth = new PostgresAuthorization({
      model: schema.model,
      namespace: "exit-ns",
      executor: pool,
      columnRelations: bindings,
    });

    await pool.query(`
      INSERT INTO folders (id, org_id, parent_id) VALUES
        ('f-root', 'org-1', NULL),
        ('f-child', NULL, 'f-root'),
        ('f-orphan', NULL, NULL);
      INSERT INTO documents (id, org_id, folder_id, owner_id) VALUES
        ('doc-org', 'org-1', NULL, NULL),
        ('doc-nested', NULL, 'f-child', NULL),
        ('doc-owned', NULL, NULL, 'carol'),
        ('doc-public', 'org-public', NULL, NULL),
        ('doc-empty', NULL, NULL, NULL);
    `);

    const nowMs = Date.now();
    await pgAuth.writeRelationships([
      {
        resource: { type: "exit/group", id: "eng" },
        relation: "member",
        subject: { type: "user", id: "alice" },
        expiresAt: new Date(nowMs + 3_600_000),
      },
      {
        resource: { type: "exit/org", id: "org-1" },
        relation: "member",
        subject: { type: "exit/group", id: "eng", relation: "member" },
      },
      {
        resource: { type: "exit/org", id: "org-public" },
        relation: "member",
        subject: { type: "user", id: "*" },
      },
      {
        resource: { type: "exit/org", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "expired-user" },
        expiresAt: new Date(nowMs - 60_000),
      },
      {
        resource: { type: "exit/document", id: "doc-nested" },
        relation: "banned",
        subject: { type: "user", id: "alice" },
      },
    ]);

    const exportedTuples: SpiceDbExportedTuple[] = [];
    const migration = await migratePostgresToSpiceDb({
      model: schema.model,
      postgres: pool,
      spiceDb: rawSpiceClient,
      namespace: "exit-ns",
      columnRelations: bindings,
      batchSize: 3,
      pageSize: 2,
      onBatch: (batch) => exportedTuples.push(...batch),
    });

    // 4 active tuples (expired-user skipped) + 6 non-NULL column-backed FK edges = 10 total!
    expect(migration.tupleTableCount).toBe(4);
    expect(migration.columnRelationCount).toBe(6);
    expect(migration.totalWrittenCount).toBe(10);

    const parity = await verifySpiceDbPostgresParity({
      spiceDb: spiceAuth,
      postgres: pgAuth,
      definitions: migration.definitions,
      tuples: exportedTuples,
      negativeSubjectIds: ["stranger", "expired-user"],
    });
    expect(parity.total).toBeGreaterThan(20);
    expect(parity.mismatches).toEqual([]);

    // Install outbox sync triggers and prove live INSERT/UPDATE/DELETE feed authorization_outbox automatically!
    const triggers = columnRelationOutboxTriggerSql(schema.model, bindings);
    for (const statement of triggers.up) {
      await pool.query(statement);
    }

    await pool.query(
      "INSERT INTO documents (id, org_id, owner_id) VALUES ('doc-live', 'org-1', 'dave')",
    );
    await pool.query(
      "UPDATE documents SET owner_id = 'eve' WHERE id = 'doc-live'",
    );
    await pool.query("DELETE FROM documents WHERE id = 'doc-live'");

    const outboxRows = await pool.query<{
      operation: string;
      resource_type: string;
      resource_id: string;
      relation: string;
      subject_type: string;
      subject_id: string;
      status: string;
    }>(
      `SELECT operation, resource_type, resource_id, relation, subject_type, subject_id, status
         FROM authorization_outbox
        WHERE resource_id = 'doc-live'
        ORDER BY enqueued_at ASC, operation ASC, relation ASC`,
    );

    const events = outboxRows.rows.map(
      (row) =>
        `${row.operation}:${row.resource_type}:${row.resource_id}#${row.relation}@${row.subject_type}:${row.subject_id}:${row.status}`,
    );
    expect(events).toContain(
      "WRITE:exit/document:doc-live#org@exit/org:org-1:PENDING",
    );
    expect(events).toContain(
      "WRITE:exit/document:doc-live#owner@user:dave:PENDING",
    );
    expect(events).toContain(
      "DELETE:exit/document:doc-live#owner@user:dave:PENDING",
    );
    expect(events).toContain(
      "WRITE:exit/document:doc-live#owner@user:eve:PENDING",
    );
    expect(events).toContain(
      "DELETE:exit/document:doc-live#org@exit/org:org-1:PENDING",
    );
    expect(events).toContain(
      "DELETE:exit/document:doc-live#owner@user:eve:PENDING",
    );

    // Clean teardown via generated down DDL.
    for (const statement of triggers.down) {
      await pool.query(statement);
    }
  }, 30_000);
});
