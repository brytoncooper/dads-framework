/**
 * What/why: the size guards must hold against the real vendor, not only the
 * fake: a caller who can see one more catalog row than the warning mark gets
 * every id back, and the request's tally carries the largest lookup and the
 * fault its row records. A record lookup is refused before SpiceDB is asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { measureWork } from "@dads-framework/core/runtime/request-work";

import { startTestSpiceDb, type TestSpiceDb } from "../../testing/start-test-spice-db.js";
import { relationshipWrite, type RelationshipWrite } from "@dads-framework/access/runtime";
import {
  DEFAULT_AUTHORIZATION_GUARD_MARKS,
  GuardedAuthorization,
  RecordLookupRefusedError,
} from "./guarded-authorization.js";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";
import { TalliedAuthorization } from "./tallied-authorization.js";

const SCHEMA = `
definition guardtest/user {}

definition guardtest/machine {
  relation viewer: guardtest/user
  permission view = viewer
}

definition guardtest/ticket {
  relation viewer: guardtest/user
  permission view = viewer
}
`;

const user = { type: "guardtest/user", id: "operator" };
const MACHINES = DEFAULT_AUTHORIZATION_GUARD_MARKS.warnLookupIds + 1;
const WRITE_BATCH = 500;

describe("GuardedAuthorization against SpiceDB (integration)", () => {
  let spiceDb: TestSpiceDb;
  let guarded: GuardedAuthorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();
    const vendor = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    await vendor.writeSchema(SCHEMA);
    const writes: RelationshipWrite[] = [];
    for (let index = 0; index < MACHINES; index += 1) {
      writes.push(relationshipWrite({ type: "guardtest/machine", id: `machine-${index}` }, "viewer", user));
    }
    for (let start = 0; start < writes.length; start += WRITE_BATCH) {
      await vendor.writeRelationships(writes.slice(start, start + WRITE_BATCH));
    }
    guarded = new GuardedAuthorization(new TalliedAuthorization(vendor), DEFAULT_AUTHORIZATION_GUARD_MARKS, {
      mayLookup: (resourceType) => resourceType === "guardtest/machine",
    });
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("returns every id past the warning mark and records the fault on the request", async () => {
    const { result, tally } = await measureWork(() =>
      guarded.lookupResources({
        subject: user,
        resourceType: "guardtest/machine",
        permission: "view",
      }),
    );
    expect(result).toHaveLength(MACHINES);
    expect(tally.authzCheckCount).toBe(1);
    expect(tally.authzLargestLookupCount).toBe(MACHINES);
    expect(tally.authzWarning).toEqual({
      type: "AuthorizationLookupOverWarningMark",
      fingerprint: "authz.lookup-size:guardtest/machine#view",
      detail: `lookupResources on guardtest/machine#view for a guardtest/user returned ${MACHINES} ids, over the 1000 mark (AUTHZ_LOOKUP_WARN_IDS)`,
    });
  });

  it("refuses a record lookup without asking SpiceDB", async () => {
    const { result, tally } = await measureWork(async () => {
      try {
        await guarded.lookupResources({
          subject: user,
          resourceType: "guardtest/ticket",
          permission: "view",
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(result).toBeInstanceOf(RecordLookupRefusedError);
    expect(tally.authzCheckCount).toBe(0);
  });
});
