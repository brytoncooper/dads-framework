// SpiceDB names the leftover filter in WriteSchema errors so migrate can
// delete that slice and retry instead of wiping the graph.
import { describe, expect, it } from "vitest";
import { parseWriteSchemaBlocker } from "@dads-framework/access/schema";

describe("parseWriteSchemaBlocker", () => {
  it("reads a leftover relation that still has tuples", () => {
    expect(
      parseWriteSchemaBlocker(
        "cannot delete relation `ceiling_view_products` in object definition `organizations/relationship`, as a relationship exists under it",
      ),
    ).toEqual({
      kind: "removed-relation",
      resourceType: "organizations/relationship",
      relation: "ceiling_view_products",
    });
  });

  it("reads a leftover object definition", () => {
    expect(
      parseWriteSchemaBlocker("cannot delete object definition `leftover/report` as a relationship exists under it"),
    ).toEqual({
      kind: "removed-type",
      resourceType: "leftover/report",
    });
  });

  it("reads a narrowed allowed subject type", () => {
    expect(
      parseWriteSchemaBlocker(
        "cannot remove allowed type `user` from relation `owner` in object definition `test/document` as a relationship exists with it",
      ),
    ).toEqual({
      kind: "removed-allowed-type",
      resourceType: "test/document",
      relation: "owner",
      subjectType: "user",
    });
  });

  it("returns nothing for unrelated write failures", () => {
    expect(parseWriteSchemaBlocker("connection refused")).toBeUndefined();
  });
});
