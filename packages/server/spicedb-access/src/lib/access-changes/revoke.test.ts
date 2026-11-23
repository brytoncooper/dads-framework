/**
 * The write-through revocation pair: access is removed NOW and the removal is
 * recorded so it cannot be lost. The case that matters most is the one where
 * the graph is unreachable — the operation must still SUCCEED, because by then
 * the durable row already exists (commitment 2).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { FakeEnqueueAccessChanges } from "../../testing/fake-enqueue.js";
import {
  relationshipWrite,
  type RelationshipFilter,
} from "@dads-framework/access/runtime";
import { outboxKeyForRelationship } from "./enqueue.js";
import { deleteRelationshipsNow, revokeAccess } from "./revoke.js";

const ORG_TYPE = "organizations/organization";
const WORKSPACE_TYPE = "organizations/workspace";
const ORG_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e01";
const USER_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e02";
const PERMISSIONS = {
  [ORG_TYPE]: { view: ["admin", "member"], manage: ["admin"] },
  [WORKSPACE_TYPE]: { view: ["owner", "admin"], manage: ["owner"] },
};

const MEMBERSHIP = relationshipWrite({ type: ORG_TYPE, id: ORG_ID }, "member", {
  type: "user",
  id: USER_ID,
});

/** An authorization whose synchronous delete always fails. */
class UnreachableGraph extends FakeAuthorization {
  override deleteRelationships(): Promise<never> {
    return Promise.reject(new Error("spicedb unreachable"));
  }
}

class RecordingLog {
  readonly warnings: object[] = [];
  warn(value: object): void {
    this.warnings.push(value);
  }
}

describe("deleteRelationshipsNow", () => {
  it("swallows and reports a graph failure after facts are already durable", async () => {
    const log = new RecordingLog();
    await expect(
      deleteRelationshipsNow({
        authorization: new UnreachableGraph(PERMISSIONS),
        relationships: [MEMBERSHIP],
        committedFactCause: "membership-event-1",
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toMatchObject({
      resourceType: ORG_TYPE,
      resourceId: ORG_ID,
      cause: "membership-event-1",
    });
  });
});

describe("revokeAccess", () => {
  it("removes the tuple synchronously — a revocation never waits for a projector", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();
    await authorization.writeRelationships([MEMBERSHIP]);
    const canView = () =>
      authorization.check({
        subject: { type: "user", id: USER_ID },
        permission: "view",
        resource: { type: ORG_TYPE, id: ORG_ID },
      });

    // Access EXISTED first. Without this the test passes against a world
    // where the member never had access at all, which is the one result that
    // would make "the revocation worked" meaningless.
    await expect(canView()).resolves.toBe(true);

    await revokeAccess({
      authorization,
      outbox,
      relationships: [MEMBERSHIP],
      cause: "membership-1",
    });

    await expect(canView()).resolves.toBe(false);
  });

  it("records the removal as a DELETE fact keyed on its cause", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();

    await revokeAccess({
      authorization,
      outbox,
      relationships: [MEMBERSHIP],
      cause: "membership-1",
      ownerPartitionId: ORG_ID,
    });

    expect(outbox.enqueued).toHaveLength(1);
    expect(outbox.enqueued[0]).toMatchObject({
      operation: "DELETE",
      relationship: MEMBERSHIP,
      ownerPartitionId: ORG_ID,
    });
    // The WHOLE key, not a substring of it. `toContain("membership-1")` is
    // satisfied by any key that merely mentions the cause — including one
    // built for the wrong operation, resource, or subject.
    expect(outbox.enqueued[0]?.idempotencyKey).toBe(
      outboxKeyForRelationship("DELETE", MEMBERSHIP, "membership-1"),
    );
  });

  it("SUCCEEDS when the synchronous delete throws — the row is the guarantee", async () => {
    const authorization = new UnreachableGraph(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();

    await expect(
      revokeAccess({
        authorization,
        outbox,
        relationships: [MEMBERSHIP],
        cause: "membership-1",
      }),
    ).resolves.toBeUndefined();

    expect(outbox.enqueued).toHaveLength(1);
  });

  it("reports the failed removal — swallowed must not mean silent", async () => {
    const authorization = new UnreachableGraph(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();
    const warn = vi.fn();

    await revokeAccess({
      authorization,
      outbox,
      relationships: [MEMBERSHIP],
      cause: "membership-1",
      log: { warn },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      resourceType: ORG_TYPE,
      resourceId: ORG_ID,
      cause: "membership-1",
    });
  });

  it("FAILS when the durable record cannot be written, having removed nothing", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();
    outbox.failNext = true;
    await authorization.writeRelationships([MEMBERSHIP]);

    await expect(
      revokeAccess({
        authorization,
        outbox,
        relationships: [MEMBERSHIP],
        cause: "membership-1",
      }),
    ).rejects.toThrow("outbox unavailable");

    await expect(
      authorization.relationshipExists({
        resourceType: ORG_TYPE,
        resourceId: ORG_ID,
        relation: "member",
      }),
    ).resolves.toBe(true);
  });

  /**
   * KEY STABILITY, which is all a fake can show: the same cause produces the
   * same key twice, so the two revocations are one logical fact.
   *
   * The DEDUPE itself is a Postgres property — `onConflictDoNothing` on
   * `idempotency_key` — and lives in
   * `database/drizzle-authorization-outbox.integration.test.ts`
   * ("re-enqueuing the same fact is a no-op, not a failed transaction", with
   * "a different cause for the same tuple is a different fact" as its other
   * half). `FakeEnqueueAccessChanges` reproduces that behavior; it does not
   * prove it.
   */
  it("derives the same key when the same cause is revoked twice", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();

    const input = {
      authorization,
      outbox,
      relationships: [MEMBERSHIP],
      cause: "membership-1",
    };
    await revokeAccess(input);
    await revokeAccess(input);

    expect(outbox.enqueued).toHaveLength(1);
    expect(outbox.enqueued[0]?.idempotencyKey).toBe(
      outboxKeyForRelationship("DELETE", MEMBERSHIP, "membership-1"),
    );
  });

  it("sweeps wider than it records when a resource loses every tuple", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const outbox = new FakeEnqueueAccessChanges();
    const owner = relationshipWrite(
      { type: WORKSPACE_TYPE, id: ORG_ID },
      "owner",
      {
        type: ORG_TYPE,
        id: ORG_ID,
      },
    );
    await authorization.writeRelationships([
      owner,
      relationshipWrite({ type: WORKSPACE_TYPE, id: ORG_ID }, "admin", {
        type: "user",
        id: USER_ID,
      }),
    ]);
    const sweep: RelationshipFilter[] = [
      { resourceType: WORKSPACE_TYPE, resourceId: ORG_ID },
    ];

    await revokeAccess({
      authorization,
      outbox,
      relationships: [owner],
      cause: "workspace-1",
      sweep,
    });

    // The enumerated tuple became a row; the un-enumerated grant did not, and
    // only the synchronous sweep could remove it.
    expect(outbox.enqueued).toHaveLength(1);
    // The one row IS the owner — a sweep that recorded the admin grant
    // instead would also be "length 1", and would be recording a fact the
    // projector must never replay as the resource's ownership.
    expect(outbox.enqueued[0]).toMatchObject({
      operation: "DELETE",
      relationship: owner,
    });
    // The enumerated tuple is gone from the graph too, not merely recorded.
    await expect(
      authorization.relationshipExists({
        resourceType: WORKSPACE_TYPE,
        resourceId: ORG_ID,
        relation: "owner",
      }),
    ).resolves.toBe(false);
    await expect(
      authorization.relationshipExists({
        resourceType: WORKSPACE_TYPE,
        resourceId: ORG_ID,
        relation: "admin",
      }),
    ).resolves.toBe(false);
  });
});
