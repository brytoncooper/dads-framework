/**
 * What: the decorator counts the two read paths and changes nothing else.
 * Why: it sits in front of every permission decision in the system. If it
 * altered a verdict, swallowed a failure, or dropped an argument, it would
 * turn an observability change into an access-control change — the one
 * category of bug this codebase is least willing to ship. Each method is
 * checked for pass-through, and the counting is checked separately.
 */

import { describe, expect, it } from "vitest";

import { measureWork } from "@dads-framework/core/runtime/request-work";

import {
  Authorization,
  type PermissionQuery,
} from "@dads-framework/access/runtime";
import { TalliedAuthorization } from "./tallied-authorization.js";

/** Records what it was asked and answers whatever the test told it to. */
class RecordingAuthorization extends Authorization {
  readonly calls: { method: string; argument: unknown }[] = [];
  checkAnswer = true;
  failWith: Error | undefined = undefined;

  override check(query: unknown): Promise<boolean> {
    this.record("check", query);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(this.checkAnswer);
  }
  override lookupResources(query: unknown): Promise<readonly string[]> {
    this.record("lookupResources", query);
    return Promise.resolve(["order-1", "order-2"]);
  }
  override writeRelationships(writes: unknown): Promise<string> {
    this.record("writeRelationships", writes);
    return Promise.resolve("token-write");
  }
  override deleteRelationships(filter: unknown): Promise<string> {
    this.record("deleteRelationships", filter);
    return Promise.resolve("token-delete");
  }
  override relationshipExists(filter: unknown): Promise<boolean> {
    this.record("relationshipExists", filter);
    return Promise.resolve(true);
  }
  override listDirectSubjects(query: unknown): Promise<readonly never[]> {
    this.record("listDirectSubjects", query);
    return Promise.resolve([]);
  }

  private record(method: string, argument: unknown): void {
    this.calls.push({ method, argument });
  }
}

const permissionQuery = {
  subject: { type: "user", id: "user-1" },
  permission: "read",
  resource: { type: "order", id: "order-1" },
};

describe("TalliedAuthorization", () => {
  it("forwards a bulk check as one charged call and keeps ordered decisions", async () => {
    const queries = [
      permissionQuery,
      { ...permissionQuery, permission: "write" },
    ];
    const batches: (readonly PermissionQuery[])[] = [];
    const inner = Object.assign(new RecordingAuthorization(), {
      checkMany: (requested: readonly PermissionQuery[]) => {
        batches.push(requested);
        return Promise.resolve([true, false]);
      },
    });
    const authorization = new TalliedAuthorization(inner);

    const { result, tally } = await measureWork(() =>
      authorization.checkMany(queries),
    );

    expect(result).toEqual([true, false]);
    expect(batches).toEqual([queries]);
    expect(inner.calls).toEqual([]);
    expect(tally.authzCheckCount).toBe(1);
  });

  it("counts individual fallback checks when the inner implementation has no batching", async () => {
    const inner = new RecordingAuthorization();
    const authorization = new TalliedAuthorization(inner);

    const { result, tally } = await measureWork(() =>
      authorization.checkMany([permissionQuery, permissionQuery]),
    );

    expect(result).toEqual([true, true]);
    expect(inner.calls).toHaveLength(2);
    expect(tally.authzCheckCount).toBe(2);
  });

  it("charges a failed bulk call and propagates its failure", async () => {
    const failure = new Error("SpiceDB unavailable");
    const inner = Object.assign(new RecordingAuthorization(), {
      checkMany: () => Promise.reject(failure),
    });
    const authorization = new TalliedAuthorization(inner);

    const { tally } = await measureWork(async () => {
      await expect(authorization.checkMany([permissionQuery])).rejects.toBe(
        failure,
      );
    });

    expect(tally.authzCheckCount).toBe(1);
  });

  it("counts each check against the current request", async () => {
    const inner = new RecordingAuthorization();
    const authorization = new TalliedAuthorization(inner);

    const { tally } = await measureWork(async () => {
      await authorization.check(permissionQuery);
      await authorization.check(permissionQuery);
      await authorization.check(permissionQuery);
    });

    expect(tally.authzCheckCount).toBe(3);
  });

  it("counts a resource lookup as one call, not one per result", async () => {
    // `lookupResources` is the cure for per-row checking; counting it per row
    // would make the cheap shape look as expensive as the shape it replaces.
    const authorization = new TalliedAuthorization(
      new RecordingAuthorization(),
    );

    const { result, tally } = await measureWork(async () =>
      authorization.lookupResources({
        subject: { type: "user", id: "user-1" },
        permission: "read",
        resourceType: "order",
      }),
    );

    expect(result).toEqual(["order-1", "order-2"]);
    expect(tally.authzCheckCount).toBe(1);
  });

  it("returns the inner verdict unchanged, both ways", async () => {
    const inner = new RecordingAuthorization();
    const authorization = new TalliedAuthorization(inner);

    inner.checkAnswer = true;
    await expect(authorization.check(permissionQuery)).resolves.toBe(true);
    inner.checkAnswer = false;
    await expect(authorization.check(permissionQuery)).resolves.toBe(false);
  });

  it("charges a failed check and rethrows the original error", async () => {
    const inner = new RecordingAuthorization();
    inner.failWith = new Error("spicedb unavailable");
    const authorization = new TalliedAuthorization(inner);

    const { tally } = await measureWork(async () => {
      await expect(authorization.check(permissionQuery)).rejects.toBe(
        inner.failWith,
      );
    });

    expect(tally.authzCheckCount).toBe(1);
  });

  it("forwards every method with its argument untouched", async () => {
    const inner = new RecordingAuthorization();
    const authorization = new TalliedAuthorization(inner);
    const write = {
      resource: { type: "order", id: "order-1" },
      relation: "owner",
      subject: { type: "user", id: "user-1" },
    };
    const filter = { resourceType: "order", resourceId: "order-1" };
    const existence = {
      resourceType: "order",
      resourceId: "order-1",
      relation: "owner",
    };
    const direct = {
      resource: { type: "order", id: "order-1" },
      relation: "owner",
    };

    await authorization.writeRelationships([write]);
    await authorization.deleteRelationships(filter);
    await authorization.relationshipExists(existence);
    await authorization.listDirectSubjects(direct);

    expect(inner.calls).toEqual([
      { method: "writeRelationships", argument: [write] },
      { method: "deleteRelationships", argument: filter },
      { method: "relationshipExists", argument: existence },
      { method: "listDirectSubjects", argument: direct },
    ]);
  });

  it("does not count writes", async () => {
    // A write happens once per mutation; counting it would blur the per-row
    // read signal these columns exist to show.
    const authorization = new TalliedAuthorization(
      new RecordingAuthorization(),
    );

    const { tally } = await measureWork(async () => {
      await authorization.writeRelationships([]);
      await authorization.deleteRelationships({ resourceType: "order" });
      await authorization.relationshipExists({
        resourceType: "order",
        resourceId: "order-1",
        relation: "owner",
      });
    });

    expect(tally.authzCheckCount).toBe(0);
  });

  it("is inert outside a request", async () => {
    const authorization = new TalliedAuthorization(
      new RecordingAuthorization(),
    );

    await expect(authorization.check(permissionQuery)).resolves.toBe(true);
  });
});
