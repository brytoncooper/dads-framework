import { describe, expect, it } from "vitest";
import { compileSharedPointCheck } from "./compile-shared-point-check.js";
import type { AuthorizationModelDefinition } from "./policy-model.js";
import {
  compilePostgresCandidatePredicate,
  compilePostgresCheck,
  compilePostgresLookup,
  POSTGRES_AUTHORIZATION_CANDIDATE_BINDING,
} from "./compile-postgres-policy.js";

const nestedThroughModel: AuthorizationModelDefinition = {
  entities: [
    { sourceName: "user", wireName: "user" },
    { sourceName: "organization", wireName: "organization" },
    { sourceName: "facility", wireName: "facility" },
    { sourceName: "order", wireName: "order" },
  ],
  relations: [
    {
      authority: "system",
      entity: "organization",
      sourceName: "manager",
      wireName: "manager",
      targets: [{ kind: "entity", entity: "user" }],
    },
    {
      authority: "system",
      entity: "organization",
      sourceName: "auditor",
      wireName: "auditor",
      targets: [{ kind: "entity", entity: "user" }],
    },
    {
      authority: "system",
      entity: "facility",
      sourceName: "organization",
      wireName: "organization",
      targets: [{ kind: "entity", entity: "organization" }],
    },
    {
      authority: "system",
      entity: "order",
      sourceName: "facility",
      wireName: "facility",
      targets: [{ kind: "entity", entity: "facility" }],
    },
  ],
  permissions: [
    {
      entity: "organization",
      sourceName: "manageOrders",
      wireName: "manage_orders",
      expression: { kind: "relation", relation: "manager" },
    },
    {
      entity: "organization",
      sourceName: "auditOrders",
      wireName: "audit_orders",
      expression: { kind: "relation", relation: "auditor" },
    },
    {
      entity: "facility",
      sourceName: "operate",
      wireName: "operate",
      expression: {
        kind: "through",
        relation: "organization",
        permission: "manage_orders",
      },
    },
    {
      entity: "facility",
      sourceName: "audit",
      wireName: "audit",
      expression: {
        kind: "through",
        relation: "organization",
        permission: "audit_orders",
      },
    },
    {
      entity: "order",
      sourceName: "operate",
      wireName: "operate",
      expression: {
        kind: "any-of",
        expressions: [
          { kind: "through", relation: "facility", permission: "operate" },
          { kind: "through", relation: "facility", permission: "audit" },
        ],
      },
    },
    {
      entity: "order",
      sourceName: "review",
      wireName: "review",
      expression: {
        kind: "exclude",
        include: {
          kind: "all-of",
          expressions: [
            { kind: "through", relation: "facility", permission: "operate" },
            { kind: "through", relation: "facility", permission: "audit" },
          ],
        },
        exclude: { kind: "through", relation: "facility", permission: "audit" },
      },
    },
  ],
  lifecycle: [],
};

describe("compilePostgresCheck through aliases", () => {
  it("admits a short path and bounds the total references in ordinary plans", () => {
    const subject = { type: "user", id: "user-1" };
    const short = compilePostgresCheck(nestedThroughModel, "tenant-a", {
      subject,
      resource: { type: "facility", id: "facility-1" },
      permission: "operate",
    });
    expect(short.canPrepare).toBe(true);

    const broad = compilePostgresCheck(
      {
        ...nestedThroughModel,
        permissions: [
          ...nestedThroughModel.permissions,
          {
            entity: "organization",
            sourceName: "broad",
            wireName: "broad",
            expression: {
              kind: "any-of",
              expressions: Array.from({ length: 5 }, () => ({
                kind: "relation",
                relation: "manager",
              })),
            },
          },
        ],
      },
      "tenant-a",
      {
        subject,
        resource: { type: "organization", id: "organization-1" },
        permission: "broad",
      },
    );
    expect(broad.canPrepare).toBe(false);
  });

  it("keeps nested and sibling through traversals distinct and correlated", () => {
    const plan = compilePostgresCheck(nestedThroughModel, "tenant-a", {
      subject: { type: "user", id: "user-1" },
      resource: { type: "order", id: "order-1" },
      permission: "operate",
    });

    expect(plan.canPrepare).toBe(false);
    expect(plan.text).toContain("FROM dad_authorization_relationship through_tuple_0");
    expect(plan.text).toContain("FROM dad_authorization_relationship through_tuple_1");
    expect(plan.text).toContain("FROM dad_authorization_relationship through_tuple_2");
    expect(plan.text).toContain("FROM dad_authorization_relationship through_tuple_3");
    expect(plan.text).toContain("through_tuple_1.resource_kind = through_tuple_0.subject_kind");
    expect(plan.text).toContain("through_tuple_1.resource_id = through_tuple_0.subject_id");
    expect(plan.text).toContain("through_tuple_3.resource_kind = through_tuple_2.subject_kind");
    expect(plan.text).toContain("through_tuple_3.resource_id = through_tuple_2.subject_id");
  });
});

it("rejects permission-through cycles in both point compilers", () => {
  const model: AuthorizationModelDefinition = {
    ...nestedThroughModel,
    relations: [
      ...nestedThroughModel.relations,
      {
        authority: "system",
        entity: "facility",
        sourceName: "loop",
        wireName: "loop",
        targets: [{ kind: "entity", entity: "facility" }],
      },
    ],
    permissions: [
      ...nestedThroughModel.permissions,
      {
        entity: "facility",
        sourceName: "loop",
        wireName: "loop",
        expression: { kind: "through", relation: "loop", permission: "loop" },
      },
    ],
  };
  const check = {
    subject: { type: "user", id: "user-1" },
    resource: { type: "facility", id: "facility-1" },
    permission: "loop",
  };
  expect(() => compilePostgresCheck(model, "tenant-a", check)).toThrow(/cycle/);
  expect(() => compileSharedPointCheck(model, "tenant-a", check)).toThrow(/cycle/);
});

describe("compilePostgresLookup", () => {
  it("starts from the subject reverse reachability set rather than all candidates", () => {
    const plan = compilePostgresLookup(nestedThroughModel, "tenant-a", {
      subject: { type: "user", id: "user-1" },
      resourceType: "order",
      permission: "review",
    });

    expect(plan.text).toContain("WITH RECURSIVE subject_reachable");
    expect(plan.text).toContain("FROM dad_authorization_relationship direct_tuple");
    expect(plan.text).toContain("FROM subject_reachable child_relation");
    expect(plan.text).toContain("tuple.subject_id = child_relation.resource_id");
    expect(plan.text).toContain("UNION");
    expect(plan.text).not.toContain("WITH candidate AS");
    expect(plan.text).not.toContain("SELECT DISTINCT resource_kind, resource_id");
    expect(plan.text).toContain("CROSS JOIN LATERAL");
    expect(plan.text).toContain("through_tuple_0.subject_id = related_resource.resource_id");
    expect(plan.text).toContain("OFFSET 0");
    expect(plan.text).toContain("INTERSECT");
    expect(plan.text).toContain("EXCEPT");
  });

  it("uses only the fixed candidate binding for a fused predicate", () => {
    const plan = compilePostgresCandidatePredicate(nestedThroughModel, "tenant-a", {
      subject: { type: "user", id: "user-1" },
      resourceType: "order",
      permission: "operate",
    });

    expect(plan.kind).toBe("candidate-predicate");
    expect(plan.text).toContain(
      `${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.tableAlias}.${POSTGRES_AUTHORIZATION_CANDIDATE_BINDING.resourceIdColumn}`,
    );
    expect(plan.text).not.toContain("WITH candidate AS");
    expect(plan.text).not.toContain("SELECT DISTINCT resource_kind, resource_id");
  });
});
