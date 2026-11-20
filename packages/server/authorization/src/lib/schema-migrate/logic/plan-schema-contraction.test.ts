// Parse only definitions and relations so a schema contraction can name leftover
// tuples without treating permission rewrites or comments as deletions.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseZedSchemaSurface } from "@dads-framework/access/schema";
import { planSchemaContraction } from "@dads-framework/access/schema";

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "__fixtures__",
    "relationship-with-ceiling-view-products.zed",
  ),
  "utf8",
);

describe("parseZedSchemaSurface", () => {
  it("reads namespaced definitions and relations from a published-schema slice", () => {
    const surface = parseZedSchemaSurface(FIXTURE);

    expect([...surface.resourceTypes].sort()).toEqual([
      "organizations/organization",
      "organizations/relationship",
      "user",
    ]);
    expect(surface.relations).toEqual([
      { resourceType: "organizations/organization", relation: "admin" },
      { resourceType: "organizations/organization", relation: "member" },
      { resourceType: "organizations/relationship", relation: "owner" },
      { resourceType: "organizations/relationship", relation: "counterparty" },
      {
        resourceType: "organizations/relationship",
        relation: "ceiling_create_orders",
      },
      {
        resourceType: "organizations/relationship",
        relation: "ceiling_view_products",
      },
    ]);
  });

  it("ignores permission formulas, caveats, and commented-out relations", () => {
    const surface = parseZedSchemaSurface(`
definition user {}

caveat remaining_hours(hours int) {
  hours > 0
}

definition docs/note {
  relation owner: user
  // relation stale: user
  permission view = owner
}
`);

    expect([...surface.resourceTypes]).toEqual(["user", "docs/note"]);
    expect(surface.relations).toEqual([
      { resourceType: "docs/note", relation: "owner" },
    ]);
  });
});

describe("planSchemaContraction", () => {
  it("names leftover types and relations absent from the desired schema", () => {
    const desired = parseZedSchemaSurface(
      FIXTURE.replace(
        "  relation ceiling_view_products: organizations/organization#member\n",
        "",
      ),
    );
    const live = parseZedSchemaSurface(`${FIXTURE}

definition leftover/report {
  relation owner: user
}
`);

    expect(planSchemaContraction(live, desired)).toEqual({
      removedTypes: ["leftover/report"],
      removedRelations: [
        {
          resourceType: "organizations/relationship",
          relation: "ceiling_view_products",
        },
      ],
    });
  });

  it("does not treat a permission rewrite as a deletion", () => {
    const live = parseZedSchemaSurface(FIXTURE);
    const desired = parseZedSchemaSurface(
      FIXTURE.replace(
        "permission create_orders = ceiling_create_orders & counterparty->manage_orders",
        "permission create_orders = ceiling_create_orders",
      ),
    );

    expect(planSchemaContraction(live, desired)).toEqual({
      removedTypes: [],
      removedRelations: [],
    });
  });
});
