// Real graph regression: another adapter revokes warmed authority. Old caller
// and request tokens cannot preserve check or discovery after that graph write.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestSpiceDb,
  type TestSpiceDb,
} from "../../testing/start-test-spice-db.js";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { runWithAuthorizationConsistency } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

const SCHEMA = `
definition user {}
definition test/current_document {
  relation viewer: user
  permission view = viewer
}
`;

describe("current enforcement after remote graph revocation", () => {
  let spiceDb: TestSpiceDb;
  let reader: SpiceDbAuthorization;
  let otherWriter: SpiceDbAuthorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();
    const options = {
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
    };
    reader = new SpiceDbAuthorization({
      ...options,
      consistency: "minimize-latency",
    });
    otherWriter = new SpiceDbAuthorization(options);
    await otherWriter.writeSchema(SCHEMA);
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it.each(["no-token", "old-query-token", "old-cookie-token"])(
    "denies warmed access after another adapter revokes with %s",
    async (mode) => {
      const subject = { type: "user", id: mode };
      const resource = {
        type: "test/current_document",
        id: `${mode}-document`,
      };
      const oldToken = await otherWriter.writeRelationships([
        relationshipWrite(resource, "viewer", subject),
      ]);
      await expect(
        reader.check({
          subject,
          resource,
          permission: "view",
          consistencyToken: oldToken,
        }),
      ).resolves.toBe(true);
      await expect(
        reader.lookupResources({
          subject,
          resourceType: resource.type,
          permission: "view",
          consistencyToken: oldToken,
        }),
      ).resolves.toEqual([resource.id]);

      // No revocation token is forwarded to the reader and no sleep helps it.
      await otherWriter.deleteRelationships({
        resourceType: resource.type,
        resourceId: resource.id,
        relation: "viewer",
        subject,
      });
      const query =
        mode === "old-query-token" ? { consistencyToken: oldToken } : {};
      const cookie = mode === "old-cookie-token" ? oldToken : undefined;
      await runWithAuthorizationConsistency(cookie, async () => {
        await expect(
          reader.check({ subject, resource, permission: "view", ...query }),
        ).resolves.toBe(false);
        await expect(
          reader.lookupResources({
            subject,
            resourceType: resource.type,
            permission: "view",
            ...query,
          }),
        ).resolves.toEqual([]);
      });
    },
  );
});

// The cached-read posture: one adapter writes, then enforces at least as fresh
// as its own newest write. Grants and revocations it made are visible at once.
describe("enforcement at least as fresh as the adapter's own newest write", () => {
  let spiceDb: TestSpiceDb;
  let server: SpiceDbAuthorization;

  beforeAll(async () => {
    spiceDb = await startTestSpiceDb();
    server = new SpiceDbAuthorization({
      endpoint: spiceDb.endpoint,
      presharedKey: spiceDb.presharedKey,
      insecure: true,
      consistency: "minimize-latency",
    });
    await server.writeSchema(SCHEMA);
  }, 120_000);

  afterAll(async () => {
    await spiceDb.stop();
  });

  it("sees its own grant and then its own revocation immediately, warmed or not", async () => {
    const subject = { type: "user", id: "own-writes" };
    const resource = { type: "test/current_document", id: "own-writes-doc" };
    const lookup = {
      subject,
      resourceType: resource.type,
      permission: "view",
    };
    // Grant, warm SpiceDB's cache with the allowed answer, then revoke.
    await server.writeRelationships([
      relationshipWrite(resource, "viewer", subject),
    ]);
    for (let warm = 0; warm < 3; warm += 1) {
      await expect(
        server.check({ subject, resource, permission: "view" }),
      ).resolves.toBe(true);
      await expect(server.lookupResources(lookup)).resolves.toEqual([
        resource.id,
      ]);
    }

    await server.deleteRelationships({
      resourceType: resource.type,
      resourceId: resource.id,
      relation: "viewer",
      subject,
    });
    await expect(
      server.check({ subject, resource, permission: "view" }),
    ).resolves.toBe(false);
    await expect(server.lookupResources(lookup)).resolves.toEqual([]);

    await server.writeRelationships([
      relationshipWrite(resource, "viewer", subject),
    ]);
    await expect(
      server.check({ subject, resource, permission: "view" }),
    ).resolves.toBe(true);
    await expect(server.lookupResources(lookup)).resolves.toEqual([
      resource.id,
    ]);
  });
});
