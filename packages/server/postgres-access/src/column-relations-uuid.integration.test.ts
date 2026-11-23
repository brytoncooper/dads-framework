import { actor, anyOf, compileAccess, every, resource } from "@dads-framework/access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileAccessPolicy } from "./compile-access-policy.js";
import { compileSharedPointCheck } from "./policy/compile-shared-point-check.js";
import {
  columnRelationIndexSql,
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
  type ColumnRelationBinding,
} from "./index.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const ORG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOLDER_ROOT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOLDER_LEAF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOC_ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DOC_NESTED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOC_OWNED = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function buildUuidAccessModel() {
  const user = actor("user");
  const org = resource("org", {
    roles: { owner: user, member: user },
    can: ({ owner, member }) => ({
      own: owner,
      view: anyOf(owner, member),
    }),
  });
  const folder = resource("folder", {
    recursive: true,
    roles: { org, owner: user },
    can: ({ owner, org: orgRole }) => ({
      own: owner,
      view: anyOf(owner, orgRole.view),
    }),
  });
  const doc = resource("document", {
    roles: { org, folder, owner: user, banned: user },
    can: ({ owner, org: orgRole, folder: folderRole, banned }) => ({
      own: owner,
      org_own: orgRole.own,
      strict_org_own: every(orgRole).own,
      folder_own: folderRole.own,
      view: anyOf(owner, orgRole.view, folderRole.view).unless(banned),
      strict_org_view: every(orgRole).view,
    }),
  });
  const model = compileAccess([user, org, folder, doc]);
  const bindings: readonly ColumnRelationBinding[] = [
    { role: org.roles.owner, table: "uuid_orgs", idColumn: "id", targetIdColumn: "owner_id" },
    { role: folder.roles.org, table: "uuid_folders", idColumn: "id", targetIdColumn: "org_id" },
    { role: folder.roles.parent, table: "uuid_folders", idColumn: "id", targetIdColumn: "parent_id" },
    { role: folder.roles.owner, table: "uuid_folders", idColumn: "id", targetIdColumn: "owner_id" },
    { role: doc.roles.org, table: "uuid_documents", idColumn: "id", targetIdColumn: "org_id" },
    { role: doc.roles.folder, table: "uuid_documents", idColumn: "id", targetIdColumn: "folder_id" },
    { role: doc.roles.owner, table: "uuid_documents", idColumn: "id", targetIdColumn: "owner_id" },
  ];
  return { model, bindings };
}

describe("PostgreSQL native UUID columnRelations and pure column-relation checks", () => {
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    await postgres.pool.query(relationshipSchemaMigration.sql);
    await postgres.pool.query(`
      CREATE TABLE uuid_orgs (
        id UUID PRIMARY KEY,
        owner_id UUID
      );
      CREATE TABLE uuid_folders (
        id UUID PRIMARY KEY,
        org_id UUID,
        parent_id UUID,
        owner_id UUID
      );
      CREATE TABLE uuid_documents (
        id UUID PRIMARY KEY,
        org_id UUID,
        folder_id UUID,
        owner_id UUID
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("evaluates pure and mixed UUID column relations without 42883, UNION mismatch, 42P18, or 22P02", async () => {
    await postgres.pool.query("TRUNCATE TABLE dad_authorization_relationship, uuid_documents, uuid_folders, uuid_orgs");
    await postgres.pool.query(`INSERT INTO uuid_orgs (id, owner_id) VALUES ($1::uuid, $2::uuid);`, [ORG_1, ALICE]);
    await postgres.pool.query(
      `INSERT INTO uuid_folders (id, org_id, parent_id, owner_id) VALUES
        ($1::uuid, $2::uuid, NULL, $3::uuid),
        ($4::uuid, NULL, $1::uuid, NULL);`,
      [FOLDER_ROOT, ORG_1, ALICE, FOLDER_LEAF],
    );
    await postgres.pool.query(
      `INSERT INTO uuid_documents (id, org_id, folder_id, owner_id) VALUES
        ($1::uuid, $2::uuid, NULL, NULL),
        ($3::uuid, NULL, $4::uuid, NULL),
        ($5::uuid, NULL, NULL, $6::uuid);`,
      [DOC_ORG, ORG_1, DOC_NESTED, FOLDER_LEAF, DOC_OWNED, CAROL],
    );

    const { model, bindings } = buildUuidAccessModel();
    const authz = new PostgresAuthorization({
      model,
      namespace: "ns-uuid",
      executor: preparePostgresChecks(postgres.pool),
      columnRelations: bindings,
    });

    await authz.writeRelationships([
      { resource: { type: "org", id: ORG_1 }, relation: "member", subject: { type: "user", id: BOB } },
      { resource: { type: "document", id: DOC_NESTED }, relation: "banned", subject: { type: "user", id: BOB } },
    ]);

    // Pure column-relation checks (must NOT fail with 42P18 on unused namespace!)
    expect(
      await authz.check({
        subject: { type: "user", id: CAROL },
        permission: "own",
        resource: { type: "document", id: DOC_OWNED },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: ALICE },
        permission: "org_own",
        resource: { type: "document", id: DOC_ORG },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: ALICE },
        permission: "strict_org_own",
        resource: { type: "document", id: DOC_ORG },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: ALICE },
        permission: "folder_own",
        resource: { type: "document", id: DOC_NESTED },
      }),
    ).toBe(true);
    expect(
      await authz.check({
        subject: { type: "user", id: "not-a-uuid" },
        permission: "own",
        resource: { type: "document", id: "also-not-uuid" },
      }),
    ).toBe(false);

    // Pure column-relation checkMany & lookupSubjects
    expect(
      await authz.checkMany([
        { subject: { type: "user", id: CAROL }, permission: "own", resource: { type: "document", id: DOC_OWNED } },
        { subject: { type: "user", id: ALICE }, permission: "org_own", resource: { type: "document", id: DOC_ORG } },
        { subject: { type: "user", id: BOB }, permission: "org_own", resource: { type: "document", id: DOC_ORG } },
        {
          subject: { type: "user", id: ALICE },
          permission: "folder_own",
          resource: { type: "document", id: DOC_NESTED },
        },
      ]),
    ).toEqual([true, true, false, true]);
    expect(
      await authz.lookupSubjects({
        resource: { type: "document", id: DOC_NESTED },
        permission: "folder_own",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [ALICE], hasWildcard: false });

    // Mixed column + tuple checks, checkMany, lookupResources, lookupSubjects, sharedPointCheck
    expect(
      await authz.checkMany([
        { subject: { type: "user", id: BOB }, permission: "view", resource: { type: "document", id: DOC_ORG } },
        { subject: { type: "user", id: BOB }, permission: "view", resource: { type: "document", id: DOC_NESTED } },
        { subject: { type: "user", id: ALICE }, permission: "view", resource: { type: "document", id: DOC_NESTED } },
        {
          subject: { type: "user", id: BOB },
          permission: "strict_org_view",
          resource: { type: "document", id: DOC_ORG },
        },
      ]),
    ).toEqual([true, false, true, true]);

    expect(
      await authz.lookupResources({
        subject: { type: "user", id: ALICE },
        permission: "view",
        resourceType: "document",
      }),
    ).toEqual([DOC_ORG, DOC_NESTED]);
    expect(
      await authz.lookupResources({ subject: { type: "user", id: BOB }, permission: "view", resourceType: "document" }),
    ).toEqual([DOC_ORG]);
    expect(
      await authz.lookupSubjects({
        resource: { type: "document", id: DOC_ORG },
        permission: "view",
        subjectType: "user",
      }),
    ).toEqual({ subjects: [ALICE, BOB], hasWildcard: false });

    const compiled = compileAccessPolicy(model, bindings);
    const shared = compileSharedPointCheck(compiled.model, "ns-uuid", {
      subject: { type: "user", id: ALICE },
      permission: "view",
      resource: { type: "document", id: DOC_NESTED },
    });
    const sharedRows = await postgres.pool.query<{ allowed: boolean }>(shared.text, [...(shared.values ?? [])]);
    expect(sharedRows.rows[0]?.allowed).toBe(true);

    // compileFilter & resolveFilter against UUID columns
    const compiledFilter = authz.compileFilter({
      subject: { type: "user", id: BOB },
      permission: "view",
      resourceType: "document",
      idColumn: "d.id",
      scopeColumns: "auto",
    });
    const compiledRows = await postgres.pool.query<{ id: string }>(
      `SELECT d.id::text AS id FROM uuid_documents d WHERE ${compiledFilter.sql} ORDER BY d.id`,
      [...compiledFilter.values],
    );
    expect(compiledRows.rows.map((row) => row.id)).toEqual([DOC_ORG]);

    const resolvedFilter = await authz.resolveFilter({
      subject: { type: "user", id: BOB },
      permission: "view",
      resourceType: "document",
      idColumn: "d.id",
      scopeColumns: "auto",
    });
    const resolvedRows = await postgres.pool.query<{ id: string }>(
      `SELECT d.id::text AS id FROM uuid_documents d WHERE ${resolvedFilter.sql} ORDER BY d.id`,
      [...resolvedFilter.values],
    );
    expect(resolvedRows.rows.map((row) => row.id)).toEqual([DOC_ORG]);

    // relationshipExists, listDirectSubjects, verifyColumnRelations
    expect(await authz.relationshipExists({ resourceType: "document", resourceId: DOC_OWNED, relation: "owner" })).toBe(
      true,
    );
    expect(
      await authz.relationshipExists({ resourceType: "document", resourceId: "not-a-uuid", relation: "owner" }),
    ).toBe(false);
    expect(
      await authz.listDirectSubjects({ resource: { type: "document", id: DOC_OWNED }, relation: "owner" }),
    ).toEqual([{ type: "user", id: CAROL }]);

    for (const ddl of columnRelationIndexSql(bindings)) {
      await postgres.pool.query(ddl);
    }
    const verified = await authz.verifyColumnRelations();
    expect(verified.every((entry) => entry.hasRecommendedIndex)).toBe(true);
  });
});
