import { describe, expect, it } from "vitest";

import { Authorization } from "@dads-framework/access/runtime";
import type { ResourceLookup } from "@dads-framework/access/runtime";
import { listOnlyVisible } from "./list-only-visible.js";

class StubAuthorization extends Authorization {
  constructor(private readonly ids: readonly string[]) {
    super();
  }
  lookups: ResourceLookup[] = [];

  check(): Promise<boolean> {
    return Promise.resolve(false);
  }
  lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    this.lookups.push(query);
    return Promise.resolve(this.ids);
  }
  writeRelationships(): Promise<string> {
    return Promise.resolve("");
  }
  deleteRelationships(): Promise<string> {
    return Promise.resolve("");
  }
  relationshipExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listDirectSubjects(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }
}

const LOOKUP = {
  subject: { type: "user", id: "u1" },
  permission: "view",
  resourceType: "organizations/organization",
};

describe("listOnlyVisible", () => {
  it("returns empty WITHOUT calling list when the visible set is empty (fail-closed)", async () => {
    const authorization = new StubAuthorization([]);
    let listCalled = false;
    const result = await listOnlyVisible(authorization, LOOKUP, () => {
      listCalled = true;
      return Promise.resolve({ rows: [{ id: "leak" }], total: 1 });
    });
    expect(listCalled).toBe(false);
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it("passes the subject's visible ids through to list", async () => {
    const authorization = new StubAuthorization(["a", "b"]);
    const result = await listOnlyVisible(authorization, LOOKUP, (visibleIds) =>
      Promise.resolve({
        rows: visibleIds.map((id) => ({ id })),
        total: visibleIds.length,
      }),
    );
    expect(authorization.lookups).toEqual([LOOKUP]);
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.total).toBe(2);
  });
});
