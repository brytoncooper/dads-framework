import { actor, anyOf, compileAccess, resource } from "@dads-framework/access";
import { describe, expect, it } from "vitest";

import type {
  PgMigrationClient,
  PgMigrationRow,
} from "../access-migrations/sql-migration-types.js";
import type { SpiceDbExportedTuple } from "../spicedb-to-postgres/authzed-client-adapter.js";
import {
  createAuthzedMigrationTarget,
  type AuthzedRelationshipUpdateLike,
  type AuthzedWriteClientLike,
} from "./authzed-target-adapter.js";
import { columnRelationOutboxTriggerSql } from "./column-relation-outbox-triggers.js";
import { migratePostgresToSpiceDb } from "./migrate-postgres-to-spicedb.js";

function buildModel() {
  const user = actor("user");
  const group = resource("group", {
    roles: { member: user },
    can: ({ member }) => ({ view: member }),
  });
  const org = resource("org", {
    roles: { member: [user.expiring, group.roles.member, user.anyone] },
    can: ({ member }) => ({ view: member }),
  });
  const doc = resource("document", {
    roles: {
      org,
      owner: user,
      parent: [org, user],
    },
    can: ({ org: orgRole, owner }) => ({ view: anyOf(owner, orgRole.view) }),
  });
  return {
    model: compileAccess([user, group, org, doc]),
    user,
    group,
    org,
    doc,
  };
}

describe("migratePostgresToSpiceDb & columnRelationOutboxTriggerSql", () => {
  it("streams tuple table rows and columnRelations across pages into AuthZed TOUCH writes", async () => {
    const schema = buildModel();
    const futureExpiry = new Date("2030-01-01T00:00:00.500Z");

    const tupleRows: readonly PgMigrationRow[] = [
      {
        resource_kind: "org",
        resource_id: "org-1",
        relation: "member",
        subject_kind: "user",
        subject_id: "alice",
        subject_relation: "",
        subject_is_wildcard: false,
        expires_at: futureExpiry,
      },
      {
        resource_kind: "org",
        resource_id: "org-2",
        relation: "member",
        subject_kind: "user",
        subject_id: "",
        subject_relation: "",
        subject_is_wildcard: true,
        expires_at: null,
      },
      {
        resource_kind: "org",
        resource_id: "org-1",
        relation: "member",
        subject_kind: "group",
        subject_id: "eng",
        subject_relation: "member",
        subject_is_wildcard: false,
        expires_at: null,
      },
    ];
    const docOrgRows: readonly PgMigrationRow[] = [
      { resource_id: "doc-1", target_id: "org-1" },
      { resource_id: "doc-2", target_id: "org-1" },
      { resource_id: "doc-3", target_id: "org-2" },
    ];

    const postgres: PgMigrationClient = {
      query(text, params = []) {
        if (text.includes("FROM dad_authorization_relationship")) {
          const limit = Number(params[1]);
          const offset = Number(params[2]);
          return Promise.resolve({
            rows: tupleRows.slice(offset, offset + limit),
          });
        }
        if (text.includes("FROM documents")) {
          const hasCursor = text.includes("> $1");
          const cursor = hasCursor ? String(params[0]) : "";
          const limit = Number(hasCursor ? params[1] : params[0]);
          const filtered = hasCursor
            ? docOrgRows.filter((row) => String(row["resource_id"]) > cursor)
            : docOrgRows;
          return Promise.resolve({ rows: filtered.slice(0, limit) });
        }
        return Promise.resolve({ rows: [] });
      },
    };

    let writtenSchema = "";
    const writeBatches: (readonly AuthzedRelationshipUpdateLike[])[] = [];
    const fakeClient: AuthzedWriteClientLike = {
      promises: {
        writeSchema({ schema: zed }) {
          writtenSchema = zed;
          return Promise.resolve();
        },
        writeRelationships({ updates }) {
          writeBatches.push(updates);
          return Promise.resolve({
            writtenAt: { token: `tok-${String(writeBatches.length)}` },
          });
        },
      },
    };

    const observed: SpiceDbExportedTuple[] = [];
    const result = await migratePostgresToSpiceDb({
      model: schema.model,
      postgres,
      spiceDb: fakeClient,
      namespace: "acme",
      batchSize: 2,
      pageSize: 2,
      columnRelations: [
        {
          role: schema.doc.roles.org,
          table: "documents",
          idColumn: "id",
          targetIdColumn: "org_id",
        },
      ],
      onBatch: (batch) => observed.push(...batch),
    });

    expect(writtenSchema).toContain("definition document");
    expect(result.tupleTableCount).toBe(3);
    expect(result.columnRelationCount).toBe(3);
    expect(result.totalWrittenCount).toBe(6);
    expect(result.zedToken).toBe("tok-3");
    expect(writeBatches).toHaveLength(3);
    expect(observed).toHaveLength(6);

    const firstUpdate = writeBatches[0]?.[0];
    expect(firstUpdate?.operation).toBe(2);
    expect(firstUpdate?.relationship.optionalExpiresAt).toEqual({
      seconds: String(Math.floor(futureExpiry.getTime() / 1000)),
      nanos: 500_000_000,
    });
    const wildcardUpdate = writeBatches[0]?.[1];
    expect(wildcardUpdate?.relationship.subject.object.objectId).toBe("*");
    const usersetUpdate = writeBatches[1]?.[0];
    expect(usersetUpdate?.relationship.subject.optionalRelation).toBe("member");
    const colRelUpdate = writeBatches[2]?.[1];
    expect(colRelUpdate?.relationship.resource).toEqual({
      objectType: "document",
      objectId: "doc-3",
    });
    expect(colRelUpdate?.relationship.subject.object).toEqual({
      objectType: "org",
      objectId: "org-2",
    });
    expect(result.outboxTriggers.up).toHaveLength(2);
    expect(result.outboxTriggers.down).toHaveLength(2);
  });

  it("generates idempotent outbox trigger DDL and rejects polymorphic or unsafe bindings", () => {
    const schema = buildModel();
    const ddl = columnRelationOutboxTriggerSql(
      schema.model,
      [
        {
          role: schema.doc.roles.org,
          table: "app.documents",
          idColumn: "id",
          targetIdColumn: "org_id",
        },
      ],
      { outboxTable: "custom_outbox" },
    );

    expect(ddl.up[0]).toContain("INSERT INTO custom_outbox");
    expect(ddl.up[0]).toContain("'document'");
    expect(ddl.up[0]).toContain("'org'");
    expect(ddl.up[1]).toContain(
      "AFTER INSERT OR UPDATE OR DELETE ON app.documents",
    );
    expect(ddl.down[0]).toContain("DROP TRIGGER IF EXISTS");
    expect(ddl.down[1]).toContain("DROP FUNCTION IF EXISTS");

    expect(() =>
      columnRelationOutboxTriggerSql(schema.model, [
        {
          role: schema.doc.roles.parent,
          table: "documents",
          idColumn: "id",
          targetIdColumn: "parent_id",
        },
      ]),
    ).toThrow("exactly one direct entity target");

    expect(() =>
      columnRelationOutboxTriggerSql(schema.model, [
        {
          role: schema.doc.roles.org,
          table: "documents; DROP TABLE users",
          idColumn: "id",
          targetIdColumn: "org_id",
        },
      ]),
    ).toThrow("Invalid table");
  });

  it("skips empty relationship batches cleanly in createAuthzedMigrationTarget", async () => {
    let calls = 0;
    const target = createAuthzedMigrationTarget({
      promises: {
        writeSchema: () => Promise.resolve(),
        writeRelationships() {
          calls += 1;
          return Promise.resolve({});
        },
      },
    });
    expect(await target.writeRelationships([])).toEqual({});
    expect(calls).toBe(0);
  });
});
