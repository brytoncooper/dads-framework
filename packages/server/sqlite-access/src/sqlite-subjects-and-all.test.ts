import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  actor,
  allOf,
  anyOf,
  compileAccess,
  every,
  permissionToken,
  resource,
  type AnyDslResource,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";

import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
  type SqliteValue,
} from "./index.js";

const user = actor("user");
const group = resource("group", {
  roles: { member: [user.expiring, user.anyone] },
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
const doc = resource("doc", {
  parents: [workspace, folder],
  roles: {
    viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
    required_clearance: [user, user.anyone],
    banned: [user, user.anyone],
  },
  can: ({ parents, viewer, required_clearance, banned }) => ({
    view: anyOf(viewer, parents.view).unless(banned),
    restricted: allOf(viewer, required_clearance),
  }),
});
const strictDoc = resource("strict_doc", {
  parents: [workspace, folder],
  can: ({ parents }) => ({
    view: every(parents).view,
  }),
});

const model = compileAccess([user, group, workspace, folder, doc, strictDoc]);

function setupDb(initialTimeMs = 1_000) {
  let nowMs = initialTimeMs;
  const db = new DatabaseSync(":memory:");
  db.exec(sqliteRelationshipSchemaMigration.sql);
  const authz = new SqliteAuthorization({
    model,
    namespace: "parity",
    executor: createNodeSqliteExecutor(db),
    now: () => new Date(nowMs),
  });
  return {
    authz,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe("SQLite SpiceDB parity: lookupSubjects, throughAll, and mutual recursion", () => {
  it("Feature 4: computes transitive lookupSubjects across groups, folders, exclusions, intersections, and wildcards", async () => {
    const { authz } = setupDb();
    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws1" }, "owner", {
        type: "user",
        id: "owner-1",
      }),
      relationshipWrite({ type: "group", id: "eng" }, "member", {
        type: "user",
        id: "grp-1",
      }),
      relationshipWrite({ type: "group", id: "eng" }, "member", {
        type: "user",
        id: "banned-1",
      }),
      relationshipWrite({ type: "folder", id: "f1" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "folder", id: "f1" }, "viewer", {
        type: "group",
        id: "eng",
        relation: "member",
      }),
      relationshipWrite({ type: "doc", id: "d1" }, "parent", {
        type: "folder",
        id: "f1",
      }),
      relationshipWrite({ type: "doc", id: "d1" }, "viewer", {
        type: "user",
        id: "direct-1",
      }),
      relationshipWrite({ type: "doc", id: "d1" }, "banned", {
        type: "user",
        id: "banned-1",
      }),
      relationshipWrite({ type: "doc", id: "d2" }, "viewer", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "doc", id: "d2" }, "required_clearance", {
        type: "user",
        id: "cleared-1",
      }),
      relationshipWrite({ type: "doc", id: "d3" }, "viewer", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "doc", id: "d3" }, "banned", {
        type: "user",
        id: "*",
      }),
    ]);

    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d1" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({
      subjects: ["direct-1", "grp-1", "owner-1"],
      hasWildcard: false,
    });

    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d2" },
        permission: "restricted",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["cleared-1"], hasWildcard: false });

    expect(
      await authz.lookupSubjects({
        resource: { type: "doc", id: "d3" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
  });

  it("Feature 5: enforces intersection arrows (throughAll / .all()) across check, lookupResources, and lookupSubjects", async () => {
    const { authz, setNow } = setupDb(1_000);
    const alice = { type: "user", id: "alice" };
    const bob = { type: "user", id: "bob" };

    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws1" }, "owner", alice),
      relationshipWrite({ type: "workspace", id: "ws1" }, "member", bob),
      relationshipWrite({ type: "folder", id: "f1" }, "viewer", alice),
      relationshipWrite({ type: "folder", id: "f-wild" }, "viewer", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "workspace", id: "ws-wild" }, "member", {
        type: "user",
        id: "*",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-two" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-two" }, "parent", {
        type: "folder",
        id: "f1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-mixed-wild" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-mixed-wild" }, "parent", {
        type: "folder",
        id: "f-wild",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-all-wild" }, "parent", {
        type: "workspace",
        id: "ws-wild",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-all-wild" }, "parent", {
        type: "folder",
        id: "f-wild",
      }),
      relationshipWrite({ type: "strict_doc", id: "s-exp" }, "parent", {
        type: "workspace",
        id: "ws1",
      }),
      relationshipWrite(
        { type: "strict_doc", id: "s-exp" },
        "parent",
        { type: "folder", id: "f1" },
        { expiresAt: new Date(5_000) },
      ),
    ]);

    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: { type: "strict_doc", id: "s-zero" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: { type: "strict_doc", id: "s-two" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "strict_doc", id: "s-two" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "strict_doc", id: "s-mixed-wild" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resource: { type: "strict_doc", id: "s-mixed-wild" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: { type: "user", id: "stranger" },
        permission: "view",
        resource: { type: "strict_doc", id: "s-all-wild" },
      }),
    ).toBe(true);

    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "strict_doc",
      }),
    ).toEqual(["s-all-wild", "s-exp", "s-mixed-wild", "s-two"]);
    expect(
      await authz.lookupResources({
        subject: bob,
        permission: "view",
        resourceType: "strict_doc",
      }),
    ).toEqual(["s-all-wild", "s-mixed-wild"]);

    expect(
      await authz.lookupSubjects({
        resource: { type: "strict_doc", id: "s-zero" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "strict_doc", id: "s-two" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "strict_doc", id: "s-mixed-wild" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice", "bob"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "strict_doc", id: "s-all-wild" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: true });

    // Once blocking parent f1 link expires at 5000, bob passes s-exp!
    setNow(5_000);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "strict_doc", id: "s-exp" },
      }),
    ).toBe(true);
    expect(
      await authz.lookupResources({
        subject: bob,
        permission: "view",
        resourceType: "strict_doc",
      }),
    ).toEqual(["s-all-wild", "s-exp", "s-mixed-wild"]);
  });

  it("evaluates mutually recursive multi-entity SCCs and async SqliteExecutor adapters", async () => {
    const u = actor("user");
    const cabinet: AnyDslResource = resource("cabinet", {
      roles: { parent: (): AnyDslResource => drawer, viewer: u },
      can: ({ parent, viewer }) => ({
        view: anyOf(viewer, {
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken("drawer", "view"),
        }),
      }),
    });
    const drawer = resource("drawer", {
      roles: { parent: cabinet, viewer: u },
      can: ({ parent, viewer }) => ({
        view: anyOf(viewer, {
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken("cabinet", "view"),
        }),
      }),
    });
    const mutualModel = compileAccess([u, cabinet, drawer]);

    const db = new DatabaseSync(":memory:");
    db.exec(sqliteRelationshipSchemaMigration.sql);
    const syncExec = createNodeSqliteExecutor(db);
    const asyncExec = {
      all: (sql: string, params?: readonly SqliteValue[]) =>
        Promise.resolve(syncExec.all(sql, params)),
      run: (sql: string, params?: readonly SqliteValue[]) =>
        Promise.resolve(syncExec.run(sql, params)),
      exec: (sql: string) => Promise.resolve(syncExec.exec(sql)),
    };
    const authz = new SqliteAuthorization({
      model: mutualModel,
      namespace: "mutual",
      executor: asyncExec,
    });

    await authz.writeRelationships([
      relationshipWrite({ type: "cabinet", id: "c1" }, "viewer", {
        type: "user",
        id: "alice",
      }),
      relationshipWrite({ type: "drawer", id: "dr1" }, "parent", {
        type: "cabinet",
        id: "c1",
      }),
      relationshipWrite({ type: "cabinet", id: "c2" }, "parent", {
        type: "drawer",
        id: "dr1",
      }),
      relationshipWrite({ type: "cabinet", id: "c1" }, "parent", {
        type: "drawer",
        id: "dr1",
      }),
    ]);

    expect(
      await authz.check({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resource: { type: "cabinet", id: "c2" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "bob" },
        permission: "view",
        resource: { type: "cabinet", id: "c2" },
      }),
    ).toBe(false);
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "cabinet",
      }),
    ).toEqual(["c1", "c2"]);
    expect(
      await authz.lookupResources({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "drawer",
      }),
    ).toEqual(["dr1"]);
    expect(
      await authz.lookupSubjects({
        resource: { type: "cabinet", id: "c2" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
  });
});
