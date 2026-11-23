// Inspect actual adapter RPC requests: revocation freshness must not depend on
// clock timing, caller tokens, or the configurable display-read consistency.
import { describe, expect, it } from "vitest";
import { runWithAuthorizationConsistency } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;
const SUBJECT = { type: "user", id: "reader" };
const RESOURCE = { type: "test/document", id: "document" };
const CURRENT = {
  requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
};

function recordingClient() {
  const reads: { operation: string; consistency: unknown }[] = [];
  const unavailable = (): never => {
    throw new Error("Unexpected write in read-consistency proof");
  };
  const client: SpiceDbClient = {
    promises: {
      checkPermission: (request) => {
        reads.push({ operation: "check", consistency: request.consistency });
        return Promise.resolve({ permissionship: 1 });
      },
      lookupResources: (request) => {
        reads.push({ operation: "lookup", consistency: request.consistency });
        return Promise.resolve([]);
      },
      readRelationships: (request) => {
        reads.push({ operation: "display", consistency: request.consistency });
        return Promise.resolve([]);
      },
      writeRelationships: unavailable,
      deleteRelationships: unavailable,
      readSchema: unavailable,
      writeSchema: unavailable,
    },
  };
  const authorization = new SpiceDbAuthorization(
    {
      endpoint: "localhost:50051",
      presharedKey: "test",
      insecure: true,
      consistency: "minimize-latency",
    },
    client,
  );
  return { authorization, reads };
}

describe("SpiceDB enforcement consistency", () => {
  it.each([
    { name: "without tokens", queryToken: undefined, requestToken: undefined },
    {
      name: "with stale caller token",
      queryToken: "old-query",
      requestToken: undefined,
    },
    {
      name: "with stale request cookie",
      queryToken: undefined,
      requestToken: "old-cookie",
    },
    {
      name: "with both stale tokens",
      queryToken: "old-query",
      requestToken: "old-cookie",
    },
  ])(
    "always requests current check and lookup $name",
    async ({ queryToken, requestToken }) => {
      const { authorization, reads } = recordingClient();
      const consistency =
        queryToken === undefined ? {} : { consistencyToken: queryToken };
      await runWithAuthorizationConsistency(requestToken, async () => {
        await authorization.check({
          subject: SUBJECT,
          resource: RESOURCE,
          permission: "view",
          ...consistency,
        });
        await authorization.lookupResources({
          subject: SUBJECT,
          resourceType: RESOURCE.type,
          permission: "view",
          ...consistency,
        });
      });
      expect(reads).toEqual([
        { operation: "check", consistency: CURRENT },
        { operation: "lookup", consistency: CURRENT },
      ]);
    },
  );

  it("keeps direct-subject display reads configurable and guard reads current", async () => {
    const { authorization, reads } = recordingClient();
    const query = { resource: RESOURCE, relation: "viewer" };
    await authorization.listDirectSubjects(query);
    await authorization.listDirectSubjects({
      ...query,
      consistencyToken: "display-token",
    });
    await authorization.listDirectSubjects({
      ...query,
      consistency: "fully-consistent",
      consistencyToken: "old-guard-token",
    });
    expect(reads).toEqual([
      { operation: "display", consistency: undefined },
      {
        operation: "display",
        consistency: {
          requirement: {
            oneofKind: "atLeastAsFresh",
            atLeastAsFresh: { token: "display-token" },
          },
        },
      },
      { operation: "display", consistency: CURRENT },
    ]);
  });
});
