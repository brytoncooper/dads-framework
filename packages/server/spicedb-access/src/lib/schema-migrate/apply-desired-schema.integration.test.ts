// Real SpiceDB refuses WriteSchema while leftover tuples exist. Migrate must
// delete those tuples, write the desired schema, and leave remaining grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestSpiceDb, type TestSpiceDb } from "../../testing/start-test-spice-db.js";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "../access/spice-db-authorization.js";
import { applyDesiredAuthorizationSchema } from "@dads-framework/access/schema";

const OLD_SCHEMA = `
definition user {}

definition docs/note {
  relation owner: user
  relation stale: user
  permission view = owner + stale
}
`;

const DESIRED_SCHEMA = `
definition user {}

definition docs/note {
  relation owner: user
  permission view = owner
}
`;

const OWNER = { type: "user", id: "owner-1" };
const STALE_VIEWER = { type: "user", id: "stale-1" };
const NOTE = { type: "docs/note", id: "note-1" };

describe("applyDesiredAuthorizationSchema (SpiceDB)", () => {
  let spiceDb: TestSpiceDb;
  let store: SpiceDbAuthorization;
  let startedEmpty = false;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();

    store = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    startedEmpty = (await store.readSchema()) === "";
    await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED_SCHEMA,
    });
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("treats a never-written schema as empty and writes desired", () => {
    expect(startedEmpty).toBe(true);
  });

  it("deletes leftover relation tuples then writes the contracted schema", async () => {
    await store.writeSchema(OLD_SCHEMA);
    await store.writeRelationships([
      relationshipWrite(NOTE, "owner", OWNER),
      relationshipWrite(NOTE, "stale", STALE_VIEWER),
    ]);

    await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: DESIRED_SCHEMA,
    });

    expect(await store.readSchema()).not.toContain("relation stale");
    expect(
      await store.check({
        resource: NOTE,
        permission: "view",
        subject: OWNER,
      }),
    ).toBe(true);
    expect(
      await store.check({
        resource: NOTE,
        permission: "view",
        subject: STALE_VIEWER,
      }),
    ).toBe(false);
  });
});
