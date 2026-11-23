import { actor, anyOf, compileAccess, every, resource, roleToken } from "@dads-framework/access";
import type { DrizzleHandle } from "@dads-framework/postgres";
import { describe, expect, expectTypeOf, it } from "vitest";

import { compileAccessPolicy } from "../compile-access-policy.js";
import type { DrizzleExecuteLike, DrizzleTransaction as DrizzleSubpathTransaction } from "../drizzle.js";
import {
  filterColumnRelationsForModel,
  PostgresAuthorization,
  type ColumnRelationBinding,
  type DrizzleTransaction,
  type PostgresQuery,
} from "../index.js";
import { verifyPostgresColumnRelations } from "./column-relations.js";
import {
  compilePostgresCandidatePredicate,
  compilePostgresCheck,
  compilePostgresCheckMany,
  compilePostgresLookup,
} from "./compile-postgres-policy.js";
import { compileSharedPointCheck } from "./compile-shared-point-check.js";
import { compilePostgresSubjectLookup } from "./compile-subject-lookup.js";

function assertEveryPlaceholderReferenced(sql: string, values: readonly unknown[] | undefined, offset = 1): void {
  const list = values ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const placeholder = offset + index;
    expect(sql, `expected $${String(placeholder)} to be referenced in SQL`).toMatch(
      new RegExp(`\\$${String(placeholder)}(?!\\d)`),
    );
  }
  const next = offset + list.length;
  expect(sql, `did not expect $${String(next)} in SQL`).not.toMatch(new RegExp(`\\$${String(next)}(?!\\d)`));
}

function buildColumnFixture() {
  const user = actor("user");
  const org = resource("org", {
    roles: {
      owner: user,
      member: user,
    },
    can: ({ owner, member }) => ({
      own: owner,
      view: anyOf(owner, member),
    }),
  });
  const folder = resource("folder", {
    recursive: true,
    roles: {
      org,
      owner: user,
    },
    can: ({ owner, org: orgRole }) => ({
      own: owner,
      view: anyOf(owner, orgRole.view),
    }),
  });
  const doc = resource("document", {
    roles: {
      org,
      folder,
      owner: user,
      banned: user,
    },
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
    { role: org.roles.owner, table: "orgs", idColumn: "id", targetIdColumn: "owner_id" },
    { role: folder.roles.org, table: "folders", idColumn: "id", targetIdColumn: "org_id" },
    { role: folder.roles.parent, table: "folders", idColumn: "id", targetIdColumn: "parent_id" },
    { role: folder.roles.owner, table: "folders", idColumn: "id", targetIdColumn: "owner_id" },
    { role: doc.roles.org, table: "documents", idColumn: "id", targetIdColumn: "org_id" },
    { role: doc.roles.folder, table: "documents", idColumn: "id", targetIdColumn: "folder_id" },
    { role: doc.roles.owner, table: "documents", idColumn: "id", targetIdColumn: "owner_id" },
  ];
  const policy = compileAccessPolicy(model, bindings);
  return { user, org, folder, doc, model, bindings, policy };
}

describe("columnRelations UUID safety and lazy namespace parameters", () => {
  const ns = "tenant-uuid";
  const subject = { type: "user", id: "550e8400-e29b-41d4-a716-446655440000" };
  const docRef = { type: "document", id: "550e8400-e29b-41d4-a716-446655440001" };
  const folderRef = { type: "folder", id: "550e8400-e29b-41d4-a716-446655440002" };

  it("omits unused namespace parameter and references every $1..$k in pure column-relation checks", () => {
    const { policy } = buildColumnFixture();
    const cases = [
      { resource: docRef, permission: "own" },
      { resource: docRef, permission: "org_own" },
      { resource: docRef, permission: "strict_org_own" },
      { resource: folderRef, permission: "own" },
      { resource: docRef, permission: "folder_own" },
    ] as const;

    for (const testCase of cases) {
      const check = compilePostgresCheck(policy.model, ns, {
        subject,
        resource: testCase.resource,
        permission: testCase.permission,
      });
      assertEveryPlaceholderReferenced(check.text, check.values);
      expect(check.values).not.toContain(ns);
      expect(check.text).not.toContain("dad_authorization_relationship");

      const candidate = compilePostgresCandidatePredicate(policy.model, ns, {
        subject,
        resourceType: testCase.resource.type,
        permission: testCase.permission,
      });
      assertEveryPlaceholderReferenced(candidate.text, candidate.values);
      expect(candidate.values).not.toContain(ns);

      const subjects = compilePostgresSubjectLookup(policy.model, ns, {
        resource: testCase.resource,
        permission: testCase.permission,
        subjectType: "user",
      });
      assertEveryPlaceholderReferenced(subjects.text, subjects.values);
      expect(subjects.values).not.toContain(ns);
    }

    const batch = compilePostgresCheckMany(policy.model, ns, [
      { subject, resource: docRef, permission: "own" },
      { subject, resource: docRef, permission: "org_own" },
      { subject, resource: folderRef, permission: "own" },
    ]);
    assertEveryPlaceholderReferenced(batch.text, batch.values);
    expect(batch.values).not.toContain(ns);
  });

  it("casts column-relation comparisons and projections to text across check, checkMany, lookup, subjectLookup, filter, and sharedPointCheck", async () => {
    const { policy, model, bindings } = buildColumnFixture();

    const directCheck = compilePostgresCheck(policy.model, ns, {
      subject,
      resource: docRef,
      permission: "own",
    });
    expect(directCheck.text).toContain("col_tuple.id::text = ($4)::text");
    expect(directCheck.text).toContain("col_tuple.owner_id::text = ($2)::text");

    const mixedCheck = compilePostgresCheck(policy.model, ns, {
      subject,
      resource: docRef,
      permission: "view",
    });
    assertEveryPlaceholderReferenced(mixedCheck.text, mixedCheck.values);
    expect(mixedCheck.values).toContain(ns);
    expect(mixedCheck.text).toContain("through_tuple_0.id::text = ($4)::text");
    expect(mixedCheck.text).toContain("through_tuple_0.org_id::text");
    expect(mixedCheck.text).toContain(".parent_id::text AS resource_id");

    const throughAllCheck = compilePostgresCheck(policy.model, ns, {
      subject,
      resource: docRef,
      permission: "strict_org_view",
    });
    assertEveryPlaceholderReferenced(throughAllCheck.text, throughAllCheck.values);
    expect(throughAllCheck.text).toContain(".id::text = ($4)::text");
    expect(throughAllCheck.text).toContain(".org_id::text");

    const batch = compilePostgresCheckMany(policy.model, ns, [
      { subject, resource: docRef, permission: "view" },
      { subject, resource: docRef, permission: "strict_org_view" },
    ]);
    assertEveryPlaceholderReferenced(batch.text, batch.values);
    expect(batch.text).toContain("col_tuple.id::text = (i.resource_id)::text");
    expect(batch.text).toContain("col_tuple.owner_id::text = (i.subject_id)::text");

    const lookup = compilePostgresLookup(policy.model, ns, {
      subject,
      resourceType: "document",
      permission: "view",
    });
    assertEveryPlaceholderReferenced(lookup.text, lookup.values);
    expect(lookup.text).toContain("col_direct.id::text");
    expect(lookup.text).toContain("col_direct.owner_id::text = ($");
    expect(lookup.text).toContain(".id::text AS resource_id");
    expect(lookup.text).toContain(".org_id::text = related_resource.resource_id");
    expect(lookup.text).toContain(".parent_id::text = parent_node.resource_id");

    const lookupAll = compilePostgresLookup(policy.model, ns, {
      subject,
      resourceType: "document",
      permission: "strict_org_view",
    });
    assertEveryPlaceholderReferenced(lookupAll.text, lookupAll.values);
    expect(lookupAll.text).toContain(".id::text = candidate.resource_id");
    expect(lookupAll.text).toContain("allowed_target.resource_id = ");
    expect(lookupAll.text).toContain(".org_id::text");

    const subjects = compilePostgresSubjectLookup(policy.model, ns, {
      resource: docRef,
      permission: "view",
      subjectType: "user",
    });
    assertEveryPlaceholderReferenced(subjects.text, subjects.values);
    expect(subjects.text).toContain(".owner_id::text AS subject_id");
    expect(subjects.text).toContain(".org_id::text");
    expect(subjects.text).toContain(".parent_id::text AS resource_id");

    const subjectsAll = compilePostgresSubjectLookup(policy.model, ns, {
      resource: docRef,
      permission: "strict_org_view",
      subjectType: "user",
    });
    assertEveryPlaceholderReferenced(subjectsAll.text, subjectsAll.values);
    expect(subjectsAll.text).toContain(".org_id::text AS parent_id");
    expect(subjectsAll.text).toContain(".id::text = (");

    const shared = compileSharedPointCheck(policy.model, ns, {
      subject,
      resource: docRef,
      permission: "view",
    });
    assertEveryPlaceholderReferenced(shared.text, shared.values);
    expect(shared.text).toContain("col_direct.id::text");
    expect(shared.text).toContain("col_tuple.id::text AS resource_id");
    expect(shared.text).toContain("col_tuple.org_id::text = reached.resource_id");

    const sharedAll = compileSharedPointCheck(policy.model, ns, {
      subject,
      resource: docRef,
      permission: "strict_org_view",
    });
    assertEveryPlaceholderReferenced(sharedAll.text, sharedAll.values);
    expect(sharedAll.text).toContain("col_cand.id::text AS resource_id");
    expect(sharedAll.text).toContain("col_cand.org_id::text = reached.resource_id");
    expect(sharedAll.text).toContain("allowed_parent.resource_id = col_all.org_id::text");

    const captured: PostgresQuery[] = [];
    const auth = new PostgresAuthorization({
      model,
      namespace: ns,
      columnRelations: bindings,
      executor: {
        query(query) {
          captured.push(query);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      },
    });

    const filter = auth.compileFilter({
      subject,
      permission: "view",
      resourceType: "document",
      idColumn: "documents.id",
      scopeColumns: "auto",
      paramOffset: 2,
    });
    assertEveryPlaceholderReferenced(filter.sql, filter.values, 2);
    expect(filter.sql).toContain("(documents.org_id)::text IN (");
    expect(filter.sql).toContain("(documents.folder_id)::text IN (");
    expect(filter.sql).toContain("(documents.id)::text IN (");
    expect(filter.sql).toContain("(documents.id)::text NOT IN (");

    await auth.relationshipExists({
      resourceType: "document",
      resourceId: docRef.id,
      relation: "owner",
    });
    await auth.listDirectSubjects({
      resource: docRef,
      relation: "owner",
    });
    expect(captured[0]?.text).toContain("WHERE id::text = ($1)::text");
    expect(captured[1]?.text).toContain(
      "SELECT DISTINCT owner_id::text AS subject_id FROM documents WHERE id::text = ($1)::text",
    );
    expect(captured[1]?.text).toContain("ORDER BY subject_id");
  });

  it("verifies uuid column relations cleanly against information_schema and pg_indexes", async () => {
    const { policy } = buildColumnFixture();
    const firstBinding = policy.model.columnRelations?.slice(0, 1) ?? [];
    const results = await verifyPostgresColumnRelations(firstBinding, (query) => {
      if (query.text.includes("information_schema.columns")) {
        return Promise.resolve([{ column_name: "id" }, { column_name: "owner_id" }]);
      }
      return Promise.resolve([
        {
          indexdef:
            "CREATE INDEX idx_dad_orgs_owner_id_id ON public.orgs USING btree (((owner_id)::text), ((id)::text))",
        },
      ]);
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.hasRecommendedIndex).toBe(true);
  });
});

describe("filterColumnRelationsForModel", () => {
  it("filters shared bindings to mounted entities while keeping typos on mounted entities for strict validation", () => {
    const user = actor("user");
    const org = resource("org", {
      roles: { owner: user },
      can: ({ owner }) => ({ view: owner }),
    });
    const staffNote = resource("staff_note", {
      roles: { org, author: user },
      can: ({ author, org: orgRole }) => ({ view: anyOf(author, orgRole.view) }),
    });
    const customerOrder = resource("customer_order", {
      roles: { org, buyer: user },
      can: ({ buyer, org: orgRole }) => ({ view: anyOf(buyer, orgRole.view) }),
    });

    const staffModel = compileAccess([user, org, staffNote]);
    const sharedBindings: readonly ColumnRelationBinding[] = [
      { role: org.roles.owner, table: "orgs", idColumn: "id", targetIdColumn: "owner_id" },
      { role: staffNote.roles.org, table: "staff_notes", idColumn: "id", targetIdColumn: "org_id" },
      { role: customerOrder.roles.org, table: "customer_orders", idColumn: "id", targetIdColumn: "org_id" },
      { role: customerOrder.roles.buyer, table: "customer_orders", idColumn: "id", targetIdColumn: "buyer_id" },
    ];

    // Unfiltered shared bindings still fail loudly on staffModel.
    expect(() => compileAccessPolicy(staffModel, sharedBindings)).toThrow(
      "Column relation customer_order#org does not exist in the compiled access model",
    );

    // Filtered bindings mount cleanly on staffModel.
    const filtered = filterColumnRelationsForModel(staffModel, sharedBindings);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((entry) => `${entry.role.entityWireName}#${entry.role.roleName}`)).toEqual([
      "org#owner",
      "staff_note#org",
    ]);
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(() => compileAccessPolicy(staffModel, filtered)).not.toThrow();

    // A typo on a mounted entity is NOT silently dropped; compileColumnRelations still rejects it.
    const typoBinding: ColumnRelationBinding = {
      role: roleToken("staff_note", "typo_role", user.handle),
      table: "staff_notes",
      idColumn: "id",
      targetIdColumn: "typo_id",
    };
    const filteredWithTypo = filterColumnRelationsForModel(staffModel, [...sharedBindings, typoBinding]);
    expect(filteredWithTypo).toHaveLength(3);
    expect(() => compileAccessPolicy(staffModel, filteredWithTypo)).toThrow(
      "Column relation staff_note#typo_role does not exist in the compiled access model",
    );
  });
});

describe("DrizzleTransaction type export", () => {
  it("extracts the exact Drizzle transaction handle type and defaults to DrizzleExecuteLike", () => {
    expectTypeOf<DrizzleTransaction<DrizzleHandle>>().toEqualTypeOf<
      Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0]
    >();
    expectTypeOf<DrizzleSubpathTransaction<DrizzleHandle>>().toEqualTypeOf<
      Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0]
    >();
    expectTypeOf<DrizzleTransaction>().toEqualTypeOf<DrizzleExecuteLike>();
  });
});
