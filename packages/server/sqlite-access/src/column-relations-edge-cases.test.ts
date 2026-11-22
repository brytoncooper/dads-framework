import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  actor,
  anyOf,
  compileAccess,
  resource,
  roleToken,
} from "@dads-framework/access";
import type {
  PermissionQuery,
  RelationshipWrite,
} from "@dads-framework/access/runtime";
import { describe, expect, it } from "vitest";

import { compileAccessPolicy } from "./policy/compile-access-policy.js";
import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
  type SqliteColumnRelationBinding,
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
      member: [
        user.expiring,
        group.roles.member.expiring,
        user.anyone.expiring,
      ],
    },
    can: ({ member }) => ({ view: member }),
  });
  const folder = resource("edge/folder", {
    recursive: true,
    roles: {
      org,
      viewer: [
        user.expiring,
        group.roles.member.expiring,
        user.anyone.expiring,
      ],
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
      viewer: [
        user.expiring,
        group.roles.member.expiring,
        user.anyone.expiring,
      ],
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

function seedCyclicDb() {
  const db = new DatabaseSync(":memory:");
  for (const statement of sqliteRelationshipSchemaMigration.statements) {
    db.exec(statement);
  }
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, org_id TEXT, parent_id TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, org_id TEXT, folder_id TEXT, owner_id TEXT);
    INSERT INTO folders (id, org_id, parent_id) VALUES
      ('f-cycle-a', NULL, 'f-cycle-b'),
      ('f-cycle-b', NULL, 'f-cycle-c'),
      ('f-cycle-c', 'org-team', 'f-cycle-a'),
      ('f-branch', NULL, 'f-cycle-a'),
      ('f-self', NULL, 'f-self'),
      ('f-open', 'org-public', NULL);
    INSERT INTO documents (id, org_id, folder_id, owner_id) VALUES
      ('doc-cycle', NULL, 'f-branch', NULL),
      ('doc-self', NULL, 'f-self', 'carol'),
      ('doc-wild', 'org-public', NULL, NULL),
      ('doc-exp', NULL, NULL, NULL);
  `);
  return db;
}

function runOracle(
  model: ReturnType<typeof compileAccessPolicy>["model"],
  writes: readonly RelationshipWrite[],
  nowMs: number,
  queries: readonly PermissionQuery[],
  actors: readonly string[],
  docs: readonly string[],
  folders: readonly string[],
) {
  const columnTuples: readonly (readonly [
    string,
    string,
    string,
    string,
    string,
  ])[] = [
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
    ...columnTuples.map(
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
    docLookups.set(
      actorId,
      Array.isArray(rawDoc) ? rawDoc.map(String).sort() : [],
    );
    folderLookups.set(
      actorId,
      Array.isArray(rawFolder) ? rawFolder.map(String).sort() : [],
    );
  }
  return { checks: rawChecks.map(Boolean), docLookups, folderLookups };
}

describe("SQLite column-backed edge cases", () => {
  it("terminates on cyclic parent_id chains and matches Lean 4 across usersets, wildcards, and expiring tuples", async () => {
    const schema = buildMixedColumnModel();
    const bindings: readonly SqliteColumnRelationBinding[] = [
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
    const db = seedCyclicDb();
    const nowMs = 1_700_000_000_000;
    const authz = new SqliteAuthorization({
      model: schema.model,
      namespace: "ns-edge",
      executor: createNodeSqliteExecutor(db),
      now: () => new Date(nowMs),
      columnRelations: bindings,
    });

    const writes: readonly RelationshipWrite[] = [
      {
        resource: { type: "edge/group", id: "grp-inner" },
        relation: "member",
        subject: { type: "user", id: "alice" },
        expiresAt: new Date(nowMs + 3_600_000),
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
        expiresAt: new Date(nowMs + 3_600_000),
      },
      {
        resource: { type: "edge/org", id: "org-public" },
        relation: "member",
        subject: { type: "user", id: "*" },
        expiresAt: new Date(nowMs + 3_600_000),
      },
      {
        resource: { type: "edge/document", id: "doc-exp" },
        relation: "viewer",
        subject: { type: "user", id: "bob" },
        expiresAt: new Date(nowMs - 60_000),
      },
      {
        resource: { type: "edge/document", id: "doc-wild" },
        relation: "banned",
        subject: { type: "user", id: "bob" },
      },
    ];
    await authz.writeRelationships(writes);

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

    if (existsSync(ORACLE_BIN)) {
      const compiled = compileAccessPolicy(schema.model, bindings);
      const actors = ["alice", "bob", "carol", "nobody"];
      const docs = ["doc-cycle", "doc-exp", "doc-self", "doc-wild"];
      const folders = [
        "f-branch",
        "f-cycle-a",
        "f-cycle-b",
        "f-cycle-c",
        "f-open",
        "f-self",
      ];
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

      const oracle = runOracle(
        compiled.model,
        writes,
        nowMs,
        queries,
        actors,
        docs,
        folders,
      );
      expect(await authz.checkMany(queries)).toEqual(oracle.checks);
      for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        if (query === undefined) continue;
        expect(await authz.check(query)).toBe(oracle.checks[index]);
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

        const filter = authz.compileFilter({
          subject: { type: "user", id: actorId },
          permission: "view",
          resourceType: "edge/document",
          idColumn: "doc.id",
          scopeColumns: "auto",
        });
        const filteredIds = db
          .prepare(
            `SELECT doc.id FROM documents doc WHERE ${filter.sql} ORDER BY doc.id`,
          )
          .all(...filter.values)
          .map((row) => String(row["id"]));
        expect(filteredIds).toEqual(expectedDocs);
      }
    }
    db.close();
  });
});
