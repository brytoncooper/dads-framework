import {
  actor,
  anyOf,
  compileAccess,
  every,
  resource,
  roleToken,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAuthorization, relationshipSchemaMigration } from "./index.js";

const user = actor("user");
const groupMemberRef = roleToken("group", "member", user.handle);
const group = resource("group", {
  roles: { member: [user, groupMemberRef] },
  can: ({ member }) => ({ read: member }),
});
const workspace = resource("workspace", {
  roles: {
    member: [user.expiring, group.roles.member, user.anyone],
    banned: user,
  },
  can: ({ member, banned }) => ({
    view: member.unless(banned),
  }),
});
const folder = resource("folder", {
  parents: [workspace],
  recursive: true,
  roles: {
    viewer: [user.expiring, group.roles.member, user.anyone],
  },
  can: ({ parents, viewer }) => ({
    view: anyOf(viewer, parents.view),
  }),
});
const document = resource("document", {
  parents: [workspace, folder],
  roles: {
    viewer: [user.expiring, group.roles.member, user.anyone],
    banned: user,
  },
  can: ({ parents, viewer, banned }) => ({
    direct_view: viewer.unless(banned),
    view: anyOf(viewer, parents.view).unless(banned),
  }),
});
const strictDoc = resource("strict_doc", {
  parents: [workspace, folder],
  can: ({ parents }) => ({
    view: every(parents).view,
  }),
});

const model = compileAccess([
  user,
  group,
  workspace,
  folder,
  document,
  strictDoc,
]);

describe("PostgresAuthorization.compileFilter (live Postgres integration)", () => {
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;
  let auth: PostgresAuthorization;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    await postgres.pool.query(relationshipSchemaMigration.sql);
    await postgres.pool.query(`
      CREATE TABLE filter_documents (
        id text PRIMARY KEY,
        title text NOT NULL,
        tenant_active boolean NOT NULL
      );
      CREATE TABLE filter_strict_docs (
        id text PRIMARY KEY,
        title text NOT NULL,
        tenant_active boolean NOT NULL
      );
    `);
    auth = new PostgresAuthorization({
      model,
      namespace: "pg-compile-filter",
      executor: postgres.pool,
    });
  }, 90_000);

  afterAll(async () => {
    await postgres.stop();
  });

  async function listDocuments(
    tenantActive: boolean,
    subjectId: string,
    permission: string,
    limit = 2,
  ) {
    const filter = auth.compileFilter({
      subject: { type: "user", id: subjectId },
      permission,
      resourceType: "document",
      idColumn: "d.id",
      paramOffset: 2,
    });
    const result = await postgres.pool.query<{ id: string; title: string }>(
      `SELECT d.id, d.title FROM filter_documents d WHERE d.tenant_active = $1 AND (${filter.sql}) ORDER BY d.title LIMIT ${String(limit)}`,
      [tenantActive, ...filter.values],
    );
    return result.rows;
  }

  it("filters live rows with paramOffset, recursive folders, expiring grants, revocations, and throughAll", async () => {
    await postgres.pool.query(`
      INSERT INTO filter_documents (id, title, tenant_active) VALUES
        ('d-direct', 'Alpha Direct', true),
        ('d-ws', 'Bravo Workspace', true),
        ('d-deep', 'Charlie Deep Folder', true),
        ('d-cyc', 'Delta Cyclic Folder', true),
        ('d-exp-past', 'Echo Expired', true),
        ('d-exp-future', 'Foxtrot Active Exp', true),
        ('d-banned', 'Golf Banned', true),
        ('d-inactive', 'Hotel Inactive', false);
      INSERT INTO filter_strict_docs (id, title, tenant_active) VALUES
        ('s-none', 'Zero Parents', true),
        ('s-one', 'One Parent', true),
        ('s-two', 'Two Parents', true);
    `);

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 300_000);

    await auth.writeRelationships([
      relationshipWrite({ type: "group", id: "eng" }, "member", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "workspace", id: "ws1" }, "member", {
        type: "group",
        id: "eng",
        relation: "member",
      }),
      relationshipWrite({ type: "workspace", id: "ws1" }, "member", {
        type: "user",
        id: "bob",
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
      relationshipWrite({ type: "folder", id: "f-alice" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "folder", id: "cyc-a" }, "parent", {
        type: "folder",
        id: "cyc-b",
      }),
      relationshipWrite({ type: "folder", id: "cyc-b" }, "parent", {
        type: "folder",
        id: "cyc-a",
      }),
      relationshipWrite({ type: "folder", id: "cyc-a" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d-direct" }, "viewer", {
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
        id: "cyc-b",
      }),
      relationshipWrite(
        { type: "document", id: "d-exp-past" },
        "viewer",
        { type: "user", id: "alice" },
        { expiresAt: past },
      ),
      relationshipWrite(
        { type: "document", id: "d-exp-future" },
        "viewer",
        { type: "user", id: "alice" },
        { expiresAt: future },
      ),
      relationshipWrite({ type: "document", id: "d-banned" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "document", id: "d-banned" }, "banned", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "document", id: "d-inactive" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-one" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-two" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-two" }, "parent", {
        type: "folder",
        id: "f-alice",
      }),
    ]);

    // Acyclic direct_view with LIMIT 2
    expect(await listDocuments(true, "alice", "direct_view", 2)).toEqual([
      { id: "d-direct", title: "Alpha Direct" },
      { id: "d-exp-future", title: "Foxtrot Active Exp" },
    ]);

    // Recursive view with LIMIT 2
    expect(await listDocuments(true, "alice", "view", 2)).toEqual([
      { id: "d-direct", title: "Alpha Direct" },
      { id: "d-ws", title: "Bravo Workspace" },
    ]);

    // Full recursive view list (excludes past-expired, banned, and inactive)
    expect(await listDocuments(true, "alice", "view", 20)).toEqual([
      { id: "d-direct", title: "Alpha Direct" },
      { id: "d-ws", title: "Bravo Workspace" },
      { id: "d-deep", title: "Charlie Deep Folder" },
      { id: "d-cyc", title: "Delta Cyclic Folder" },
      { id: "d-exp-future", title: "Foxtrot Active Exp" },
    ]);

    // Revoking d-direct immediately updates single-query filter results
    await auth.deleteRelationships({
      resourceType: "document",
      resourceId: "d-direct",
      relation: "viewer",
      subject: { type: "user", id: "alice" },
    });
    expect(await listDocuments(true, "alice", "view", 2)).toEqual([
      { id: "d-ws", title: "Bravo Workspace" },
      { id: "d-deep", title: "Charlie Deep Folder" },
    ]);

    // every() / throughAll against strict_docs
    const aliceStrict = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "strict_doc",
      idColumn: "s.id",
      paramOffset: 2,
    });
    const aliceStrictRows = await postgres.pool.query<{ id: string }>(
      `SELECT s.id FROM filter_strict_docs s WHERE s.tenant_active = $1 AND (${aliceStrict.sql}) ORDER BY s.id`,
      [true, ...aliceStrict.values],
    );
    expect(aliceStrictRows.rows).toEqual([{ id: "s-one" }, { id: "s-two" }]);

    const bobStrict = auth.compileFilter({
      subject: { type: "user", id: "bob" },
      permission: "view",
      resourceType: "strict_doc",
      idColumn: "s.id",
      paramOffset: 2,
    });
    const bobStrictRows = await postgres.pool.query<{ id: string }>(
      `SELECT s.id FROM filter_strict_docs s WHERE s.tenant_active = $1 AND (${bobStrict.sql}) ORDER BY s.id`,
      [true, ...bobStrict.values],
    );
    expect(bobStrictRows.rows).toEqual([{ id: "s-one" }]);

    // Unknown permission fails closed in live Postgres
    expect(await listDocuments(true, "alice", "nonexistent", 10)).toEqual([]);
  });
});
