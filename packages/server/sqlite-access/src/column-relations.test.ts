import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  actor,
  anyOf,
  compileAccess,
  every,
  resource,
} from "@dads-framework/access";
import type { PermissionQuery } from "@dads-framework/access/runtime";
import { describe, expect, it } from "vitest";

import { compileAccessPolicy } from "./policy/compile-access-policy.js";
import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteColumnRelationIndexSql,
  sqliteRelationshipSchemaMigration,
  type SqliteColumnRelationBinding,
} from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);

function buildColumnAccessModel() {
  const user = actor("user");
  const org = resource("org", {
    roles: { admin: user, member: user },
    can: ({ admin, member }) => ({
      view: anyOf(admin, member),
      manage: admin,
    }),
  });
  const folder = resource("folder", {
    recursive: true,
    roles: {
      org,
      viewer: user,
    },
    can: ({ org: orgRole, viewer }) => ({
      view: anyOf(viewer, orgRole.view),
    }),
  });
  const doc = resource("document", {
    roles: {
      org,
      folder,
      owner: user,
      banned: user,
    },
    can: ({ org: orgRole, folder: folderRole, owner, banned }) => ({
      view: anyOf(owner, orgRole.view, folderRole.view).unless(banned),
      strict_org_view: every(orgRole).view,
    }),
  });
  return {
    model: compileAccess([user, org, folder, doc]),
    user,
    org,
    folder,
    doc,
  };
}

function createColumnBindings(
  schema: ReturnType<typeof buildColumnAccessModel>,
): readonly SqliteColumnRelationBinding[] {
  return [
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
}

function createSeededDb() {
  const db = new DatabaseSync(":memory:");
  for (const statement of sqliteRelationshipSchemaMigration.statements) {
    db.exec(statement);
  }
  db.exec(`
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
  `);
  db.exec(`
    INSERT INTO folders (id, org_id, parent_id) VALUES
      ('folder-root', 'org-1', NULL),
      ('folder-mid', NULL, 'folder-root'),
      ('folder-leaf', NULL, 'folder-mid'),
      ('folder-orphan', NULL, NULL);
    INSERT INTO documents (id, org_id, folder_id, owner_id) VALUES
      ('doc-org', 'org-1', NULL, NULL),
      ('doc-nested', NULL, 'folder-leaf', NULL),
      ('doc-owned', NULL, NULL, 'carol'),
      ('doc-both', 'org-2', 'folder-orphan', 'dave'),
      ('doc-null', NULL, NULL, NULL);
  `);
  return db;
}

describe("SQLite column-backed relations", () => {
  it("evaluates parent FK, recursive self-FK, direct actor FK, NULL FK, and live UPDATE flips", async () => {
    const schema = buildColumnAccessModel();
    const bindings = createColumnBindings(schema);
    const db = createSeededDb();
    const executor = createNodeSqliteExecutor(db);
    const authz = new SqliteAuthorization({
      model: schema.model,
      namespace: "ns",
      executor,
      columnRelations: bindings,
    });

    await authz.writeRelationships([
      {
        resource: { type: "org", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "folder", id: "folder-orphan" },
        relation: "viewer",
        subject: { type: "user", id: "bob" },
      },
      {
        resource: { type: "document", id: "doc-nested" },
        relation: "banned",
        subject: { type: "user", id: "alice" },
      },
    ]);

    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "document", id: "doc-org" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "folder", id: "folder-leaf" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "document", id: "doc-nested" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: { type: "user", id: "carol" },
        permission: "view",
        resource: { type: "document", id: "doc-owned" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "document", id: "doc-null" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "strict_org_view",
        resource: { type: "document", id: "doc-org" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "strict_org_view",
        resource: { type: "document", id: "doc-null" },
      }),
    ).toBe(false);

    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "folder",
      }),
    ).toEqual(["folder-leaf", "folder-mid", "folder-root"]);
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "carol" },
        permission: "view",
        resourceType: "document",
      }),
    ).toEqual(["doc-owned"]);
    expect(
      await authz.lookupSubjects({
        resource: { type: "document", id: "doc-both" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["bob", "dave"], hasWildcard: false });

    const autoFilter = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "document",
      idColumn: "doc.id",
      scopeColumns: "auto",
    });
    expect(autoFilter.sql).toContain("doc.org_id IN");
    const visibleDocs = db
      .prepare(
        `SELECT doc.id FROM documents doc WHERE ${autoFilter.sql} ORDER BY doc.id`,
      )
      .all(...autoFilter.values)
      .map((row) => String(row["id"]));
    expect(visibleDocs).toEqual(["doc-org"]);

    expect(
      await authz.relationshipExists({
        resourceType: "document",
        resourceId: "doc-owned",
        relation: "owner",
      }),
    ).toBe(true);
    expect(
      await authz.relationshipExists({
        resourceType: "document",
        resourceId: "doc-null",
        relation: "owner",
      }),
    ).toBe(false);
    expect(
      await authz.listDirectSubjects({
        resource: { type: "document", id: "doc-owned" },
        relation: "owner",
      }),
    ).toEqual([{ type: "user", id: "carol" }]);

    // Live SQL UPDATE flips access immediately with zero dual-writes.
    db.exec(`UPDATE documents SET owner_id = 'alice' WHERE id = 'doc-null'`);
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "document", id: "doc-null" },
      }),
    ).toBe(true);
    db.close();
  });

  it("refuses manual tuple writes/deletes on column-backed relations and verifies schema + indexes", async () => {
    const schema = buildColumnAccessModel();
    const bindings = createColumnBindings(schema);
    const db = createSeededDb();
    const executor = createNodeSqliteExecutor(db);
    const authz = new SqliteAuthorization({
      model: schema.model,
      namespace: "ns",
      executor,
      columnRelations: bindings,
    });

    await expect(
      authz.writeRelationships([
        {
          resource: { type: "document", id: "doc-1" },
          relation: "org",
          subject: { type: "org", id: "org-1" },
        },
      ]),
    ).rejects.toThrow("column-backed by documents.org_id");
    await expect(
      authz.deleteRelationships({
        resourceType: "document",
        resourceId: "doc-1",
        relation: "org",
      }),
    ).rejects.toThrow("column-backed by documents.org_id");

    const beforeIndexes = await authz.verifyColumnRelations();
    expect(beforeIndexes.every((entry) => !entry.hasRecommendedIndex)).toBe(
      true,
    );
    for (const ddl of sqliteColumnRelationIndexSql(bindings)) {
      db.exec(ddl);
    }
    const afterIndexes = await authz.verifyColumnRelations();
    expect(afterIndexes.every((entry) => entry.hasRecommendedIndex)).toBe(true);

    const badAuthz = new SqliteAuthorization({
      model: schema.model,
      namespace: "ns",
      executor,
      columnRelations: [
        {
          role: schema.doc.roles.org,
          table: "documents",
          idColumn: "id",
          targetIdColumn: "missing_column",
        },
      ],
    });
    await expect(badAuthz.verifyColumnRelations()).rejects.toThrow(
      "documents.missing_column",
    );
    db.close();
  });

  it("rejects polymorphic or wildcard bindings at construction time", () => {
    const user = actor("user");
    const team = resource("team", { roles: { member: user } });
    const item = resource("item", {
      roles: {
        parent: [team, user],
        public_viewer: user.anyone,
      },
    });
    const model = compileAccess([user, team, item]);
    const db = new DatabaseSync(":memory:");
    const executor = createNodeSqliteExecutor(db);

    expect(
      () =>
        new SqliteAuthorization({
          model,
          namespace: "ns",
          executor,
          columnRelations: [
            {
              role: item.roles.parent,
              table: "items",
              idColumn: "id",
              targetIdColumn: "parent_id",
            },
          ],
        }),
    ).toThrow("exactly one direct entity target");

    expect(
      () =>
        new SqliteAuthorization({
          model,
          namespace: "ns",
          executor,
          columnRelations: [
            {
              role: item.roles.public_viewer,
              table: "items",
              idColumn: "id",
              targetIdColumn: "viewer_id",
            },
          ],
        }),
    ).toThrow("exactly one direct entity target");
    db.close();
  });

  it("matches the formally verified Lean 4 oracle across all checks, lookups, and auto filters", async () => {
    if (!existsSync(ORACLE_BIN)) return;
    const schema = buildColumnAccessModel();
    const bindings = createColumnBindings(schema);
    const db = createSeededDb();
    const executor = createNodeSqliteExecutor(db);
    const authz = new SqliteAuthorization({
      model: schema.model,
      namespace: "ns",
      executor,
      columnRelations: bindings,
    });

    const tupleFacts = [
      {
        resource: { type: "org", id: "org-1" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "org", id: "org-2" },
        relation: "admin",
        subject: { type: "user", id: "eve" },
      },
      {
        resource: { type: "folder", id: "folder-orphan" },
        relation: "viewer",
        subject: { type: "user", id: "bob" },
      },
      {
        resource: { type: "document", id: "doc-nested" },
        relation: "banned",
        subject: { type: "user", id: "alice" },
      },
    ];
    await authz.writeRelationships(tupleFacts);

    const materializedColumnTuples: readonly (readonly [
      string,
      string,
      string,
      string,
      string,
    ])[] = [
      ["folder", "folder-root", "org", "org", "org-1"],
      ["folder", "folder-mid", "parent", "folder", "folder-root"],
      ["folder", "folder-leaf", "parent", "folder", "folder-mid"],
      ["document", "doc-org", "org", "org", "org-1"],
      ["document", "doc-nested", "folder", "folder", "folder-leaf"],
      ["document", "doc-owned", "owner", "user", "carol"],
      ["document", "doc-both", "org", "org", "org-2"],
      ["document", "doc-both", "folder", "folder", "folder-orphan"],
      ["document", "doc-both", "owner", "user", "dave"],
    ];
    const oracleTuples = [
      ...tupleFacts.map((fact) => ({
        resourceKind: fact.resource.type,
        resourceId: fact.resource.id,
        relation: fact.relation,
        subjectKind: fact.subject.type,
        subjectId: fact.subject.id,
        subjectRelation: "",
        subjectIsWildcard: false,
        expiresAt: null,
      })),
      ...materializedColumnTuples.map(
        ([resourceKind, resourceId, relation, subjectKind, subjectId]) => ({
          resourceKind,
          resourceId,
          relation,
          subjectKind,
          subjectId,
          subjectRelation: "",
          subjectIsWildcard: false,
          expiresAt: null,
        }),
      ),
    ];

    const actors = ["alice", "bob", "carol", "dave", "eve", "nobody"];
    const docs = ["doc-both", "doc-nested", "doc-null", "doc-org", "doc-owned"];
    const folders = [
      "folder-leaf",
      "folder-mid",
      "folder-orphan",
      "folder-root",
    ];
    const checkQueries: PermissionQuery[] = [];
    for (const actorId of actors) {
      for (const docId of docs) {
        checkQueries.push(
          {
            subject: { type: "user", id: actorId },
            permission: "view",
            resource: { type: "document", id: docId },
          },
          {
            subject: { type: "user", id: actorId },
            permission: "strict_org_view",
            resource: { type: "document", id: docId },
          },
        );
      }
      for (const folderId of folders) {
        checkQueries.push({
          subject: { type: "user", id: actorId },
          permission: "view",
          resource: { type: "folder", id: folderId },
        });
      }
    }

    const compiled = compileAccessPolicy(schema.model);
    const oraclePayload = {
      now: 0,
      model: {
        relations: compiled.model.relations,
        permissions: compiled.model.permissions.map((perm) => ({
          entity: perm.entity,
          wireName: perm.wireName,
          expression: perm.expression,
        })),
      },
      tuples: oracleTuples,
      checks: checkQueries.map((entry) => ({
        subjectKind: entry.subject.type,
        subjectId: entry.subject.id,
        resourceKind: entry.resource.type,
        resourceId: entry.resource.id,
        permission: entry.permission,
      })),
      lookups: actors.flatMap((actorId) => [
        {
          subjectKind: "user",
          subjectId: actorId,
          resourceKind: "document",
          permission: "view",
          universe: docs,
        },
        {
          subjectKind: "user",
          subjectId: actorId,
          resourceKind: "document",
          permission: "strict_org_view",
          universe: docs,
        },
        {
          subjectKind: "user",
          subjectId: actorId,
          resourceKind: "folder",
          permission: "view",
          universe: folders,
        },
      ]),
    };

    const stdout = execFileSync(ORACLE_BIN, {
      input: JSON.stringify(oraclePayload),
      encoding: "utf8",
    });
    const oracle: unknown = JSON.parse(stdout);
    if (
      typeof oracle !== "object" ||
      oracle === null ||
      !("checks" in oracle) ||
      !("lookups" in oracle) ||
      !Array.isArray(oracle.checks) ||
      !Array.isArray(oracle.lookups)
    ) {
      throw new Error("Invalid Lean 4 oracle response");
    }

    const oracleChecks: readonly unknown[] = oracle.checks;
    const oracleLookups: readonly unknown[] = oracle.lookups;
    const batchActual = await authz.checkMany(checkQueries);
    expect(batchActual).toEqual(oracleChecks.map(Boolean));
    for (let index = 0; index < checkQueries.length; index += 1) {
      const query = checkQueries[index];
      if (query === undefined) continue;
      expect(await authz.check(query)).toBe(Boolean(oracleChecks[index]));
    }

    for (let index = 0; index < oraclePayload.lookups.length; index += 1) {
      const lookupSpec = oraclePayload.lookups[index];
      if (lookupSpec === undefined) continue;
      const rawExpected = oracleLookups[index];
      const expected = Array.isArray(rawExpected)
        ? rawExpected.map(String)
        : [];
      const actualLookup = await authz.lookupResources({
        subject: { type: lookupSpec.subjectKind, id: lookupSpec.subjectId },
        permission: lookupSpec.permission,
        resourceType: lookupSpec.resourceKind,
      });
      expect(actualLookup).toEqual(expected);
      if (lookupSpec.resourceKind === "document") {
        const filter = authz.compileFilter({
          subject: { type: lookupSpec.subjectKind, id: lookupSpec.subjectId },
          permission: lookupSpec.permission,
          resourceType: "document",
          idColumn: "doc.id",
          scopeColumns: "auto",
        });
        const filteredIds = db
          .prepare(
            `SELECT doc.id FROM documents doc WHERE ${filter.sql} ORDER BY doc.id`,
          )
          .all(...filter.values)
          .map((row) => String(row["id"]));
        expect(filteredIds).toEqual(expected);
      }
    }
    db.close();
  });
});
