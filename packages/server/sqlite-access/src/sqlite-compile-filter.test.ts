import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { actor, allOf, anyOf, compileAccess, every, resource, roleToken } from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";

import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
  type SqliteValue,
} from "./index.js";

const user = actor("user");
const groupMemberRef = roleToken("group", "member", user.handle);
const group = resource("group", {
  roles: { member: [user.expiring, user.anyone, groupMemberRef] },
  can: ({ member }) => ({ read: member }),
});
const workspace = resource("workspace", {
  roles: {
    owner: user.expiring,
    member: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    banned: [user, user.anyone],
  },
  can: ({ owner, member, banned }) => ({
    view: anyOf(owner, member).unless(banned),
  }),
});
const folder = resource("folder", {
  parents: [workspace],
  recursive: true,
  roles: {
    viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    banned: [user, user.anyone],
  },
  can: ({ parents, viewer, banned }) => ({
    view: anyOf(viewer, parents.view).unless(banned),
  }),
});
const document = resource("document", {
  parents: [workspace, folder],
  roles: {
    viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    approver: user,
    banned: [user, user.anyone],
  },
  can: ({ parents, viewer, approver, banned }) => ({
    view: anyOf(viewer, parents.view).unless(banned),
    direct_view: viewer.unless(banned),
    publish: allOf(viewer, approver).unless(banned),
  }),
});
const strictDoc = resource("strict_doc", {
  parents: [workspace, folder],
  can: ({ parents }) => ({
    view: every(parents).view,
  }),
});

const model = compileAccess([user, group, workspace, folder, document, strictDoc]);

function setupFilterDb(initialTimeMs = 10_000) {
  let nowMs = initialTimeMs;
  const db = new DatabaseSync(":memory:");
  db.exec(sqliteRelationshipSchemaMigration.sql);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE strict_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      active INTEGER NOT NULL
    );
  `);
  const executor = createNodeSqliteExecutor(db);
  const authz = new SqliteAuthorization({
    model,
    namespace: "filter-test",
    executor,
    now: () => new Date(nowMs),
  });
  return {
    db,
    authz,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    queryDocs: (active: number, sqlFilter: string, values: readonly SqliteValue[]) =>
      db
        .prepare(`SELECT d.id, d.title FROM documents d WHERE d.active = ? AND (${sqlFilter}) ORDER BY d.title LIMIT 2`)
        .all(active, ...values),
  };
}

describe("SqliteAuthorization.compileFilter", () => {
  it("filters rows in a single SQL query across direct grants, usersets, exclusions, intersections, and LIMIT", async () => {
    const { db, authz, queryDocs } = setupFilterDb();
    db.exec(`
      INSERT INTO documents (id, title, active) VALUES
        ('d1', 'Alpha', 1),
        ('d2', 'Bravo', 1),
        ('d3', 'Charlie', 1),
        ('d4', 'Delta', 1),
        ('d5', 'Echo', 0);
    `);
    await authz.writeRelationships([
      relationshipWrite({ type: "group", id: "eng" }, "member", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d1" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d2" }, "viewer", {
        type: "group",
        id: "eng",
        relation: "member",
      }),
      relationshipWrite({ type: "document", id: "d3" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d3" }, "banned", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d4" }, "viewer", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "document", id: "d5" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d2" }, "approver", {
        type: "user",
        id: "alice",
      }),
    ]);

    const directFilter = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(directFilter.sql).toContain("d.id IN (");
    expect(queryDocs(1, directFilter.sql, directFilter.values)).toEqual([
      { id: "d1", title: "Alpha" },
      { id: "d2", title: "Bravo" },
    ]);

    // Without LIMIT 2: d3 is banned, d5 is inactive, d4 is wildcard-visible
    const allAllowed = db
      .prepare(`SELECT d.id FROM documents d WHERE d.active = ? AND (${directFilter.sql}) ORDER BY d.title`)
      .all(1, ...directFilter.values);
    expect(allAllowed).toEqual([{ id: "d1" }, { id: "d2" }, { id: "d4" }]);

    // Intersection (allOf): only d2 has both viewer and approver
    const publishFilter = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "publish",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(queryDocs(1, publishFilter.sql, publishFilter.values)).toEqual([{ id: "d2", title: "Bravo" }]);
  });

  it("filters rows across workspace inheritance, nested recursive folders, and folder cycles", async () => {
    const { db, authz, queryDocs } = setupFilterDb();
    db.exec(`
      INSERT INTO documents (id, title, active) VALUES
        ('d-ws', 'Alpha WS', 1),
        ('d-deep', 'Bravo Deep', 1),
        ('d-cyc', 'Charlie Cyclic', 1),
        ('d-ban', 'Delta Banned', 1),
        ('d-none', 'Echo None', 1);
    `);

    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws1" }, "owner", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "folder", id: "f1" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "folder", id: "f2" }, "parent", {
        type: "folder",
        id: "f1",
      }),
      relationshipWrite({ type: "folder", id: "f3" }, "parent", {
        type: "folder",
        id: "f2",
      }),
      relationshipWrite({ type: "folder", id: "cyc1" }, "parent", {
        type: "folder",
        id: "cyc2",
      }),
      relationshipWrite({ type: "folder", id: "cyc2" }, "parent", {
        type: "folder",
        id: "cyc1",
      }),
      relationshipWrite({ type: "folder", id: "cyc2" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d-ws" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "document", id: "d-deep" }, "parent", {
        type: "folder",
        id: "f3",
      }),
      relationshipWrite({ type: "document", id: "d-cyc" }, "parent", {
        type: "folder",
        id: "cyc1",
      }),
      relationshipWrite({ type: "document", id: "d-ban" }, "parent", {
        type: "folder",
        id: "f3",
      }),
      relationshipWrite({ type: "document", id: "d-ban" }, "banned", {
        type: "user",
        id: "alice",
      }),
    ]);

    const filter = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(filter.sql).toContain("d.id IN (WITH RECURSIVE");
    expect(queryDocs(1, filter.sql, filter.values)).toEqual([
      { id: "d-ws", title: "Alpha WS" },
      { id: "d-deep", title: "Bravo Deep" },
    ]);

    const fullList = db
      .prepare(`SELECT d.id FROM documents d WHERE d.active = ? AND (${filter.sql}) ORDER BY d.title`)
      .all(1, ...filter.values);
    expect(fullList).toEqual([{ id: "d-ws" }, { id: "d-deep" }, { id: "d-cyc" }]);

    const strangerFilter = authz.compileFilter({
      subject: { type: "user", id: "stranger" },
      permission: "view",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(queryDocs(1, strangerFilter.sql, strangerFilter.values)).toEqual([]);
  });

  it("enforces expires_at via both default clock and explicit now override", async () => {
    const { db, authz, setNow, queryDocs } = setupFilterDb(1_000);
    db.exec(`
      INSERT INTO documents (id, title, active) VALUES
        ('d-exp', 'Expiring', 1),
        ('d-perm', 'Permanent', 1);
    `);

    await authz.writeRelationships([
      relationshipWrite(
        { type: "document", id: "d-exp" },
        "viewer",
        { type: "user", id: "alice" },
        { expiresAt: new Date(5_000) },
      ),
      relationshipWrite({ type: "document", id: "d-perm" }, "viewer", {
        type: "user",
        id: "alice",
      }),
    ]);

    const before = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(queryDocs(1, before.sql, before.values)).toEqual([
      { id: "d-exp", title: "Expiring" },
      { id: "d-perm", title: "Permanent" },
    ]);

    // Explicit `now` override past expiration excludes d-exp even while clock is at 1000
    const futureOverride = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
      now: new Date(5_000),
    });
    expect(queryDocs(1, futureOverride.sql, futureOverride.values)).toEqual([{ id: "d-perm", title: "Permanent" }]);

    setNow(6_000);
    const after = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(queryDocs(1, after.sql, after.values)).toEqual([{ id: "d-perm", title: "Permanent" }]);
  });

  it("enforces every() / throughAll non-vacuously inside compileFilter", async () => {
    const { db, authz } = setupFilterDb();
    db.exec(`
      INSERT INTO strict_docs (id, title, active) VALUES
        ('s-none', 'No Parents', 1),
        ('s-one', 'One Parent', 1),
        ('s-both', 'Two Parents', 1);
    `);

    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws1" }, "owner", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "workspace", id: "ws1" }, "member", {
        type: "user",
        id: "bob",
      }),
      relationshipWrite({ type: "folder", id: "f1" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-one" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-both" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-both" }, "parent", {
        type: "folder",
        id: "f1",
      }),
    ]);

    const aliceFilter = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "strict_doc",
      idColumn: "id",
    });
    expect(
      db
        .prepare(`SELECT id FROM strict_docs WHERE active = ? AND (${aliceFilter.sql}) ORDER BY id`)
        .all(1, ...aliceFilter.values),
    ).toEqual([{ id: "s-both" }, { id: "s-one" }]);

    const bobFilter = authz.compileFilter({
      subject: { type: "user", id: "bob" },
      permission: "view",
      resourceType: "strict_doc",
      idColumn: "id",
    });
    expect(
      db
        .prepare(`SELECT id FROM strict_docs WHERE active = ? AND (${bobFilter.sql}) ORDER BY id`)
        .all(1, ...bobFilter.values),
    ).toEqual([{ id: "s-one" }]);
  });

  it("fails closed on unknown permission or resourceType and rejects invalid idColumn or subjects", () => {
    const { db, authz, queryDocs } = setupFilterDb();
    db.exec(`INSERT INTO documents (id, title, active) VALUES ('d1', 'Alpha', 1);`);

    const unknownPerm = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "nonexistent",
      resourceType: "document",
      idColumn: "d.id",
    });
    expect(unknownPerm).toEqual({ sql: "0 = 1", values: [] });
    expect(queryDocs(1, unknownPerm.sql, unknownPerm.values)).toEqual([]);

    const unknownType = authz.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "nonexistent_entity",
      idColumn: "d.id",
    });
    expect(unknownType).toEqual({ sql: "0 = 1", values: [] });

    for (const badColumn of [
      "",
      "d.id; DROP TABLE documents",
      "d.id OR 1=1",
      "1abc",
      "a.b.c",
      '"d"."id"',
      " d.id ",
      "d.id::text",
    ]) {
      expect(() =>
        authz.compileFilter({
          subject: { type: "user", id: "alice" },
          permission: "nonexistent",
          resourceType: "document",
          idColumn: badColumn,
        }),
      ).toThrow(/Invalid SQLite filter idColumn/);
    }

    expect(() =>
      authz.compileFilter({
        subject: { type: "user", id: "*" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
      }),
    ).toThrow(/concrete subject/);

    expect(() =>
      authz.compileFilter({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
        now: new Date("invalid"),
      }),
    ).toThrow(/valid Date/);

    expect(() =>
      authz.compileFilter({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
        scopeColumns: { workspace: "d.ws_id OR 1=1" },
      }),
    ).toThrow(/Invalid SQLite filter scopeColumns/);
  });
});
