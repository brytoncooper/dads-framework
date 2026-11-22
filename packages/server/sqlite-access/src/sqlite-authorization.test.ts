import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  access,
  accessModel,
  entityHandle,
  membersOf,
  through,
  wildcard,
  withExpiration,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";

import {
  createNodeSqliteExecutor,
  SQLITE_RELATIONSHIP_TABLE,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
  withProtectedSqliteTransaction,
} from "./index.js";

const user = entityHandle({ wireName: "user", idSchema: z.string() });
const group = entityHandle({ wireName: "group", idSchema: z.string() });
const workspace = entityHandle({
  wireName: "workspace",
  idSchema: z.string(),
  kind: "scope",
});
const doc = entityHandle({ wireName: "doc", idSchema: z.string() });

const userAccess = access(user, { roles: {}, permissions: () => ({}) });
const groupAccess = access(group, {
  roles: {
    member: [user, wildcard(user)],
  },
  permissions: (roles) => ({
    read: [roles.member],
  }),
});
const nestedGroupAccess = access(group, {
  roles: {
    member: [user, wildcard(user), membersOf(groupAccess.roles.member)],
  },
  permissions: (roles) => ({
    read: [roles.member],
  }),
});
const workspaceAccess = access(workspace, {
  roles: {
    owner: user,
    member: [
      withExpiration(user),
      membersOf(nestedGroupAccess.roles.member),
      wildcard(user),
    ],
  },
  permissions: (roles) => ({
    manage: [roles.owner],
    view: [roles.owner, roles.member],
  }),
});
const docAccess = access(doc, {
  roles: {
    parent: workspace,
    viewer: [user, wildcard(user), membersOf(nestedGroupAccess.roles.member)],
  },
  permissions: (roles) => ({
    view: [
      roles.viewer,
      through(roles.parent, workspaceAccess.permissions.view),
    ],
  }),
});

const coreModel = accessModel([
  userAccess,
  nestedGroupAccess,
  workspaceAccess,
  docAccess,
]);

function setupDatabase(options?: {
  readonly namespace?: string;
  readonly now?: () => Date;
}) {
  const db = new DatabaseSync(":memory:");
  const executor = createNodeSqliteExecutor(db);
  db.exec(sqliteRelationshipSchemaMigration.sql);
  const authz = new SqliteAuthorization({
    model: coreModel,
    namespace: options?.namespace ?? "test-ns",
    executor,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  return { db, executor, authz };
}

describe("SqliteAuthorization core behavior", () => {
  it("applies the schema migration idempotently and exposes metadata", () => {
    const db = new DatabaseSync(":memory:");
    expect(sqliteRelationshipSchemaMigration.adapter).toBe("sqlite-access");
    expect(sqliteRelationshipSchemaMigration.version).toBe(1);
    expect(sqliteRelationshipSchemaMigration.statements).toHaveLength(3);
    expect(sqliteRelationshipSchemaMigration.checksum).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const statement of sqliteRelationshipSchemaMigration.statements) {
      db.exec(statement);
    }
    db.exec(sqliteRelationshipSchemaMigration.sql);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .all(SQLITE_RELATIONSHIP_TABLE);
    expect(tables).toHaveLength(1);
  });

  it("validates namespace, invalid writes, and unknown permissions", async () => {
    const { executor, authz } = setupDatabase();
    expect(
      () =>
        new SqliteAuthorization({
          model: coreModel,
          namespace: "   ",
          executor,
        }),
    ).toThrow(/namespace is required/);

    await expect(
      authz.writeRelationships([
        relationshipWrite({ type: "doc", id: "d1" }, "unknown_role", {
          type: "user",
          id: "alice",
        }),
      ]),
    ).rejects.toThrow(/Invalid authorization relationship/);

    await expect(
      authz.writeRelationships([
        relationshipWrite({ type: "workspace", id: "w1" }, "owner", {
          type: "user",
          id: "*",
        }),
      ]),
    ).rejects.toThrow(/Invalid authorization relationship/);

    await expect(
      authz.writeRelationships([
        relationshipWrite({ type: "workspace", id: "" }, "owner", {
          type: "user",
          id: "alice",
        }),
      ]),
    ).rejects.toThrow(/requires resource and subject identifiers/);

    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "nonexistent",
        resource: { type: "doc", id: "d1" },
      }),
    ).toBe(false);
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "nonexistent",
        resourceType: "doc",
      }),
    ).toEqual([]);
    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d1" },
        permission: "nonexistent",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
  });

  it("handles grants, denials, revocations, namespaces, direct inspection, and filtered deletes", async () => {
    const { executor, authz } = setupDatabase({ namespace: "ns-a" });
    const otherNs = new SqliteAuthorization({
      model: coreModel,
      namespace: "ns-b",
      executor,
    });

    const w1 = { type: "workspace", id: "w1" };
    const alice = { type: "user", id: "alice" };
    const bob = { type: "user", id: "bob" };

    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(false);
    expect(
      await authz.relationshipExists({
        resourceType: "workspace",
        resourceId: "w1",
        relation: "member",
      }),
    ).toBe(false);

    await authz.writeRelationships([
      relationshipWrite(w1, "member", alice),
      relationshipWrite(w1, "member", bob),
      relationshipWrite(w1, "member", { type: "user", id: "*" }),
    ]);

    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(true);
    expect(
      await otherNs.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(false);
    expect(
      await authz.relationshipExists({
        resourceType: "workspace",
        resourceId: "w1",
        relation: "member",
      }),
    ).toBe(true);
    expect(
      await authz.listDirectSubjects({ resource: w1, relation: "member" }),
    ).toEqual([
      { type: "user", id: "*" },
      { type: "user", id: "alice" },
      { type: "user", id: "bob" },
    ]);

    // Delete only the wildcard tuple
    await authz.deleteRelationships({
      resourceType: "workspace",
      resourceId: "w1",
      relation: "member",
      subject: { type: "user", id: "*" },
    });
    expect(
      await authz.check({
        subject: { type: "user", id: "charlie" },
        permission: "view",
        resource: w1,
      }),
    ).toBe(false);
    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(true);

    // applyChanges removes exact tuple
    await authz.applyChanges([
      {
        operation: "DELETE",
        relationship: relationshipWrite(w1, "member", alice),
        idempotencyKey: "delete-alice-w1",
        ownerPartitionId: "workspace:w1",
      },
    ]);
    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(false);
    expect(
      await authz.check({ subject: bob, permission: "view", resource: w1 }),
    ).toBe(true);

    // Type-wide delete (id: "") clears remaining users on w1
    await authz.deleteRelationships({
      resourceType: "workspace",
      resourceId: "w1",
      subject: { type: "user", id: "" },
    });
    expect(
      await authz.relationshipExists({
        resourceType: "workspace",
        resourceId: "w1",
        relation: "member",
      }),
    ).toBe(false);
  });

  it("preserves ordering, duplicates, chunking, and per-item failures in checkMany and checkEach", async () => {
    const { authz } = setupDatabase();
    await authz.writeRelationships([
      relationshipWrite({ type: "doc", id: "d1" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "workspace", id: "w1" }, "owner", {
        type: "user",
        id: "bob",
      }),
    ]);

    const queries = Array.from({ length: 70 }, (_, idx) => ({
      subject: { type: "user", id: idx % 2 === 0 ? "alice" : "bob" },
      permission: idx % 3 === 0 ? "unknown" : "view",
      resource:
        idx % 2 === 0
          ? { type: "doc", id: "d1" }
          : { type: "workspace", id: "w1" },
    }));

    const batch = await authz.checkMany(queries);
    expect(batch).toHaveLength(70);
    for (let idx = 0; idx < 70; idx += 1) {
      expect(batch[idx]).toBe(idx % 3 !== 0);
    }

    const outcomes = await authz.checkEach([
      {
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "doc", id: "d1" },
      },
      {
        subject: { type: "user", id: "*" },
        permission: "view",
        resource: { type: "doc", id: "d1" },
      },
      {
        subject: { type: "user", id: "alice" },
        permission: "nope",
        resource: { type: "doc", id: "d1" },
      },
      {
        subject: { type: "user", id: "bob" },
        permission: "manage",
        resource: { type: "workspace", id: "w1" },
      },
    ]);

    expect(outcomes[0]).toEqual({ kind: "answered", allowed: true });
    expect(outcomes[1]?.kind).toBe("failed");
    expect(outcomes[2]).toEqual({ kind: "answered", allowed: false });
    expect(outcomes[3]).toEqual({ kind: "answered", allowed: true });
  });

  it("handles recursive multi-hop and cyclic subject sets plus wildcards cleanly", async () => {
    const { authz } = setupDatabase();
    await authz.writeRelationships([
      relationshipWrite({ type: "group", id: "g1" }, "member", {
        type: "group",
        id: "g2",
        relation: "member",
      }),
      relationshipWrite({ type: "group", id: "g2" }, "member", {
        type: "group",
        id: "g1",
        relation: "member",
      }),
      relationshipWrite({ type: "group", id: "g2" }, "member", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "doc", id: "d-cyclic" }, "viewer", {
        type: "group",
        id: "g1",
        relation: "member",
      }),
      relationshipWrite({ type: "group", id: "g-public" }, "member", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "doc", id: "d-public" }, "viewer", {
        type: "group",
        id: "g-public",
        relation: "member",
      }),
    ]);

    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "doc", id: "d-cyclic" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resource: { type: "doc", id: "d-cyclic" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resource: { type: "doc", id: "d-public" },
      }),
    ).toBe(true);

    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "doc",
      }),
    ).toEqual(["d-cyclic", "d-public"]);
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resourceType: "doc",
      }),
    ).toEqual(["d-public"]);

    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d-cyclic" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d-public" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: true });
  });

  it("commits and rolls back atomically in withProtectedSqliteTransaction and expires scoped handles", async () => {
    let clockMs = 1_000;
    const { db, executor, authz } = setupDatabase({
      now: () => new Date(clockMs),
    });
    db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

    let leakedAuth: SqliteAuthorization | undefined;
    let leakedExec: typeof executor | undefined;

    await withProtectedSqliteTransaction(
      { executor, authorization: authz },
      async ({ executor: txExec, authorization: txAuth }) => {
        leakedAuth = txAuth;
        leakedExec = txExec;
        await txExec.run("INSERT INTO items (id, name) VALUES (?, ?)", [
          "item-1",
          "Committed",
        ]);
        await txAuth.writeRelationships([
          relationshipWrite(
            { type: "workspace", id: "w1" },
            "member",
            { type: "user", id: "alice" },
            { expiresAt: new Date(1_500) },
          ),
        ]);
        // Advance external clock past expiresAt mid-transaction; pinned nowMs keeps tuple active!
        clockMs = 2_000;
        expect(
          await txAuth.check({
            subject: { type: "user", id: "alice" },
            permission: "view",
            resource: { type: "workspace", id: "w1" },
          }),
        ).toBe(true);
      },
    );

    expect(db.prepare("SELECT id FROM items").all()).toHaveLength(1);
    // Outside the transaction, clockMs is 2000 so tuple is expired
    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "workspace", id: "w1" },
      }),
    ).toBe(false);

    // Leaked scoped handles must reject after callback completes
    expect(leakedAuth).toBeDefined();
    expect(leakedExec).toBeDefined();
    if (leakedAuth !== undefined && leakedExec !== undefined) {
      await expect(
        leakedAuth.check({
          subject: { type: "user", id: "alice" },
          permission: "view",
          resource: { type: "workspace", id: "w1" },
        }),
      ).rejects.toThrow(/scope has ended/);
      await expect(leakedExec.all("SELECT 1")).rejects.toThrow(
        /scope has ended/,
      );
      await expect(
        withProtectedSqliteTransaction(
          { executor, authorization: leakedAuth },
          () => Promise.resolve("nope"),
        ),
      ).rejects.toThrow(/scope has ended/);
    }

    // Rollback atomicity: both business row and tuple roll back on error
    await expect(
      withProtectedSqliteTransaction(
        { executor, authorization: authz },
        async ({ executor: txExec, authorization: txAuth }) => {
          await txExec.run("INSERT INTO items (id, name) VALUES (?, ?)", [
            "item-2",
            "RolledBack",
          ]);
          await txAuth.writeRelationships([
            relationshipWrite({ type: "workspace", id: "w2" }, "owner", {
              type: "user",
              id: "bob",
            }),
          ]);
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(db.prepare("SELECT id FROM items").all()).toHaveLength(1);
    expect(
      await authz.check({
        subject: { type: "user", id: "bob" },
        permission: "manage",
        resource: { type: "workspace", id: "w2" },
      }),
    ).toBe(false);
  });
});
