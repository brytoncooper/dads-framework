/**
 * What: checks, bulk checks and lookups are `at_least_as_fresh` than the
 * adapter's newest write; fully consistent before any write, after a failed
 * write, after a schema write, and always under `fully-consistent`. Writes
 * run one at a time, so concurrent callers still leave a trusted token.
 * Why: the token decides which revocations an enforcement read can miss.
 * Sending an older token than the newest write would let SpiceDB answer from
 * a snapshot taken before a revocation this process already committed.
 */

import { v1 } from "@authzed/authzed-node";
import { describe, expect, it } from "vitest";

import {
  type PermissionQuery,
  relationshipWrite,
} from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;
type WriteResponse = Awaited<
  ReturnType<SpiceDbClient["promises"]["writeRelationships"]>
>;

const SUBJECT = { type: "user", id: "reader" };
const RESOURCE = { type: "test/document", id: "document" };
const CURRENT = {
  requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
};
const GRANT = relationshipWrite(RESOURCE, "viewer", SUBJECT);

function atLeastAsFresh(token: string) {
  return {
    requirement: { oneofKind: "atLeastAsFresh", atLeastAsFresh: { token } },
  };
}

type Pending = {
  readonly resolve: (token: string) => void;
  readonly reject: (error: Error) => void;
};

/** A client whose writes finish only when the test says so, in any order. */
function controlledClient(
  consistency: "minimize-latency" | "fully-consistent" = "minimize-latency",
) {
  const reads: unknown[] = [];
  const pending: Pending[] = [];
  const write = (): Promise<WriteResponse> =>
    new Promise((resolve, reject) => {
      pending.push({
        resolve: (token) => {
          resolve({ writtenAt: { token } });
        },
        reject,
      });
    });
  const client: SpiceDbClient = {
    promises: {
      checkPermission: (request) => {
        reads.push(request.consistency);
        return Promise.resolve({ permissionship: 2 });
      },
      checkBulkPermissions: (request) => {
        reads.push(request.consistency);
        return Promise.resolve({ pairs: [] });
      },
      lookupResources: (request) => {
        reads.push(request.consistency);
        return Promise.resolve([]);
      },
      readRelationships: (request) => {
        reads.push(request.consistency);
        return Promise.resolve([]);
      },
      writeRelationships: write,
      deleteRelationships: () =>
        new Promise((resolve, reject) => {
          pending.push({
            resolve: (token) => {
              resolve(
                v1.DeleteRelationshipsResponse.create({
                  deletedAt: { token },
                }),
              );
            },
            reject,
          });
        }),
      readSchema: () => Promise.resolve({ schemaText: "" }),
      writeSchema: () => Promise.resolve({}),
    },
  };
  const authorization = new SpiceDbAuthorization(
    {
      endpoint: "localhost:50051",
      presharedKey: "test",
      insecure: true,
      consistency,
    },
    client,
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Lets queued writes reach the client, then finishes write `index`. */
  async function finish(index: number, token: string): Promise<void> {
    await settle();
    pending[index]?.resolve(token);
    await settle();
  }
  async function fail(index: number, error: Error): Promise<void> {
    await settle();
    pending[index]?.reject(error);
    await settle();
  }
  async function enforce(): Promise<unknown[]> {
    reads.length = 0;
    await authorization.check({
      subject: SUBJECT,
      resource: RESOURCE,
      permission: "view",
    });
    await authorization.checkMany([
      { subject: SUBJECT, resource: RESOURCE, permission: "view" },
    ]);
    await authorization.lookupResources({
      subject: SUBJECT,
      resourceType: RESOURCE.type,
      permission: "view",
    });
    return [...reads];
  }
  return { authorization, pending, settle, finish, fail, enforce, reads };
}

describe("SpiceDB enforcement reads after the adapter's own writes", () => {
  it("reads fully consistent before the adapter has written anything", async () => {
    const { enforce } = controlledClient();
    expect(await enforce()).toEqual([CURRENT, CURRENT, CURRENT]);
  });

  it("reads a check or batch asked fully consistent past the newest write's token", async () => {
    const { authorization, finish, reads } = controlledClient();
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await grant;
    reads.length = 0;

    const query: PermissionQuery = {
      subject: SUBJECT,
      resource: RESOURCE,
      permission: "view",
      consistency: "fully-consistent",
    };
    await authorization.check(query);
    await authorization.checkMany([
      { subject: SUBJECT, resource: RESOURCE, permission: "view" },
      query,
    ]);
    await authorization.check({
      subject: SUBJECT,
      resource: RESOURCE,
      permission: "view",
    });

    expect(reads).toEqual([CURRENT, CURRENT, atLeastAsFresh("after-grant")]);
  });

  it("reads at least as fresh as the newest write once one finished", async () => {
    const { authorization, finish, enforce } = controlledClient();
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await expect(grant).resolves.toBe("after-grant");
    expect(await enforce()).toEqual(
      Array(3).fill(atLeastAsFresh("after-grant")),
    );

    const revoke = authorization.deleteRelationships({
      resourceType: RESOURCE.type,
      resourceId: RESOURCE.id,
    });
    await finish(1, "after-revoke");
    await revoke;
    expect(await enforce()).toEqual(
      Array(3).fill(atLeastAsFresh("after-revoke")),
    );
  });

  it("runs concurrent writes one at a time, in order, and holds the last one's token", async () => {
    const { authorization, pending, settle, finish, enforce } =
      controlledClient();
    const finished: string[] = [];
    const writes = ["first", "second", "third", "fourth"].map((name, index) =>
      (index % 2 === 0
        ? authorization.writeRelationships([GRANT])
        : authorization.deleteExactRelationship(GRANT)
      ).then((token) => {
        finished.push(name);
        return token;
      }),
    );
    for (const [index, name] of [
      "first",
      "second",
      "third",
      "fourth",
    ].entries()) {
      // The next write has not been sent until the one before it settled.
      await settle();
      expect(pending).toHaveLength(index + 1);
      await finish(index, name);
    }
    await expect(Promise.all(writes)).resolves.toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
    expect(finished).toEqual(["first", "second", "third", "fourth"]);
    expect(await enforce()).toEqual(Array(3).fill(atLeastAsFresh("fourth")));
  });

  it("queues a write behind a failed one and trusts it once it succeeds", async () => {
    const { authorization, fail, finish, enforce } = controlledClient();
    const failed = expect(
      authorization.writeRelationships([GRANT]),
    ).rejects.toThrow("deadline exceeded");
    const next = authorization.writeRelationships([GRANT]);
    await fail(0, new Error("deadline exceeded"));
    await failed;
    await finish(1, "after-failure");
    await expect(next).resolves.toBe("after-failure");
    expect(await enforce()).toEqual(
      Array(3).fill(atLeastAsFresh("after-failure")),
    );
  });

  it("reads fully consistent after a failed write, which may still have committed", async () => {
    const { authorization, fail, finish, enforce } = controlledClient();
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await grant;
    const failed = expect(
      authorization.writeRelationships([GRANT]),
    ).rejects.toThrow("deadline exceeded");
    await fail(1, new Error("deadline exceeded"));
    await failed;
    expect(await enforce()).toEqual([CURRENT, CURRENT, CURRENT]);
  });

  it("reads fully consistent after a schema write", async () => {
    const { authorization, finish, enforce } = controlledClient();
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await grant;
    await authorization.writeSchema("definition user {}");
    expect(await enforce()).toEqual([CURRENT, CURRENT, CURRENT]);
  });

  it("forces full consistency under SPICEDB_CONSISTENCY=fully-consistent", async () => {
    const { authorization, finish, enforce } =
      controlledClient("fully-consistent");
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await grant;
    expect(await enforce()).toEqual([CURRENT, CURRENT, CURRENT]);
  });

  it("keeps correctness-guard roster reads fully consistent after a write", async () => {
    const { authorization, finish, reads } = controlledClient();
    const grant = authorization.writeRelationships([GRANT]);
    await finish(0, "after-grant");
    await grant;
    reads.length = 0;
    await authorization.listDirectSubjects({
      resource: RESOURCE,
      relation: "admin",
      consistency: "fully-consistent",
    });
    expect(reads).toEqual([CURRENT]);
  });
});
