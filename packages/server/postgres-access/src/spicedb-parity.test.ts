import {
  access,
  accessModel,
  both,
  entityHandle,
  excluding,
  membersOf,
  permissionToken,
  roleToken,
  through,
  throughAll,
  wildcard,
  withExpiration,
} from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileAccessPolicy } from "./compile-access-policy.js";
import {
  PostgresAuthorization,
  relationshipExpirationMigration,
  relationshipSchemaMigration,
  type PostgresAccessExecutor,
} from "./index.js";
import { compileLinearCheck } from "./policy/compile-linear-check.js";
import {
  compilePostgresCheck,
  compilePostgresCheckMany,
  compilePostgresLookup,
} from "./policy/compile-postgres-policy.js";
import { compileSharedPointCheck } from "./policy/compile-shared-point-check.js";
import { compilePostgresSubjectLookup } from "./policy/compile-subject-lookup.js";
import type { PostgresQuery, PostgresRow } from "./postgres-types.js";

function createRecordingExecutor(rows: readonly PostgresRow[] = []): {
  readonly queries: PostgresQuery[];
  readonly executor: PostgresAccessExecutor;
} {
  const queries: PostgresQuery[] = [];
  return {
    queries,
    executor: {
      query(query) {
        queries.push(query);
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    },
  };
}

function buildParityModel() {
  const user = entityHandle({ wireName: "user", idSchema: z.string() });
  const group = entityHandle({ wireName: "group", idSchema: z.string() });
  const workspace = entityHandle({
    wireName: "workspace",
    idSchema: z.string(),
  });
  const folder = entityHandle({ wireName: "folder", idSchema: z.string() });
  const document = entityHandle({ wireName: "document", idSchema: z.string() });

  const userAccess = access(user, { roles: {}, permissions: () => ({}) });
  const groupMemberRef = roleToken(group.wireName, "member", user);
  const groupAccess = access(group, {
    roles: { member: [user, membersOf(groupMemberRef)] },
    permissions: ({ member }) => ({ view: [member] }),
  });
  const workspaceAccess = access(workspace, {
    roles: {
      member: [
        withExpiration(user),
        membersOf(groupAccess.roles.member),
        wildcard(user),
      ],
      billing_admin: user,
    },
    permissions: ({ member, billing_admin }) => ({
      view: [member],
      manage_billing: [billing_admin],
    }),
  });
  const folderAccess = access(folder, {
    roles: {
      parent: [workspace, folder],
      viewer: [
        withExpiration(user),
        membersOf(groupAccess.roles.member),
        wildcard(user),
      ],
    },
    permissions: ({ parent, viewer }) => ({
      view: [viewer, through(parent, permissionToken(folder.wireName, "view"))],
    }),
  });
  const documentAccess = access(document, {
    roles: {
      parent: [workspace, folder],
      viewer: [withExpiration(user), wildcard(user)],
      approver: user,
      banned: user,
    },
    permissions: ({ parent, viewer, approver, banned }) => ({
      view: [
        excluding(viewer, banned),
        through(parent, workspaceAccess.permissions.view),
      ],
      billing: [through(parent, workspaceAccess.permissions.manage_billing)],
      strict_view: [throughAll(parent, workspaceAccess.permissions.view)],
      approved_view: [both(viewer, approver)],
    }),
  });

  return accessModel([
    userAccess,
    groupAccess,
    workspaceAccess,
    folderAccess,
    documentAccess,
  ]);
}

describe("expiring relationships (expires_at)", () => {
  it("defines expires_at column and partial index in v1 and additive v2 migrations", () => {
    expect(relationshipSchemaMigration.sql).toContain(
      "expires_at timestamptz NULL",
    );
    expect(relationshipSchemaMigration.sql).toContain(
      "CREATE INDEX IF NOT EXISTS dad_authorization_relationship_expires_at",
    );
    expect(relationshipSchemaMigration.sql).toContain(
      "WHERE expires_at IS NOT NULL",
    );

    expect(relationshipExpirationMigration.version).toBe(2);
    expect(relationshipExpirationMigration.sql).toContain(
      "ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL",
    );
    expect(relationshipExpirationMigration.sql).toContain(
      "CREATE INDEX IF NOT EXISTS dad_authorization_relationship_expires_at",
    );
    expect(relationshipExpirationMigration.sql).toContain(
      "WHERE expires_at IS NOT NULL",
    );
  });

  it("upserts expires_at on writeRelationships and filters expiration on direct reads", async () => {
    const model = buildParityModel();
    const { queries, executor } = createRecordingExecutor([]);
    const authorization = new PostgresAuthorization({
      model,
      namespace: "ns-exp",
      executor,
    });
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    const later = new Date("2031-01-01T00:00:00.000Z");

    await authorization.writeRelationships([
      relationshipWrite(
        { type: "workspace", id: "ws-1" },
        "member",
        { type: "user", id: "alice" },
        { expiresAt },
      ),
      relationshipWrite(
        { type: "workspace", id: "ws-1" },
        "member",
        { type: "user", id: "alice" },
        { expiresAt: later },
      ),
      relationshipWrite({ type: "workspace", id: "ws-1" }, "member", {
        type: "user",
        id: "bob",
      }),
    ]);

    const writeQuery = queries[0];
    expect(writeQuery?.text).toContain("expires_at");
    expect(writeQuery?.text).toContain("$9::timestamptz[]");
    expect(writeQuery?.text).toContain(
      "DO UPDATE SET expires_at = EXCLUDED.expires_at",
    );
    expect(writeQuery?.values?.[8]).toEqual([later, null]);

    await expect(
      authorization.writeRelationships([
        relationshipWrite(
          { type: "workspace", id: "ws-1" },
          "member",
          { type: "user", id: "alice" },
          { expiresAt: new Date("invalid") },
        ),
      ]),
    ).rejects.toThrow(/valid Date/);

    await authorization.relationshipExists({
      resourceType: "workspace",
      resourceId: "ws-1",
      relation: "member",
    });
    expect(queries[1]?.text).toContain(
      "(expires_at IS NULL OR expires_at > now())",
    );

    await authorization.listDirectSubjects({
      resource: { type: "workspace", id: "ws-1" },
      relation: "member",
    });
    expect(queries[2]?.text).toContain(
      "(expires_at IS NULL OR expires_at > now())",
    );
  });

  it("enforces expires_at predicate across linear, point, batch, reverse, shared, and subject SQL", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const l1 = entityHandle({ wireName: "l1", idSchema: z.string() });
    const l2 = entityHandle({ wireName: "l2", idSchema: z.string() });
    const l3 = entityHandle({ wireName: "l3", idSchema: z.string() });
    const l4 = entityHandle({ wireName: "l4", idSchema: z.string() });
    const l5 = entityHandle({ wireName: "l5", idSchema: z.string() });
    const l1Access = access(l1, {
      roles: { member: user },
      permissions: ({ member }) => ({ view: [member] }),
    });
    const l2Access = access(l2, {
      roles: { p: l1 },
      permissions: ({ p }) => ({
        view: [through(p, l1Access.permissions.view)],
      }),
    });
    const l3Access = access(l3, {
      roles: { p: l2 },
      permissions: ({ p }) => ({
        view: [through(p, l2Access.permissions.view)],
      }),
    });
    const l4Access = access(l4, {
      roles: { p: l3 },
      permissions: ({ p }) => ({
        view: [through(p, l3Access.permissions.view)],
      }),
    });
    const l5Access = access(l5, {
      roles: { p: l4 },
      permissions: ({ p }) => ({
        view: [through(p, l4Access.permissions.view)],
      }),
    });
    const linearModel = compileAccessPolicy(
      accessModel([
        access(user, { roles: {}, permissions: () => ({}) }),
        l1Access,
        l2Access,
        l3Access,
        l4Access,
        l5Access,
      ]),
    ).model;

    const linear = compileLinearCheck(linearModel, "ns", {
      subject: { type: "user", id: "u1" },
      resource: { type: "l5", id: "r5" },
      permission: "view",
    });
    expect(linear).toBeDefined();
    expect(
      linear?.text.match(/expires_at IS NULL OR tuple\.expires_at > now\(\)/g)
        ?.length,
    ).toBe(2);

    const check = compilePostgresCheck(linearModel, "ns", {
      subject: { type: "user", id: "u1" },
      resource: { type: "l2", id: "r2" },
      permission: "view",
    });
    expect(check.text).toContain("expires_at IS NULL OR");
    expect(check.text).toContain("expires_at > now()");

    const lookup = compilePostgresLookup(linearModel, "ns", {
      subject: { type: "user", id: "u1" },
      resourceType: "l2",
      permission: "view",
    });
    expect(lookup.text).toContain(
      "direct_tuple.expires_at IS NULL OR direct_tuple.expires_at > now()",
    );
    expect(lookup.text).toContain(
      "through_tuple_0.expires_at IS NULL OR through_tuple_0.expires_at > now()",
    );
  });
});

describe("polymorphic arrows and through-all", () => {
  it("compiles polymorphic arrows across forward check, lookup, shared check, and subject lookup", () => {
    const compiled = compileAccessPolicy(buildParityModel());
    const check = compilePostgresCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "document", id: "doc-1" },
      permission: "view",
    });
    expect(check.text).toContain("subject_kind =");
    expect(check.values).toContain("workspace");
    expect(check.values).toContain("folder");

    const billingCheck = compilePostgresCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "document", id: "doc-1" },
      permission: "billing",
    });
    expect(billingCheck.values).toContain("workspace");
    expect(billingCheck.values).not.toContain("folder");
    expect(
      compileLinearCheck(compiled.model, "ns", {
        subject: { type: "user", id: "alice" },
        resource: { type: "document", id: "doc-1" },
        permission: "billing",
      }),
    ).toBeUndefined();

    const lookup = compilePostgresLookup(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resourceType: "document",
      permission: "view",
    });
    expect(lookup.text).toContain("UNION");
    expect(lookup.values).toContain("workspace");
    expect(lookup.values).toContain("folder");

    const shared = compileSharedPointCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "document", id: "doc-1" },
      permission: "view",
    });
    expect(shared.text).toContain("WITH RECURSIVE subject_reachable");
    expect(shared.values).toContain("workspace");
    expect(shared.values).toContain("folder");
  });

  it("compiles non-vacuous through-all SQL across check, checkMany, lookup, shared check, and subject lookup", () => {
    const compiled = compileAccessPolicy(buildParityModel());
    const check = compilePostgresCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "document", id: "doc-1" },
      permission: "strict_view",
    });
    expect(check.text).toContain(
      "EXISTS (SELECT 1 FROM dad_authorization_relationship",
    );
    expect(check.text).toContain(
      "AND NOT EXISTS (SELECT 1 FROM dad_authorization_relationship",
    );
    expect(check.text).toContain("AND NOT (");

    const batch = compilePostgresCheckMany(compiled.model, "ns", [
      {
        subject: { type: "user", id: "alice" },
        resource: { type: "document", id: "doc-1" },
        permission: "strict_view",
      },
    ]);
    expect(batch.text).toContain("AND NOT EXISTS");

    const lookup = compilePostgresLookup(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resourceType: "document",
      permission: "strict_view",
    });
    expect(lookup.text).toContain("WHERE NOT EXISTS");
    expect(lookup.text).toContain("AND NOT (");

    const shared = compileSharedPointCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "document", id: "doc-1" },
      permission: "strict_view",
    });
    expect(shared.text).toContain("WHERE NOT EXISTS");

    const subjects = compilePostgresSubjectLookup(compiled.model, "ns", {
      resource: { type: "document", id: "doc-1" },
      permission: "strict_view",
      subjectType: "user",
    });
    expect(subjects.text).toContain("WHERE EXISTS (SELECT 1 FROM all_parents_");
    expect(subjects.text).toContain("AND NOT EXISTS");
  });
});

describe("recursive arrows (nested folders & mutual recursion)", () => {
  it("compiles polymorphic self-referential folder hierarchy across all query modes", () => {
    const compiled = compileAccessPolicy(buildParityModel());
    const check = compilePostgresCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "folder", id: "f-leaf" },
      permission: "view",
    });
    expect(check.canPrepare).toBe(false);
    expect(check.text).toContain("WITH RECURSIVE rec_walk_");
    expect(check.text).toContain("UNION");
    expect(check.values).toContain("workspace");
    expect(check.values).toContain("folder");

    expect(
      compileLinearCheck(compiled.model, "ns", {
        subject: { type: "user", id: "alice" },
        resource: { type: "folder", id: "f-leaf" },
        permission: "view",
      }),
    ).toBeUndefined();

    const batch = compilePostgresCheckMany(compiled.model, "ns", [
      {
        subject: { type: "user", id: "alice" },
        resource: { type: "folder", id: "f-leaf" },
        permission: "view",
      },
    ]);
    expect(batch.text).toContain("WITH RECURSIVE rec_walk_");

    const lookup = compilePostgresLookup(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resourceType: "folder",
      permission: "view",
    });
    expect(lookup.text).toContain("WITH RECURSIVE rec_allowed_");
    expect(lookup.text).toContain("UNION");

    const shared = compileSharedPointCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "folder", id: "f-leaf" },
      permission: "view",
    });
    expect(shared.text).toContain("rec_policy_");
    expect(shared.text).not.toMatch(/rec_policy_\d+\([^)]+\) AS MATERIALIZED/);

    const subjects = compilePostgresSubjectLookup(compiled.model, "ns", {
      resource: { type: "folder", id: "f-leaf" },
      permission: "view",
      subjectType: "user",
    });
    expect(subjects.text).toContain("WITH RECURSIVE rec_sub_walk_");
  });

  it("compiles mutually recursive arrow cycles cleanly", () => {
    const user = entityHandle({ wireName: "user", idSchema: z.string() });
    const alpha = entityHandle({ wireName: "alpha", idSchema: z.string() });
    const beta = entityHandle({ wireName: "beta", idSchema: z.string() });
    const alphaAccess = access(alpha, {
      roles: { viewer: user, parent_beta: beta },
      permissions: ({ viewer, parent_beta }) => ({
        view: [viewer, through(parent_beta, permissionToken("beta", "view"))],
      }),
    });
    const betaAccess = access(beta, {
      roles: { viewer: user, parent_alpha: alpha },
      permissions: ({ viewer, parent_alpha }) => ({
        view: [viewer, through(parent_alpha, permissionToken("alpha", "view"))],
      }),
    });
    const compiled = compileAccessPolicy(
      accessModel([
        access(user, { roles: {}, permissions: () => ({}) }),
        alphaAccess,
        betaAccess,
      ]),
    );

    const check = compilePostgresCheck(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resource: { type: "alpha", id: "a-1" },
      permission: "view",
    });
    expect(check.text).toContain("WITH RECURSIVE rec_walk_");
    expect(check.text).toContain("UNION ALL");
    expect(check.values).toContain("alpha");
    expect(check.values).toContain("beta");

    const lookup = compilePostgresLookup(compiled.model, "ns", {
      subject: { type: "user", id: "alice" },
      resourceType: "alpha",
      permission: "view",
    });
    expect(lookup.text).toContain("WITH RECURSIVE rec_allowed_");

    const subjects = compilePostgresSubjectLookup(compiled.model, "ns", {
      resource: { type: "alpha", id: "a-1" },
      permission: "view",
      subjectType: "user",
    });
    expect(subjects.text).toContain("WITH RECURSIVE rec_sub_walk_");
  });
});

describe("transitive lookupSubjects", () => {
  it("parses concrete and wildcard rows, deduplicates and sorts concrete subjects", async () => {
    const model = buildParityModel();
    const { queries, executor } = createRecordingExecutor([
      { subject_id: "charlie", is_wildcard: false },
      { subject_id: "alice", is_wildcard: false },
      { subject_id: "", is_wildcard: true },
      { subject_id: "alice", is_wildcard: false },
    ]);
    const authorization = new PostgresAuthorization({
      model,
      namespace: "ns-sub",
      executor,
    });

    const result = await authorization.lookupSubjects({
      resource: { type: "document", id: "doc-1" },
      permission: "view",
      subjectType: "user",
    });
    expect(result).toEqual({
      subjects: ["alice", "charlie"],
      hasWildcard: true,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("WITH RECURSIVE req_");
    expect(queries[0]?.text).toContain("sub_inc_");
    expect(queries[0]?.text).toContain("sub_exc_");
    expect(queries[0]?.text).toContain("expires_at IS NULL OR");
  });

  it("denies unknown permissions cleanly without querying and validates inputs", async () => {
    const model = buildParityModel();
    const { queries, executor } = createRecordingExecutor([]);
    const authorization = new PostgresAuthorization({
      model,
      namespace: "ns-sub",
      executor,
    });

    const denied = await authorization.lookupSubjects({
      resource: { type: "document", id: "doc-1" },
      permission: "nonexistent",
      subjectType: "user",
    });
    expect(denied).toEqual({ subjects: [], hasWildcard: false });
    expect(queries).toHaveLength(0);

    await expect(
      authorization.lookupSubjects({
        resource: { type: "document", id: "*" },
        permission: "view",
        subjectType: "user",
      }),
    ).rejects.toThrow(/concrete resource/);

    await expect(
      authorization.lookupSubjects({
        resource: { type: "document", id: "doc-1" },
        permission: "view",
        subjectType: "",
      }),
    ).rejects.toThrow(/subject type/);
  });

  it("compiles wildcard-aware intersection (both) and exposes lookupSubjects on transaction scopes", async () => {
    const model = buildParityModel();
    const { queries, executor } = createRecordingExecutor([
      { subject_id: "bob", is_wildcard: false },
    ]);
    const root = new PostgresAuthorization({
      model,
      namespace: "ns-tx",
      executor,
    });
    const scoped = root.inTransaction(executor);

    const result = await scoped.lookupSubjects({
      resource: { type: "document", id: "doc-1" },
      permission: "approved_view",
      subjectType: "user",
    });
    expect(result).toEqual({ subjects: ["bob"], hasWildcard: false });
    expect(queries[0]?.text).toContain("sub_l_");
    expect(queries[0]?.text).toContain("sub_r_");
    expect(queries[0]?.text).toContain("r.is_wildcard");
  });
});
