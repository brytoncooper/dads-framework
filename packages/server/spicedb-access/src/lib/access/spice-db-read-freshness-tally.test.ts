/**
 * What: through the production chain (AnswerOnce → Tallied → SpiceDB), each
 * enforcement read that reaches SpiceDB is tallied as cached or fully
 * consistent — cached once the adapter holds a trusted token, fully consistent
 * before any write and always under `SPICEDB_CONSISTENCY=fully-consistent`.
 * Why: these two numbers are how an operator sees whether the cache is in use.
 * A count that disagreed with what was sent would hide a cache that is off.
 */

import { v1 } from "@authzed/authzed-node";
import { describe, expect, it } from "vitest";

import {
  answeringEachQuestionOnce,
  countAuthorizationReadFreshness,
} from "@dads-framework/core/runtime/request-work";
import { measureRequestWork } from "@dads-framework/core/runtime/request-work/testing";

import { AnswerOnceAuthorization } from "@dads-framework/access/runtime";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";
import { TalliedAuthorization } from "./tallied-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;

const SUBJECT = { type: "user", id: "reader" };
const RESOURCE = { type: "test/document", id: "document" };
const QUESTION = { subject: SUBJECT, resource: RESOURCE, permission: "view" };
const OTHER = { ...QUESTION, permission: "edit" };

function productionChain(
  consistency: "minimize-latency" | "fully-consistent" = "minimize-latency",
) {
  const unavailable = (): never => {
    throw new Error("Unexpected call in read freshness proof");
  };
  const client: SpiceDbClient = {
    promises: {
      checkPermission: () => Promise.resolve({ permissionship: 2 }),
      checkBulkPermissions: (request) =>
        Promise.resolve({
          pairs: request.items.map(() => ({
            response: { oneofKind: "item", item: { permissionship: 2 } },
          })),
        }),
      lookupResources: () => Promise.resolve([]),
      readRelationships: unavailable,
      writeRelationships: () =>
        Promise.resolve(
          v1.WriteRelationshipsResponse.create({
            writtenAt: { token: "after-write" },
          }),
        ),
      deleteRelationships: unavailable,
      readSchema: unavailable,
      writeSchema: unavailable,
    },
  };
  const spiceDb = new SpiceDbAuthorization(
    {
      endpoint: "localhost:50051",
      presharedKey: "test",
      insecure: true,
      consistency,
      onEnforcementRead: countAuthorizationReadFreshness,
    },
    client,
  );
  return new AnswerOnceAuthorization(new TalliedAuthorization(spiceDb));
}

/** One request: a check, a repeat, a bulk check with a repeat, a lookup. */
async function askEverything(
  authorization: AnswerOnceAuthorization,
): Promise<void> {
  await answeringEachQuestionOnce(async () => {
    await authorization.check(QUESTION);
    await authorization.check(QUESTION);
    await authorization.checkMany([QUESTION, OTHER, OTHER]);
    await authorization.lookupResources({
      subject: SUBJECT,
      resourceType: RESOURCE.type,
      permission: "view",
    });
  });
}

describe("cached versus fully consistent read tally", () => {
  it("tallies every read fully consistent before the adapter has written", async () => {
    const tally = await measureRequestWork(() =>
      askEverything(productionChain()),
    );
    // check, the bulk batch holding only OTHER, and the lookup.
    expect(tally).toMatchObject({
      authzCheckCount: 3,
      authzCachedReadCount: 0,
      authzFullyConsistentReadCount: 3,
    });
  });

  it("tallies every read cached once the adapter holds a trusted token", async () => {
    const authorization = productionChain();
    await authorization.writeRelationships([
      relationshipWrite(RESOURCE, "viewer", SUBJECT),
    ]);
    const tally = await measureRequestWork(() => askEverything(authorization));
    expect(tally).toMatchObject({
      authzCheckCount: 3,
      authzCachedReadCount: 3,
      authzFullyConsistentReadCount: 0,
    });
  });

  it("tallies every read fully consistent under SPICEDB_CONSISTENCY=fully-consistent", async () => {
    const authorization = productionChain("fully-consistent");
    await authorization.writeRelationships([
      relationshipWrite(RESOURCE, "viewer", SUBJECT),
    ]);
    const tally = await measureRequestWork(() => askEverything(authorization));
    expect(tally).toMatchObject({
      authzCheckCount: 3,
      authzCachedReadCount: 0,
      authzFullyConsistentReadCount: 3,
    });
  });
});
