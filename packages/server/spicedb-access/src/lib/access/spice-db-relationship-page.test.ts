/** Migration inspection must be bounded, current, resumable, and refuse malformed vendor facts. */
import { v1 } from "@authzed/authzed-node";
import { describe, expect, it } from "vitest";

import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type Client = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;
type Read = Client["promises"]["readRelationships"];

function adapter(
  read: Read,
  remove?: Client["promises"]["deleteRelationships"],
) {
  const unavailable = (): never => {
    throw new Error("Unexpected operation");
  };
  return new SpiceDbAuthorization(
    { endpoint: "localhost:50051", presharedKey: "test", insecure: true },
    {
      promises: {
        readRelationships: read,
        checkPermission: unavailable,
        lookupResources: unavailable,
        writeRelationships: unavailable,
        deleteRelationships: remove ?? unavailable,
        readSchema: unavailable,
        writeSchema: unavailable,
      },
    },
  );
}

describe("readRelationshipPage", () => {
  it.each([undefined, "member"])(
    "exact deletion explicitly selects subject relation %s",
    async (relation) => {
      const requests: Parameters<
        Client["promises"]["deleteRelationships"]
      >[0][] = [];
      const store = adapter(
        () => Promise.resolve([]),
        (request) => {
          requests.push(request);
          return Promise.resolve(
            v1.DeleteRelationshipsResponse.create({
              deletedAt: { token: "deleted" },
            }),
          );
        },
      );
      await expect(
        store.deleteExactRelationship({
          resource: { type: "test/document", id: "one" },
          relation: "viewer",
          subject: {
            type: "test/group",
            id: "team",
            ...(relation === undefined ? {} : { relation }),
          },
        }),
      ).resolves.toBe("deleted");
      expect(requests[0]?.relationshipFilter).toMatchObject({
        resourceType: "test/document",
        optionalResourceId: "one",
        optionalRelation: "viewer",
        optionalSubjectFilter: {
          subjectType: "test/group",
          optionalSubjectId: "team",
          optionalRelation: { relation: relation ?? "" },
        },
      });
    },
  );
  it("passes a bounded current read and opaque resume cursor", async () => {
    const requests: Parameters<Read>[0][] = [];
    const store = adapter((request) => {
      requests.push(request);
      return Promise.resolve([]);
    });
    await expect(
      store.readRelationshipPage({
        resourceType: "test/document",
        cursor: "opaque",
      }),
    ).resolves.toEqual({ relationships: [], nextCursor: null });
    expect(requests).toMatchObject([
      {
        optionalLimit: 1000,
        optionalCursor: { token: "opaque" },
        relationshipFilter: {
          resourceType: "test/document",
        },
        consistency: {
          requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
        },
      },
    ]);
  });

  it("preserves usersets and resumes after the last fact", async () => {
    const store = adapter(() =>
      Promise.resolve([
        {
          relationship: {
            resource: { objectType: "test/document", objectId: "one" },
            relation: "viewer",
            subject: {
              object: { objectType: "test/group", objectId: "team" },
              optionalRelation: "member",
            },
          },
          afterResultCursor: { token: "after-one" },
        },
      ]),
    );
    await expect(
      store.readRelationshipPage({ resourceType: "test/document" }),
    ).resolves.toEqual({
      relationships: [
        {
          resource: { type: "test/document", id: "one" },
          relation: "viewer",
          subject: { type: "test/group", id: "team", relation: "member" },
        },
      ],
      nextCursor: "after-one",
    });
  });

  it("fails instead of silently discarding an incomplete fact", async () => {
    const store = adapter(() =>
      Promise.resolve([{ afterResultCursor: { token: "invalid" } }]),
    );
    await expect(
      store.readRelationshipPage({ resourceType: "test/document" }),
    ).rejects.toThrow("Incomplete relationship");
  });
});
