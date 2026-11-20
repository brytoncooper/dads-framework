import { describe, expect, it } from "vitest";

import { measureWork } from "@dads-framework/request-work";

import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;
type BulkCheck = NonNullable<SpiceDbClient["promises"]["checkBulkPermissions"]>;
type BulkRequest = Parameters<BulkCheck>[0];
type BulkResponse = Awaited<ReturnType<BulkCheck>>;

const SUBJECT = { type: "user", id: "reader", relation: "member" };
const QUERIES = Array.from({ length: 5 }, (_, index) => ({
  subject: SUBJECT,
  resource: { type: "test/document", id: `document-${index}` },
  permission: "view",
  consistencyToken: "stale-token",
}));

function adapter(
  checkBulkPermissions: BulkCheck,
  onCheckItemError?: (error: Error) => void,
) {
  const unavailable = (): never => {
    throw new Error("Unexpected individual authorization call");
  };
  return new SpiceDbAuthorization(
    {
      endpoint: "localhost:50051",
      presharedKey: "test",
      insecure: true,
      consistency: "minimize-latency",
      ...(onCheckItemError === undefined ? {} : { onCheckItemError }),
    },
    {
      promises: {
        checkBulkPermissions,
        checkPermission: unavailable,
        lookupResources: unavailable,
        readRelationships: unavailable,
        writeRelationships: unavailable,
        deleteRelationships: unavailable,
        readSchema: unavailable,
        writeSchema: unavailable,
      },
    },
  );
}

describe("SpiceDB bulk permission checks", () => {
  it("asks one current batch and denies denied, conditional, erroneous and missing answers in order", async () => {
    const requests: BulkRequest[] = [];
    const pairs: BulkResponse["pairs"] = [
      { response: { oneofKind: "item", item: { permissionship: 2 } } },
      { response: { oneofKind: "item", item: { permissionship: 1 } } },
      { response: { oneofKind: "item", item: { permissionship: 3 } } },
      {
        response: {
          oneofKind: "error",
          error: { code: 13, message: "unavailable", details: [] },
        },
      },
    ];
    const authorization = adapter((request): Promise<BulkResponse> => {
      requests.push(request);
      return Promise.resolve({ pairs });
    });

    await expect(authorization.checkMany(QUERIES)).resolves.toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(requests).toEqual([
      {
        consistency: {
          requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
        },
        items: QUERIES.map((query) => ({
          resource: {
            objectType: query.resource.type,
            objectId: query.resource.id,
          },
          subject: {
            object: { objectType: SUBJECT.type, objectId: SUBJECT.id },
            optionalRelation: SUBJECT.relation,
          },
          permission: query.permission,
        })),
        withTracing: false,
      },
    ]);
  });

  it("does not call SpiceDB for an empty batch", async () => {
    const authorization = adapter(() => {
      throw new Error("Empty permission batch reached SpiceDB");
    });
    await expect(authorization.checkMany([])).resolves.toEqual([]);
  });

  it("limits each RPC to 128 checks", async () => {
    const sizes: number[] = [];
    const authorization = adapter((request): Promise<BulkResponse> => {
      sizes.push(request.items.length);
      return Promise.resolve({
        pairs: request.items.map(() => ({
          response: { oneofKind: "item", item: { permissionship: 2 } },
        })),
      });
    });
    const queries = Array.from({ length: 257 }, (_, index) => ({
      subject: SUBJECT,
      resource: { type: "test/document", id: `document-${index}` },
      permission: "view",
    }));

    await expect(authorization.checkMany(queries)).resolves.toEqual(
      queries.map(() => true),
    );
    expect(sizes).toEqual([128, 128, 1]);
  });

  it("propagates a failed batch without granting any item", async () => {
    const failure = new Error("SpiceDB unavailable");
    const authorization = adapter(() => Promise.reject(failure));
    await expect(authorization.checkMany(QUERIES)).rejects.toBe(failure);
  });
});

describe("SpiceDB bulk item errors", () => {
  /** One allowed answer, one item error, and no answer at all for the third. */
  const answersWithErrors: BulkCheck = () =>
    Promise.resolve({
      pairs: [
        { response: { oneofKind: "item", item: { permissionship: 2 } } },
        {
          response: {
            oneofKind: "error",
            error: { code: 14, message: "unavailable", details: [] },
          },
        },
      ],
    });
  const asked = QUERIES.slice(0, 3);

  it("gives each errored or unanswered item to checkEach's caller as a failure, and logs each", async () => {
    const logged: Error[] = [];
    const authorization = adapter(answersWithErrors, (error) =>
      logged.push(error),
    );

    const outcomes = await authorization.checkEach(asked);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "answered",
      "failed",
      "failed",
    ]);
    expect(outcomes[0]).toEqual({ kind: "answered", allowed: true });
    expect(logged.map((error) => error.message)).toEqual([
      "SpiceDB could not answer view on test/document for a user in a bulk check (code 14): unavailable",
      "SpiceDB returned no answer for view on test/document for a user in a bulk check",
    ]);
  });

  it("denies checkMany's errored items, logs each and notes the request without an id", async () => {
    const logged: Error[] = [];
    const authorization = adapter(answersWithErrors, (error) =>
      logged.push(error),
    );

    const { result, tally } = await measureWork(() =>
      authorization.checkMany(asked),
    );

    expect(result).toEqual([true, false, false]);
    expect(logged).toHaveLength(2);
    expect(tally.authzWarning).toEqual({
      type: "AuthorizationBulkItemErrorDenied",
      fingerprint: "authz.bulk-item-error",
      detail:
        "SpiceDB answered view on test/document with an error in a bulk check; denied",
    });
  });
});
