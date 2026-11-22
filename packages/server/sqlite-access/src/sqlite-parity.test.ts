import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  actor,
  anyOf,
  compileAccess,
  permissionToken,
  resource,
  roleToken,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";

import {
  compileAccessPolicy,
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
} from "./index.js";

const user = actor("user");
const groupMemberRef = roleToken("group", "member", user.handle);
const group = resource("group", {
  roles: {
    member: [user.expiring, user.anyone, groupMemberRef],
  },
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
    viewer: [user.expiring, user.anyone],
    banned: [user, user.anyone],
  },
  can: ({ parents, viewer, banned }) => ({
    view: anyOf(viewer, parents.view).unless(banned),
  }),
});

const parityModel = compileAccess([user, group, workspace, folder, doc]);

function setupParity(initialTimeMs = 10_000) {
  let nowMs = initialTimeMs;
  const db = new DatabaseSync(":memory:");
  db.exec(sqliteRelationshipSchemaMigration.sql);
  const authz = new SqliteAuthorization({
    model: parityModel,
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

describe("SQLite SpiceDB parity: expiration, polymorphic arrows, and recursion", () => {
  it("Feature 1: enforces expiring relationships across all reads and supports touching expiresAt", async () => {
    const { authz, setNow } = setupParity(1_000);
    const w1 = { type: "workspace", id: "w1" };
    const alice = { type: "user", id: "alice" };

    await authz.writeRelationships([
      relationshipWrite(w1, "member", alice, { expiresAt: new Date(5_000) }),
    ]);

    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(true);
    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "workspace",
      }),
    ).toEqual(["w1"]);
    expect(
      await authz.lookupSubjects({
        resource: w1,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.listDirectSubjects({ resource: w1, relation: "member" }),
    ).toEqual([alice]);
    expect(
      await authz.relationshipExists({
        resourceType: "workspace",
        resourceId: "w1",
        relation: "member",
      }),
    ).toBe(true);

    setNow(5_000);
    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(false);
    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "workspace",
      }),
    ).toEqual([]);
    expect(
      await authz.lookupSubjects({
        resource: w1,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
    expect(
      await authz.listDirectSubjects({ resource: w1, relation: "member" }),
    ).toEqual([]);
    expect(
      await authz.relationshipExists({
        resourceType: "workspace",
        resourceId: "w1",
        relation: "member",
      }),
    ).toBe(false);

    // Touch extends expiration, then clears expiration permanently
    await authz.writeRelationships([
      relationshipWrite(w1, "member", alice, { expiresAt: new Date(8_000) }),
    ]);
    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(true);
    await authz.writeRelationships([relationshipWrite(w1, "member", alice)]);
    setNow(99_999);
    expect(
      await authz.check({ subject: alice, permission: "view", resource: w1 }),
    ).toBe(true);
  });

  it("Feature 1: denies downstream access when an intermediate group or parent link expires", async () => {
    const { authz, setNow } = setupParity(1_000);
    const alice = { type: "user", id: "alice" };
    const docRef = { type: "doc", id: "d-temp" };

    await authz.writeRelationships([
      relationshipWrite({ type: "group", id: "g-temp" }, "member", alice, {
        expiresAt: new Date(3_000),
      }),
      relationshipWrite({ type: "folder", id: "f-root" }, "viewer", {
        type: "group",
        id: "g-temp",
        relation: "member",
      }),
      relationshipWrite(
        docRef,
        "parent",
        { type: "folder", id: "f-root" },
        { expiresAt: new Date(6_000) },
      ),
    ]);

    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: docRef,
      }),
    ).toBe(true);
    setNow(3_000);
    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: docRef,
      }),
    ).toBe(false);
    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "doc",
      }),
    ).toEqual([]);
    expect(
      await authz.lookupSubjects({
        resource: docRef,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [], hasWildcard: false });
  });

  it("Feature 2: evaluates polymorphic arrows across workspace and folder parents", async () => {
    const { authz } = setupParity();
    const alice = { type: "user", id: "alice" };
    const bob = { type: "user", id: "bob" };
    const dWs = { type: "doc", id: "d-ws" };
    const dFolder = { type: "doc", id: "d-folder" };

    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws1" }, "owner", alice),
      relationshipWrite({ type: "folder", id: "f1" }, "viewer", bob),
      relationshipWrite(dWs, "parent", { type: "workspace", id: "ws1" }),
      relationshipWrite(dFolder, "parent", { type: "folder", id: "f1" }),
    ]);

    expect(
      await authz.check({ subject: alice, permission: "view", resource: dWs }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: dFolder,
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: dFolder,
      }),
    ).toBe(true);
    expect(
      await authz.check({ subject: bob, permission: "view", resource: dWs }),
    ).toBe(false);

    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "doc",
      }),
    ).toEqual(["d-ws"]);
    expect(
      await authz.lookupResources({
        subject: bob,
        permission: "view",
        resourceType: "doc",
      }),
    ).toEqual(["d-folder"]);

    expect(
      await authz.lookupSubjects({
        resource: dWs,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: dFolder,
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["bob"], hasWildcard: false });
  });

  it("Feature 3: traverses deep recursive folders, terminates on cycles, and respects intermediate bans", async () => {
    const { authz } = setupParity();
    const alice = { type: "user", id: "alice" };
    const bob = { type: "user", id: "bob" };

    await authz.writeRelationships([
      relationshipWrite({ type: "workspace", id: "ws-root" }, "owner", alice),
      relationshipWrite({ type: "workspace", id: "ws-root" }, "member", bob),
      relationshipWrite({ type: "folder", id: "f1" }, "parent", {
        type: "workspace",
        id: "ws-root",
      }),
      relationshipWrite({ type: "folder", id: "f2" }, "parent", {
        type: "folder",
        id: "f1",
      }),
      relationshipWrite({ type: "folder", id: "f3" }, "parent", {
        type: "folder",
        id: "f2",
      }),
      relationshipWrite({ type: "folder", id: "f4" }, "parent", {
        type: "folder",
        id: "f3",
      }),
      relationshipWrite({ type: "folder", id: "f5" }, "parent", {
        type: "folder",
        id: "f4",
      }),
      relationshipWrite({ type: "folder", id: "f6" }, "parent", {
        type: "folder",
        id: "f5",
      }),
      relationshipWrite({ type: "folder", id: "f3" }, "banned", bob),
      relationshipWrite({ type: "folder", id: "cycA" }, "parent", {
        type: "folder",
        id: "cycB",
      }),
      relationshipWrite({ type: "folder", id: "cycB" }, "parent", {
        type: "folder",
        id: "cycA",
      }),
      relationshipWrite({ type: "folder", id: "cycC" }, "parent", {
        type: "folder",
        id: "cycD",
      }),
      relationshipWrite({ type: "folder", id: "cycD" }, "parent", {
        type: "folder",
        id: "cycC",
      }),
      relationshipWrite({ type: "folder", id: "cycD" }, "viewer", alice),
    ]);

    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: { type: "folder", id: "f6" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "folder", id: "f2" },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "folder", id: "f3" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: bob,
        permission: "view",
        resource: { type: "folder", id: "f6" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: { type: "folder", id: "cycA" },
      }),
    ).toBe(false);
    expect(
      await authz.check({
        subject: alice,
        permission: "view",
        resource: { type: "folder", id: "cycC" },
      }),
    ).toBe(true);

    expect(
      await authz.lookupResources({
        subject: alice,
        permission: "view",
        resourceType: "folder",
      }),
    ).toEqual(["cycC", "cycD", "f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(
      await authz.lookupResources({
        subject: bob,
        permission: "view",
        resourceType: "folder",
      }),
    ).toEqual(["f1", "f2"]);

    expect(
      await authz.lookupSubjects({
        resource: { type: "folder", id: "f6" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
    expect(
      await authz.lookupSubjects({
        resource: { type: "folder", id: "cycC" },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: ["alice"], hasWildcard: false });
  });

  it("Feature 3 (compile-time): rejects local self-cycles and non-monotonic cycles", () => {
    const u = actor("user");

    const badExclude = resource("node", {
      recursive: true,
      roles: { viewer: u },
      can: ({ parent, viewer }) => ({
        view: viewer.unless({
          kind: "through",
          role: parent.$roleToken,
          target: permissionToken("node", "view"),
        }),
      }),
    });
    expect(() => compileAccessPolicy(compileAccess([u, badExclude]))).toThrow(
      /non-monotonic cycle through excluding/,
    );

    const badThroughAll = resource("node", {
      recursive: true,
      roles: { viewer: u },
      can: ({ parent, viewer }) => ({
        view: anyOf(viewer, {
          kind: "through-all",
          role: parent.$roleToken,
          target: permissionToken("node", "view"),
        }),
      }),
    });
    expect(() =>
      compileAccessPolicy(compileAccess([u, badThroughAll])),
    ).toThrow(/non-monotonic cycle/);

    const badLocal = resource("node", {
      roles: { viewer: u },
      can: () => ({
        a: [permissionToken("node", "b")],
        b: [permissionToken("node", "a")],
      }),
    });
    expect(() => compileAccessPolicy(compileAccess([u, badLocal]))).toThrow(
      /Cyclic permission reference/,
    );
  });
});
