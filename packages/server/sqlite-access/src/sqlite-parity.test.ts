import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  access,
  accessModel,
  entityHandle,
  excluding,
  membersOf,
  through,
  throughAll,
  wildcard,
  withExpiration,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";

import {
  compileAccessPolicy,
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
} from "./index.js";

const user = entityHandle({ wireName: "user", idSchema: z.string() });
const group = entityHandle({ wireName: "group", idSchema: z.string() });
const workspace = entityHandle({
  wireName: "workspace",
  idSchema: z.string(),
  kind: "scope",
});
const folder = entityHandle({ wireName: "folder", idSchema: z.string() });
const doc = entityHandle({ wireName: "doc", idSchema: z.string() });

const userAccess = access(user, { roles: {}, permissions: () => ({}) });
const groupBase = access(group, {
  roles: { member: [withExpiration(user), wildcard(user)] },
  permissions: (roles) => ({ read: [roles.member] }),
});
const groupAccess = access(group, {
  roles: {
    member: [
      withExpiration(user),
      wildcard(user),
      withExpiration(membersOf(groupBase.roles.member)),
    ],
  },
  permissions: (roles) => ({ read: [roles.member] }),
});
const workspaceAccess = access(workspace, {
  roles: {
    owner: withExpiration(user),
    member: [
      withExpiration(user),
      withExpiration(membersOf(groupAccess.roles.member)),
      withExpiration(wildcard(user)),
    ],
    banned: [user, wildcard(user)],
  },
  permissions: (roles) => ({
    view: [excluding([roles.owner, roles.member], roles.banned)],
  }),
});
const folderAccess = access(folder, {
  roles: {
    parent: [withExpiration(folder), withExpiration(workspace)],
    viewer: [
      withExpiration(user),
      withExpiration(membersOf(groupAccess.roles.member)),
      withExpiration(wildcard(user)),
    ],
    banned: [user, wildcard(user)],
  },
  permissions: (roles) => ({
    view: [
      excluding(
        [
          roles.viewer,
          through(roles.parent, {
            kind: "permission",
            entityWireName: "folder",
            permissionName: "view",
          }),
        ],
        roles.banned,
      ),
    ],
  }),
});
const docAccess = access(doc, {
  roles: {
    parent: [withExpiration(workspace), withExpiration(folder)],
    viewer: [withExpiration(user), wildcard(user)],
    banned: [user, wildcard(user)],
  },
  permissions: (roles) => ({
    view: [
      excluding(
        [roles.viewer, through(roles.parent, workspaceAccess.permissions.view)],
        roles.banned,
      ),
    ],
  }),
});

const parityModel = accessModel([
  userAccess,
  groupAccess,
  workspaceAccess,
  folderAccess,
  docAccess,
]);

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
    const node = entityHandle({ wireName: "node", idSchema: z.string() });
    const u = entityHandle({ wireName: "user", idSchema: z.string() });
    const uAccess = access(u, { roles: {}, permissions: () => ({}) });

    const badExclude = access(node, {
      roles: { parent: node, viewer: u },
      permissions: (roles) => ({
        view: [
          excluding(
            roles.viewer,
            through(roles.parent, {
              kind: "permission",
              entityWireName: "node",
              permissionName: "view",
            }),
          ),
        ],
      }),
    });
    expect(() =>
      compileAccessPolicy(accessModel([uAccess, badExclude])),
    ).toThrow(/non-monotonic cycle through excluding/);

    const badThroughAll = access(node, {
      roles: { parent: node, viewer: u },
      permissions: (roles) => ({
        view: [
          roles.viewer,
          throughAll(roles.parent, {
            kind: "permission",
            entityWireName: "node",
            permissionName: "view",
          }),
        ],
      }),
    });
    expect(() =>
      compileAccessPolicy(accessModel([uAccess, badThroughAll])),
    ).toThrow(/non-monotonic cycle/);

    const badLocal = access(node, {
      roles: { viewer: u },
      permissions: () => ({
        a: [
          { kind: "permission", entityWireName: "node", permissionName: "b" },
        ],
        b: [
          { kind: "permission", entityWireName: "node", permissionName: "a" },
        ],
      }),
    });
    expect(() => compileAccessPolicy(accessModel([uAccess, badLocal]))).toThrow(
      /Cyclic permission reference/,
    );
  });
});
