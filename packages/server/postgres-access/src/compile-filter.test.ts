import {
  actor,
  anyOf,
  compileAccess,
  every,
  resource,
  roleToken,
} from "@dads-framework/access";
import { describe, expect, it } from "vitest";

import { PostgresAuthorization, type PostgresAccessExecutor } from "./index.js";

const noopExecutor: PostgresAccessExecutor = {
  query() {
    return Promise.resolve({ rows: [], rowCount: 0 });
  },
};

function createTestAuthorization(): PostgresAuthorization {
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
    roles: { viewer: [user.expiring, group.roles.member] },
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
      strict_view: every(parents).view,
    }),
  });
  const model = compileAccess([user, group, workspace, folder, document]);
  return new PostgresAuthorization({
    model,
    namespace: "filter-unit",
    executor: noopExecutor,
  });
}

describe("PostgresAuthorization.compileFilter (unit)", () => {
  it("compiles acyclic rules to an actor-first semi-join with $1-based placeholders by default", () => {
    const auth = createTestAuthorization();
    const filter = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "documents.id",
    });

    expect(filter.sql.startsWith("(documents.id IN (")).toBe(true);
    expect(filter.sql).toContain("documents.id");
    expect(filter.sql).toContain("expires_at IS NULL OR");
    expect(filter.sql).toContain("$1");
    expect(filter.sql).toContain(`$${String(filter.values.length)}`);
    expect(filter.sql).not.toContain(`$${String(filter.values.length + 1)}`);
    expect(filter.values).toContain("filter-unit");
    expect(filter.values).toContain("alice");
  });

  it("shifts every $N placeholder cleanly when paramOffset is provided", () => {
    const auth = createTestAuthorization();
    const base = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
    });
    const shifted = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "direct_view",
      resourceType: "document",
      idColumn: "d.id",
      paramOffset: 4,
    });

    expect(shifted.values).toEqual(base.values);
    expect(shifted.sql).not.toMatch(/\$[123](?!\d)/);
    expect(shifted.sql).toContain("$4");
    expect(shifted.sql).toContain(`$${String(base.values.length + 3)}`);
    expect(shifted.sql).not.toContain(`$${String(base.values.length + 4)}`);
  });

  it("compiles recursive permissions to inline (idColumn IN (WITH RECURSIVE ...)) with paramOffset", () => {
    const auth = createTestAuthorization();

    const folderFilter = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "folder",
      idColumn: "f.id",
      paramOffset: 2,
    });
    expect(folderFilter.sql.startsWith("(f.id IN (WITH RECURSIVE ")).toBe(true);
    expect(folderFilter.sql).not.toMatch(/\$1(?!\d)/);
    expect(folderFilter.sql).toContain("$2");
    expect(folderFilter.sql).toContain("rec_allowed_");

    const docFilter = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: "document",
      idColumn: "documents.id",
      paramOffset: 3,
    });
    expect(docFilter.sql.startsWith("(documents.id IN (WITH RECURSIVE ")).toBe(
      true,
    );
    expect(docFilter.sql).not.toMatch(/\$[12](?!\d)/);
    expect(docFilter.sql).toContain("$3");
    expect(docFilter.sql).toContain("rec_allowed_");
  });

  it("returns fail-closed FALSE for unknown permissions or resource types", () => {
    const auth = createTestAuthorization();
    expect(
      auth.compileFilter({
        subject: { type: "user", id: "alice" },
        permission: "missing_perm",
        resourceType: "document",
        idColumn: "id",
      }),
    ).toEqual({ sql: "FALSE", values: [] });

    expect(
      auth.compileFilter({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "missing_entity",
        idColumn: "d.id",
        paramOffset: 5,
      }),
    ).toEqual({ sql: "FALSE", values: [] });
  });

  it("rejects SQL injection idColumns, invalid paramOffsets, and non-concrete subjects before fail-closed check", () => {
    const auth = createTestAuthorization();

    for (const badIdColumn of [
      "",
      "id; DROP TABLE documents",
      "d.id OR 1=1",
      "1id",
      "schema.table.id",
      '"d"."id"',
      "d.id::text",
      " id ",
    ]) {
      expect(() =>
        auth.compileFilter({
          subject: { type: "user", id: "alice" },
          permission: "unknown_perm",
          resourceType: "document",
          idColumn: badIdColumn,
        }),
      ).toThrow(/Invalid Postgres filter idColumn/);
    }

    for (const badOffset of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        auth.compileFilter({
          subject: { type: "user", id: "alice" },
          permission: "unknown_perm",
          resourceType: "document",
          idColumn: "d.id",
          paramOffset: badOffset,
        }),
      ).toThrow(/paramOffset must be a positive safe integer/);
    }

    expect(() =>
      auth.compileFilter({
        subject: { type: "user", id: "*" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
      }),
    ).toThrow(/concrete subject/);

    expect(() =>
      auth.compileFilter({
        subject: { type: "group", id: "eng", relation: "member" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
      }),
    ).toThrow(/concrete subject/);

    expect(() =>
      auth.compileFilter({
        subject: { type: "user", id: "alice" },
        permission: "view",
        resourceType: "document",
        idColumn: "d.id",
        scopeColumns: { workspace: "d.workspace_id; DROP TABLE docs" },
      }),
    ).toThrow(/Invalid Postgres filter scopeColumns/);
  });

  it("compiles scopeColumns directly against parent FK columns while preserving exclusions", () => {
    const user = actor("user");
    const workspace = resource("ws", {
      roles: { member: user },
      can: ({ member }) => ({ view: member }),
    });
    const doc = workspace.child("doc", {
      inherit: "all",
      roles: { viewer: user, banned: user },
      can: ({ viewer, banned, parent }) => ({
        view: anyOf(parent.view, viewer).unless(banned),
      }),
    });
    const auth = new PostgresAuthorization({
      model: compileAccess([workspace, doc]),
      namespace: "scoped-unit",
      executor: noopExecutor,
    });
    const filter = auth.compileFilter({
      subject: { type: "user", id: "alice" },
      permission: "view",
      resourceType: doc.wireName,
      idColumn: "d.id",
      scopeColumns: { ws: "d.workspace_id" },
    });
    expect(filter.sql).toContain("d.workspace_id IN (");
    expect(filter.sql).toContain("d.id IN (");
    expect(filter.sql).toContain("d.id NOT IN (");
  });
});
