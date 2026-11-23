// Removing a relation from the schema while tuples still use it blocks
// SpiceDB's schema write. Applying the smaller schema deletes exactly those
// leftover tuples, writes it, and leaves every other relationship alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startTestSpiceDb,
  type TestSpiceDb,
} from "../../testing/start-test-spice-db.js";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "../access/spice-db-authorization.js";
import { applyDesiredAuthorizationSchema } from "@dads-framework/access/schema";

/** The schema after the contraction: `legacy_reader` is gone. */
const CONTRACTED_SCHEMA = `definition user {}

definition example/team {
  relation member: user
  permission view = member
}

definition example/project {
  relation owner: example/team
  permission view = owner->view
}
`;

/** The live schema before it: the same, plus a relation tuples still use. */
const LIVE_SCHEMA = CONTRACTED_SCHEMA.replace(
  "  relation owner: example/team\n",
  "  relation owner: example/team\n  relation legacy_reader: example/team#member\n",
);

const TEAM = { type: "example/team", id: "core" };
const PROJECT = { type: "example/project", id: "launch" };
const MEMBER = { type: "user", id: "alice" };

describe("contracting a relation that still has tuples (SpiceDB)", () => {
  let spiceDb: TestSpiceDb;
  let store: SpiceDbAuthorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();
    store = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("deletes the leftover tuples, writes the schema, and keeps every other relationship", async () => {
    expect(LIVE_SCHEMA).toContain("legacy_reader");
    await store.writeSchema(LIVE_SCHEMA);
    await store.writeRelationships([
      relationshipWrite(TEAM, "member", MEMBER),
      relationshipWrite(PROJECT, "owner", TEAM),
      relationshipWrite(PROJECT, "legacy_reader", {
        type: TEAM.type,
        id: TEAM.id,
        relation: "member",
      }),
    ]);

    await applyDesiredAuthorizationSchema({
      store,
      desiredSchema: CONTRACTED_SCHEMA,
    });

    expect(await store.readSchema()).not.toContain("legacy_reader");
    expect(
      await store.relationshipExists({
        resourceType: PROJECT.type,
        resourceId: PROJECT.id,
        relation: "owner",
      }),
    ).toBe(true);
    await expect(
      store.relationshipExists({
        resourceType: PROJECT.type,
        resourceId: PROJECT.id,
        relation: "legacy_reader",
      }),
    ).rejects.toThrow(/legacy_reader/);
  });
});
