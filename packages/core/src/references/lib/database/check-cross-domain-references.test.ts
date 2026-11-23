/**
 * The SQL one declaration turns into.
 *
 * These are the checks that do not need a database. The container tier beside
 * this file proves the same queries against a real Postgres.
 */
import { describe, expect, it } from "vitest";

import { buildDanglingValueQuery, checkCrossDomainReferences } from "./check-cross-domain-references.js";

describe("buildDanglingValueQuery", () => {
  const reference = {
    id: "facilities.owner_organization_id",
    consumerDomain: "facilities",
    consumerTable: "facilities",
    consumerColumn: "owner_organization_id",
    providerDomain: "organizations",
    providerTable: "organizations",
    providerColumn: "id",
    classification: "live-association",
  } as const;

  it("rejects a query result with the wrong row shape", async () => {
    const client = {
      query: () => Promise.resolve({ rows: [{ value: "id", occurrences: "2" }] }),
    };
    await expect(checkCrossDomainReferences(client, [reference])).rejects.toThrow(
      "returned an invalid reconciliation row",
    );
  });

  it("skips null references — absence is a valid state, not a break", () => {
    expect(buildDanglingValueQuery(reference).text).toContain(`referencing."owner_organization_id" IS NOT NULL`);
  });

  /**
   * `user.id` is TEXT, every other key is UUID, and
   * `sso_provider.organization_id` is a TEXT column pointing at a UUID key. A
   * typed comparison aborts the run on that row instead of reporting it.
   */
  it("compares both sides as text", () => {
    expect(buildDanglingValueQuery(reference).text).toContain(
      `referenced."id"::text = referencing."owner_organization_id"::text`,
    );
  });

  it("checks every element of an array column as its own reference", () => {
    const { text } = buildDanglingValueQuery({
      ...reference,
      id: "batching.product_sources.loaded_facility_product_ids",
      consumerTable: "product_sources",
      consumerColumn: "loaded_facility_product_ids",
      providerTable: "facility_products",
      consumerHoldsMany: true,
    });

    expect(text).toContain(`CROSS JOIN LATERAL unnest(referencing."loaded_facility_product_ids") AS element("value")`);
    expect(text).toContain(`referenced."id"::text = element."value"::text`);
    expect(text).toContain(`element."value" IS NOT NULL`);
  });

  it("binds discriminator values instead of interpolating them", () => {
    const { text, values } = buildDanglingValueQuery({
      ...reference,
      id: "platform_work_assignments.scope_id[ORGANIZATION]",
      consumerTable: "platform_work_assignments",
      consumerColumn: "scope_id",
      filters: [{ column: "scope_type", equals: "ORGANIZATION" }],
    });

    expect(text).toContain(`referencing."scope_type" = $1`);
    expect(values).toEqual(["ORGANIZATION"]);
  });

  it("joins the parent that carries a non-local discriminator", () => {
    const { text, values } = buildDanglingValueQuery({
      ...reference,
      id: "permission_set_assignments.membership_id[ORGANIZATION]",
      consumerTable: "permission_set_assignments",
      consumerColumn: "membership_id",
      providerTable: "organization_memberships",
      discriminatedByParent: {
        table: "permission_sets",
        localColumn: "permission_set_id",
        parentColumn: "id",
        filters: [{ column: "scope_type", equals: "ORGANIZATION" }],
      },
    });

    expect(text).toContain(`discriminator."id" = referencing."permission_set_id"`);
    expect(text).toContain(`discriminator."scope_type" = $1`);
    expect(values).toEqual(["ORGANIZATION"]);
  });

  it("refuses an identifier that is not a plain Postgres identifier", () => {
    expect(() =>
      buildDanglingValueQuery({
        ...reference,
        consumerTable: 'facilities"; DROP TABLE organizations; --',
      }),
    ).toThrow(/not a plain lower_snake_case/);
  });
});
