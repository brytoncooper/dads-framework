/** Strict completion must observe settled facts, not merely a successful claim call. */
import { describe, expect, it } from "vitest";

import { conflict, ok } from "@dads-framework/core/errors";

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
import type { ClaimedOutboxRow, OutboxKeyClaim } from "./claim.js";
import { createCompleteAccessChanges } from "./complete.js";
import type {
  AccessChangeCompletionStatusReader,
  RetryFailedAccessChanges,
  UnfinishedAccessChange,
} from "./completion-status.js";
import { OwnerLock } from "@dads-framework/access/runtime";

const NOW = new Date("2026-09-09T12:00:00Z");
const ORGANIZATION = "organization";
const WORKSPACE = "workspace";
const OTHER_CUSTOMER = "other-customer";
const PERMISSIONS = { organization: { view: ["member"] } };
/** Names for `testAccessChangeId`'s stable ids, so a row can be seeded and later referenced by name. */
const ORG_ROW = testAccessChangeId("org");
const WORKSPACE_ROW = testAccessChangeId("workspace-row");
const OTHER_ROW = testAccessChangeId("other-row");

function fact(
  id: AccessChangeId,
  ownerPartitionId = ORGANIZATION,
): ClaimedOutboxRow {
  return {
    id,
    idempotencyKey: `grant-${id}`,
    operation: "WRITE",
    resourceType: "organization",
    resourceId: ownerPartitionId,
    relation: "member",
    subjectType: "user",
    subjectId: "employee",
    subjectRelation: null,
    ownerPartitionId,
    attempts: 0,
  };
}

class RefusingAuthorization extends FakeAuthorization {
  override writeRelationships(
    writes: readonly RelationshipWrite[],
  ): Promise<SpiceDbConsistencyToken> {
    void writes;
    return Promise.reject(new Error("graph unavailable"));
  }
}

class BusyOwnerLock extends OwnerLock {
  protected runLocked<T>(
    ownerPartitionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    void ownerPartitionId;
    void operation;
    return Promise.reject(conflict("AUTHORIZATION_PARTITION_BUSY", "Busy"));
  }
}

class UnclaimedStore extends FakeClaimAccessChanges {
  override claimByKeys(claim: OutboxKeyClaim) {
    void claim;
    return Promise.resolve([]);
  }
}

class LostClaimStore extends FakeClaimAccessChanges {
  override markProjected(
    ids: readonly AccessChangeId[],
    at: Date,
    workerId: string,
  ) {
    for (const id of ids) this.claimBy(id, "replacement-worker", at);
    return super.markProjected(ids, at, workerId);
  }
}

function setup(
  options: {
    readonly authorization?: FakeAuthorization;
    readonly claims?: FakeClaimAccessChanges;
    readonly ownerLock?: OwnerLock;
    /** Runs on each wait, standing in for the other worker's progress. */
    readonly whileWaiting?: (claims: FakeClaimAccessChanges) => Promise<void>;
  } = {},
) {
  const claims = options.claims ?? new FakeClaimAccessChanges();
  const authorization =
    options.authorization ?? new FakeAuthorization(PERMISSIONS);
  const ownerLock = options.ownerLock ?? new InMemoryOwnerLock();
  const facts: ClaimedOutboxRow[] = [];
  const observedPartitions: string[][] = [];
  const retries: AccessChangeId[] = [];
  const statusReader: AccessChangeCompletionStatusReader = {
    async readUnfinished(input) {
      await Promise.resolve();
      observedPartitions.push([...input.ownerPartitionIds]);
      const unfinished: UnfinishedAccessChange[] = [];
      for (const row of facts) {
        const status = claims.statusOf(row.id);
        if (
          row.ownerPartitionId !== null &&
          input.ownerPartitionIds.includes(row.ownerPartitionId) &&
          (status === "PENDING" || status === "FAILED")
        ) {
          unfinished.push({
            idempotencyKey: row.idempotencyKey,
            ownerPartitionId: row.ownerPartitionId,
            status,
          });
        }
      }
      return unfinished;
    },
  };
  const retry: RetryFailedAccessChanges = {
    async retryFailed(input) {
      await Promise.resolve();
      input.lease.assertPartition(input.ownerPartitionId);
      for (const row of facts) {
        if (
          row.ownerPartitionId === input.ownerPartitionId &&
          input.idempotencyKeys.includes(row.idempotencyKey) &&
          claims.statusOf(row.id) === "FAILED"
        ) {
          retries.push(row.id);
          claims.rePend(row.id);
        }
      }
    },
  };
  const projector = new ApplyAccessChanges(
    claims,
    authorization,
    () => NOW,
    ownerLock,
  );
  const clock = { elapsedMs: 0, waits: 0 };
  const completion = createCompleteAccessChanges({
    statusReader,
    retry,
    projector,
    ownerLock,
    now: () => clock.elapsedMs,
    delay: async (milliseconds) => {
      clock.elapsedMs += milliseconds;
      clock.waits += 1;
      await options.whileWaiting?.(claims);
    },
  });
  return {
    clock,
    claims,
    authorization,
    projector,
    statusReader,
    retry,
    ownerLock,
    completion,
    observedPartitions,
    retries,
    seed(...rows: ClaimedOutboxRow[]) {
      facts.push(...rows);
      claims.seed(...rows);
    },
  };
}

describe("CompleteAccessChanges", () => {
  it("projects named scopes and independently verifies their settled state", async () => {
    const test = setup();
    test.seed(
      fact(ORG_ROW),
      fact(WORKSPACE_ROW, WORKSPACE),
      fact(OTHER_ROW, OTHER_CUSTOMER),
    );
    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION, WORKSPACE, ORGANIZATION],
      }),
    ).toEqual(ok(undefined));
    expect(test.claims.statusOf(ORG_ROW)).toBe("PROJECTED");
    expect(test.claims.statusOf(WORKSPACE_ROW)).toBe("PROJECTED");
    expect(test.claims.statusOf(OTHER_ROW)).toBe("PENDING");
    expect(test.observedPartitions).toEqual([
      [ORGANIZATION, WORKSPACE],
      [ORGANIZATION, WORKSPACE],
    ]);
    expect(
      await test.authorization.check({
        resource: { type: "organization", id: OTHER_CUSTOMER },
        permission: "view",
        subject: { type: "user", id: "employee" },
      }),
    ).toBe(false);
  });

  it("returns a retryable failure when the graph refuses a fact", async () => {
    const test = setup({
      authorization: new RefusingAuthorization(PERMISSIONS),
    });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE",
        details: { retryable: true },
      },
    });
    expect(test.claims.statusOf(ORG_ROW)).toBe("PENDING");
  });

  it("refuses success when zero facts are claimed but pending facts remain", async () => {
    const test = setup({ claims: new UnclaimedStore() });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
    expect(test.claims.statusOf(ORG_ROW)).toBe("PENDING");
  });

  it("does not steal an active projector claim even on explicit retry", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    test.claims.claimBy(ORG_ROW, "other-worker", NOW);
    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        retryFailed: true,
      }),
    ).toMatchObject({ ok: false });
    expect(test.claims.lockedByOf(ORG_ROW)).toBe("other-worker");
    expect(test.retries).toEqual([]);
  });

  it("waits for another worker's live claim to settle instead of refusing", async () => {
    const test = setup({
      whileWaiting: async (claims) => {
        await claims.markProjected([ORG_ROW], NOW, "other-worker");
      },
    });
    test.seed(fact(ORG_ROW));
    test.claims.claimBy(ORG_ROW, "other-worker", NOW);
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toEqual(ok(undefined));
    expect(test.clock.waits).toBe(1);
  });

  it("refuses once another worker holds a claim past the wait budget", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    test.claims.claimBy(ORG_ROW, "other-worker", NOW);
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE" },
    });
    expect(test.clock.waits).toBeGreaterThan(1);
    expect(test.clock.elapsedMs).toBeLessThanOrEqual(5_000 + 25);
  });

  it("does not wait when the graph refuses a fact", async () => {
    const test = setup({
      authorization: new RefusingAuthorization(PERMISSIONS),
    });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
    expect(test.clock.waits).toBe(0);
  });

  it("does not wait on an exhausted fact nobody is working on", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    test.claims.claimBy(ORG_ROW, "old-worker", NOW);
    await test.claims.markFailed(
      ORG_ROW,
      { status: "FAILED", attempts: 5 },
      "unavailable",
      "old-worker",
    );
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
    expect(test.clock.waits).toBe(0);
  });

  it("refuses completion when a claim is lost between graph application and settlement", async () => {
    const test = setup({ claims: new LostClaimStore() });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
    expect(test.claims.statusOf(ORG_ROW)).toBe("PENDING");
    expect(test.claims.lockedByOf(ORG_ROW)).toBe("replacement-worker");
  });

  it("leaves exhausted facts FAILED unless the caller explicitly retries", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    test.claims.claimBy(ORG_ROW, "old-worker", NOW);
    await test.claims.markFailed(
      ORG_ROW,
      { status: "FAILED", attempts: 5 },
      "unavailable",
      "old-worker",
    );
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
    expect(test.claims.statusOf(ORG_ROW)).toBe("FAILED");
    expect(test.retries).toEqual([]);
    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        retryFailed: true,
      }),
    ).toEqual(ok(undefined));
    expect(test.claims.statusOf(ORG_ROW)).toBe("PROJECTED");
    expect(test.retries).toEqual([ORG_ROW]);
  });

  it("turns owner contention into an explicit incomplete result", async () => {
    const test = setup({ ownerLock: new BusyOwnerLock() });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE",
        details: { retryable: true },
      },
    });
  });

  it("accepts already projected facts and an empty scope list without draining other scopes", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW), fact(OTHER_ROW, OTHER_CUSTOMER));
    await test.projector.applyKeys({
      idempotencyKeys: [`grant-${ORG_ROW}`],
      workerId: "first",
    });
    expect(
      await test.completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toEqual(ok(undefined));
    expect(await test.completion.complete({ ownerPartitionIds: [] })).toEqual(
      ok(undefined),
    );
    expect(test.claims.statusOf(OTHER_ROW)).toBe("PENDING");
  });

  it("finishes only named facts, so the partition's other backlog neither runs nor fails the caller", async () => {
    const test = setup();
    const heldBacklog = testAccessChangeId("held-backlog");
    const exhaustedBacklog = testAccessChangeId("exhausted-backlog");
    test.seed(fact(ORG_ROW), fact(heldBacklog), fact(exhaustedBacklog));
    test.claims.claimBy(heldBacklog, "other-worker", NOW);
    test.claims.claimBy(exhaustedBacklog, "old-worker", NOW);
    await test.claims.markFailed(
      exhaustedBacklog,
      { status: "FAILED", attempts: 5 },
      "unavailable",
      "old-worker",
    );

    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        idempotencyKeys: [`grant-${ORG_ROW}`],
        retryFailed: true,
      }),
    ).toEqual(ok(undefined));
    expect(test.claims.statusOf(ORG_ROW)).toBe("PROJECTED");
    expect(test.claims.lockedByOf(heldBacklog)).toBe("other-worker");
    expect(test.claims.statusOf(heldBacklog)).toBe("PENDING");
    expect(test.claims.statusOf(exhaustedBacklog)).toBe("FAILED");
    expect(test.retries).toEqual([]);
  });

  it("still refuses success when a named fact does not land", async () => {
    const test = setup({
      authorization: new RefusingAuthorization(PERMISSIONS),
    });
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        idempotencyKeys: [`grant-${ORG_ROW}`],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE",
        details: { retryable: true },
      },
    });
    expect(test.claims.statusOf(ORG_ROW)).toBe("PENDING");
  });

  it("reopens a named exhausted fact on explicit retry and nothing else", async () => {
    const test = setup();
    const otherExhausted = testAccessChangeId("other-exhausted");
    test.seed(fact(ORG_ROW), fact(otherExhausted));
    for (const id of [ORG_ROW, otherExhausted]) {
      test.claims.claimBy(id, "old-worker", NOW);
      await test.claims.markFailed(
        id,
        { status: "FAILED", attempts: 5 },
        "unavailable",
        "old-worker",
      );
    }

    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        idempotencyKeys: [`grant-${ORG_ROW}`],
        retryFailed: true,
      }),
    ).toEqual(ok(undefined));
    expect(test.retries).toEqual([ORG_ROW]);
    expect(test.claims.statusOf(ORG_ROW)).toBe("PROJECTED");
    expect(test.claims.statusOf(otherExhausted)).toBe("FAILED");
  });

  it("has nothing to finish when the caller names no facts", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    expect(
      await test.completion.complete({
        ownerPartitionIds: [ORGANIZATION],
        idempotencyKeys: [],
      }),
    ).toEqual(ok(undefined));
    expect(test.observedPartitions).toEqual([]);
    expect(test.claims.statusOf(ORG_ROW)).toBe("PENDING");
  });

  it("rereads status rather than trusting the projector's projected count", async () => {
    const test = setup();
    test.seed(fact(ORG_ROW));
    const completion = createCompleteAccessChanges({
      ...test,
      projector: {
        applyKeys: async () => {
          await Promise.resolve();
          return ok({ claimed: 1, projected: 1, failed: 0 });
        },
      },
    });
    expect(
      await completion.complete({ ownerPartitionIds: [ORGANIZATION] }),
    ).toMatchObject({ ok: false });
  });
});
