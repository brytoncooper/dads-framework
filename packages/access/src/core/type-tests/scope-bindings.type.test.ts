import { describe, expectTypeOf, it } from "vitest";
import { sheet } from "../test-support/scope-plan.access.js";
import { scopeBindings } from "../scope-bindings.js";

describe("scopeBindings", () => {
  it("keeps each role's declared kind in the type and refuses unknown roles", () => {
    const bound = scopeBindings(sheet, {
      folder: { kind: "scope-column" },
      site: { kind: "scope-column" },
    });
    expectTypeOf(bound.roles.folder.kind).toEqualTypeOf<"scope-column">();

    // @ts-expect-error — a sheet has no role named shelf
    scopeBindings(sheet, { shelf: { kind: "scope-column" } });
  });
});
