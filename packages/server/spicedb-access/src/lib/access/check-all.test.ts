import { describe, expect, it } from "vitest";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { type PermissionQuery, relationshipWrite } from "@dads-framework/access/runtime";
import { checkAll } from "./check-all.js";

const SUBJECT = { type: "user", id: "ada" };
const queries: readonly PermissionQuery[] = ["a", "b"].map((id) => ({
  subject: SUBJECT,
  permission: "view",
  resource: { type: "thing", id },
}));

class BulkCheckingAuthorization extends FakeAuthorization {
  batches = 0;

  checkMany(batch: readonly PermissionQuery[]): Promise<readonly boolean[]> {
    this.batches += 1;
    return Promise.all(batch.map((query) => super.check(query)));
  }
}

describe("checkAll", () => {
  it("asks one bulk check where the port offers it, answering in input order", async () => {
    const authorization = new BulkCheckingAuthorization();
    authorization.seed(relationshipWrite({ type: "thing", id: "b" }, "view", SUBJECT));
    expect(await checkAll(authorization, queries)).toEqual([false, true]);
    expect(authorization.batches).toBe(1);
  });

  it("checks each query alone where the port has no bulk check", async () => {
    const authorization = new FakeAuthorization();
    authorization.seed(relationshipWrite({ type: "thing", id: "a" }, "view", SUBJECT));
    expect(await checkAll(authorization, queries)).toEqual([true, false]);
  });
});
