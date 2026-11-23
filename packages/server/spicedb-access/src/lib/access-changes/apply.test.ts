import { describe, expect, it } from "vitest";

import { ok } from "@dads-framework/core/errors";

import { FakeAuthorization } from "@dads-framework/access/testing";
import {
  FakeClaimAccessChanges,
  testAccessChangeId,
} from "../../testing/fake-claim.js";
import { InMemoryOwnerLock } from "../../testing/in-memory-owner-lock.js";
import type {
  RelationshipWrite,
  SpiceDbConsistencyToken,
} from "@dads-framework/access/runtime";
import type { AccessChangeId } from "./access-change.ids.js";
import { ApplyAccessChanges } from "./apply.js";
import { DEFAULT_LEASE_MS } from "./logic/claim-rules.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ORG = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e01";
const OTHER_ORG = "11111111-1111-4111-8111-111111111111";
/** Names for `testAccessChangeId`'s stable ids, so a row can be seeded and later referenced by name. */
const ROW_1 = testAccessChangeId("r1");
const ROW_2 = testAccessChangeId("r2");

const PERMISSIONS = {
  "organizations/organization": { view: ["admin"] },
};

/**
 * Declared here rather than as a method on the shared FakeAuthorization: only
 * this suite needs a graph that refuses, and widening a fake every test in the
 * repo depends on is how a test double turns into a second implementation.
 */
class RefusingAuthorization extends FakeAuthorization {
  constructor(
    private readonly refuseResourceId: string,
    private readonly reason: string,
  ) {
    super(PERMISSIONS);
  }

  override writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    if (writes.some((write) => write.resource.id === this.refuseResourceId)) {
      return Promise.reject(new Error(this.reason));
    }
    return super.writeRelationships(writes);
  }
}

class GatedAuthorization extends FakeAuthorization {
  private startGate = (): void => undefined;
  private releaseGate = (): void => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.startGate = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  constructor() {
    super(PERMISSIONS);
  }

  override async writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    this.startGate();
    await this.released;
    return super.writeRelationships(writes);
  }

  release(): void {
    this.releaseGate();
  }
}

function grantRow(id: AccessChangeId) {
  return {
    id,
    idempotencyKey: `WRITE|key|${id}`,
    operation: "WRITE" as const,
    resourceType: "organizations/organization",
    resourceId: ORG,
    relation: "admin",
    subjectType: "user",
    subjectId: "u1",
    subjectRelation: null,
    ownerPartitionId: ORG,
    attempts: 0,
  };
}

function setup(authz: FakeAuthorization = new FakeAuthorization(PERMISSIONS)) {
  const store = new FakeClaimAccessChanges();
  return {
    store,
    authz,
    projector: new ApplyAccessChanges(
      store,
      authz,
      () => NOW,
      new InMemoryOwnerLock(),
    ),
  };
}

function canView(authz: FakeAuthorization, resourceId = ORG): Promise<boolean> {
  return authz.check({
    subject: { type: "user", id: "u1" },
    permission: "view",
    resource: { type: "organizations/organization", id: resourceId },
  });
}

describe("ApplyAccessChanges", () => {
  it("carries a pending grant into the graph and marks it projected", async () => {
    const { store, authz, projector } = setup();
    store.seed(grantRow(ROW_1));

    const result = await projector.execute({ workerId: "w1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 1, projected: 1, failed: 0 });
    expect(await canView(authz)).toBe(true);
    expect(store.statusOf(ROW_1)).toBe("PROJECTED");
  });

  it("projecting the same fact twice reaches the same end state", async () => {
    const { store, authz, projector } = setup();
    store.seed(grantRow(ROW_1));

    await projector.execute({ workerId: "w1" });
    // Replay is not an error path — it is the NORMAL consequence of
    // at-least-once delivery, so it has to be boring. Re-pend the row the way
    // an expired lease would, and run it again.
    store.rePend(ROW_1);
    const second = await projector.execute({ workerId: "w2" });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.projected).toBe(1);
    expect(await canView(authz)).toBe(true);
    // One tuple, not two: TOUCH semantics, so the second write changed nothing.
    const subjects = await authz.listDirectSubjects({
      resource: { type: "organizations/organization", id: ORG },
      relation: "admin",
    });
    expect(subjects).toHaveLength(1);
  });

  it("deleting an absent tuple is a no-op, not a failure", async () => {
    const { store, projector } = setup();
    store.seed({ ...grantRow(ROW_1), operation: "DELETE" });

    const result = await projector.execute({ workerId: "w1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 1, projected: 1, failed: 0 });
    expect(store.statusOf(ROW_1)).toBe("PROJECTED");
  });

  it("a revocation reaches the graph and takes access away", async () => {
    const { store, authz, projector } = setup();
    authz.seed({
      resource: { type: "organizations/organization", id: ORG },
      relation: "admin",
      subject: { type: "user", id: "u1" },
    });
    expect(await canView(authz)).toBe(true);

    store.seed({ ...grantRow(ROW_1), operation: "DELETE" });
    await projector.execute({ workerId: "w1" });
    expect(await canView(authz)).toBe(false);
  });

  it("returns a failed row to PENDING with its error recorded", async () => {
    const { store, projector } = setup(
      new RefusingAuthorization(ORG, "spicedb unavailable"),
    );
    store.seed(grantRow(ROW_1));

    const result = await projector.execute({ workerId: "w1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 1, projected: 0, failed: 1 });
    expect(store.statusOf(ROW_1)).toBe("PENDING");
    expect(store.attemptsOf(ROW_1)).toBe(1);
    expect(store.errorOf(ROW_1)).toBe("spicedb unavailable");
    // The lock is released, or the next run would find it still held.
    expect(store.lockedByOf(ROW_1)).toBeNull();
  });

  it("gives up at the attempt limit and leaves the row FAILED for a human", async () => {
    const { store, projector } = setup(
      new RefusingAuthorization(ORG, "still unavailable"),
    );
    store.seed({ ...grantRow(ROW_1), attempts: 4 });

    await projector.execute({ workerId: "w1" });
    expect(store.statusOf(ROW_1)).toBe("FAILED");
    expect(store.attemptsOf(ROW_1)).toBe(5);
  });

  it("one bad fact does not strand the good ones beside it", async () => {
    const authz = new RefusingAuthorization(ORG, "only this resource fails");
    const { store, projector } = setup(authz);
    store.seed(grantRow(ROW_1), {
      ...grantRow(ROW_2),
      resourceId: OTHER_ORG,
    });

    const result = await projector.execute({ workerId: "w1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 2, projected: 1, failed: 1 });
    expect(store.statusOf(ROW_1)).toBe("PENDING");
    expect(store.statusOf(ROW_2)).toBe("PROJECTED");
    expect(await canView(authz, OTHER_ORG)).toBe(true);
  });

  it("a crashed worker's claim expires and the fact is taken back", async () => {
    const { store, projector } = setup();
    store.seed(grantRow(ROW_1));
    // Claimed by a worker that never came back.
    store.claimBy(ROW_1, "dead-worker", new Date(NOW.getTime() - 10 * 60_000));

    const result = await projector.execute({ workerId: "w2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projected).toBe(1);
    expect(store.statusOf(ROW_1)).toBe("PROJECTED");
  });

  it("a claim that is still warm belongs to its holder", async () => {
    const { store, projector } = setup();
    store.seed(grantRow(ROW_1));
    store.claimBy(ROW_1, "live-worker", new Date(NOW.getTime() - 1_000));

    const result = await projector.execute({ workerId: "w2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 0, projected: 0, failed: 0 });
    expect(store.statusOf(ROW_1)).toBe("PENDING");
    expect(store.lastClaimCutoff()).toEqual(
      new Date(NOW.getTime() - DEFAULT_LEASE_MS),
    );
  });

  it("does not report PROJECTED when its claim is stolen during graph I/O", async () => {
    const store = new FakeClaimAccessChanges();
    store.seed(grantRow(ROW_1));
    const authorization = new GatedAuthorization();
    const coordinator = new InMemoryOwnerLock();
    const first = new ApplyAccessChanges(
      store,
      authorization,
      () => NOW,
      coordinator,
    );
    const afterLeaseExpiry = new Date(NOW.getTime() + DEFAULT_LEASE_MS + 1);
    const second = new ApplyAccessChanges(
      store,
      authorization,
      () => afterLeaseExpiry,
      coordinator,
    );

    const firstRun = first.execute({ workerId: "first-worker" });
    await authorization.started;
    const secondRun = second.execute({ workerId: "second-worker" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.lockedByOf(ROW_1)).toBe("second-worker");
    authorization.release();

    const firstResult = await firstRun;
    const secondResult = await secondRun;
    expect(firstResult).toEqual(ok({ claimed: 1, projected: 0, failed: 0 }));
    expect(secondResult).toEqual(ok({ claimed: 1, projected: 1, failed: 0 }));
    expect(store.statusOf(ROW_1)).toBe("PROJECTED");
  });

  it("carries a subject-set relation through to the graph", async () => {
    const { store, projector, authz } = setup();
    store.seed({
      ...grantRow(ROW_1),
      subjectType: "organizations/organization",
      subjectId: ORG,
      subjectRelation: "member",
    });

    await projector.execute({ workerId: "w1" });
    const subjects = await authz.listDirectSubjects({
      resource: { type: "organizations/organization", id: ORG },
      relation: "admin",
    });
    expect(subjects).toEqual([
      { type: "organizations/organization", id: ORG, relation: "member" },
    ]);
  });

  it("an empty queue is a successful, silent run", async () => {
    const { projector } = setup();
    const result = await projector.execute({ workerId: "w1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ claimed: 0, projected: 0, failed: 0 });
  });
});
