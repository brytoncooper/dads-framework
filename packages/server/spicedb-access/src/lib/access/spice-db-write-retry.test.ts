// A write that lost a race inside SpiceDB is retried; a write SpiceDB refused
// is not. Without the retry, three workspaces created at once could each lose
// an ownership fact and answer 201 for a workspace nobody can reach.
import { describe, expect, it } from "vitest";

import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;

const FACT = {
  resource: { type: "organizations/workspace", id: "north-terminal" },
  relation: "parent_platform",
  subject: { type: "platform", id: "app" },
};

/** The shape grpc-js rejects with: an Error carrying a numeric status code. */
function grpcError(code: number, details: string): Error {
  return Object.assign(new Error(`${code} ${details}`), { code, details });
}

const SERIALIZATION_CONFLICT = grpcError(
  4,
  "serialization max retries exceeded; please reduce your parallel writes",
);

function clientFailingWith(failures: readonly Error[]) {
  const calls = { write: 0, delete: 0 };
  const respond = <T>(answer: T): Promise<T> => {
    const failure = failures[calls.write + calls.delete - 1];
    return failure === undefined
      ? Promise.resolve(answer)
      : Promise.reject(failure);
  };
  const unexpected = (): never => {
    throw new Error("Unexpected call in write-retry proof");
  };
  const client: SpiceDbClient = {
    promises: {
      writeRelationships: () => {
        calls.write += 1;
        return respond({ writtenAt: { token: "written" } });
      },
      deleteRelationships: () => {
        calls.delete += 1;
        return respond({
          deletedAt: { token: "deleted" },
          deletionProgress: 0,
          relationshipsDeletedCount: "0",
        });
      },
      checkPermission: unexpected,
      lookupResources: unexpected,
      readRelationships: unexpected,
      readSchema: unexpected,
      writeSchema: unexpected,
    },
  };
  const authorization = new SpiceDbAuthorization(
    { endpoint: "localhost:50051", presharedKey: "test", insecure: true },
    client,
  );
  return { authorization, calls };
}

describe("SpiceDB write retry", () => {
  it("retries a write that lost a serialization race, then succeeds", async () => {
    const { authorization, calls } = clientFailingWith([
      SERIALIZATION_CONFLICT,
      SERIALIZATION_CONFLICT,
    ]);

    await expect(authorization.writeRelationships([FACT])).resolves.toBe(
      "written",
    );
    expect(calls.write).toBe(3);
  });

  it.each([
    { name: "aborted", error: grpcError(10, "transaction aborted") },
    { name: "unavailable", error: grpcError(14, "connection reset") },
  ])("retries a $name write", async ({ error }) => {
    const { authorization, calls } = clientFailingWith([error]);

    await authorization.writeRelationships([FACT]);
    expect(calls.write).toBe(2);
  });

  it("retries a delete that lost a serialization race", async () => {
    const { authorization, calls } = clientFailingWith([
      SERIALIZATION_CONFLICT,
    ]);

    await expect(
      authorization.deleteRelationships({
        resourceType: FACT.resource.type,
        resourceId: FACT.resource.id,
      }),
    ).resolves.toBe("deleted");
    expect(calls.delete).toBe(2);
  });

  it("does not retry a write SpiceDB refused", async () => {
    const refused = grpcError(
      9,
      "object definition `sample_requests/terminal` not found",
    );
    const { authorization, calls } = clientFailingWith([refused]);

    await expect(authorization.writeRelationships([FACT])).rejects.toBe(
      refused,
    );
    expect(calls.write).toBe(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { authorization, calls } = clientFailingWith(
      Array.from({ length: 10 }, () => SERIALIZATION_CONFLICT),
    );

    await expect(authorization.writeRelationships([FACT])).rejects.toBe(
      SERIALIZATION_CONFLICT,
    );
    expect(calls.write).toBe(4);
  });
});
