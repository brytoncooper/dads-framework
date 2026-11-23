/** Real outbox state proves strict completion cannot cross scopes or revive superseded facts. */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ok } from "@dads-framework/core/errors";
import { startTestPostgres, type TestPostgres, truncateTables } from "@dads-framework/postgres/testing";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { InMemoryOwnerLock } from "../../../testing/in-memory-owner-lock.js";
import type { RelationshipWrite, SpiceDbConsistencyToken } from "@dads-framework/access/runtime";
import { ApplyAccessChanges } from "../apply.js";
import { createCompleteAccessChanges } from "../complete.js";
import type { OutboxStatus } from "../enqueue.js";
import { authorizationOutbox } from "./access-changes.tables.js";
import { PostgresClaimAccessChanges } from "./claim.js";
import { PostgresAccessChangeCompletionStatus } from "./completion-status.js";

const ORGANIZATION = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION = "10000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-09T12:00:00Z");
const PERMISSIONS = { organization: { view: ["member"] } };

class RefusingAuthorization extends FakeAuthorization {
  override writeRelationships(writes: readonly RelationshipWrite[]): Promise<SpiceDbConsistencyToken> {
    void writes;
    return Promise.reject(new Error("graph unavailable"));
  }
}

describe("PostgresAccessChangeCompletionStatus", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let statusReader: PostgresAccessChangeCompletionStatus;
  let claims: PostgresClaimAccessChanges;
  let ownerLock: InMemoryOwnerLock;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    statusReader = new PostgresAccessChangeCompletionStatus(db);
    claims = new PostgresClaimAccessChanges(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, ["authorization_outbox"]);
    ownerLock = new InMemoryOwnerLock();
  });

  async function seed(
    idempotencyKey: string,
    ownerPartitionId: string | null = ORGANIZATION,
    status: OutboxStatus = "PENDING",
  ) {
    await db.insert(authorizationOutbox).values({
      idempotencyKey,
      operation: "WRITE",
      resourceType: "organization",
      resourceId: ownerPartitionId ?? "unpartitioned",
      relation: "member",
      subjectType: "user",
      subjectId: idempotencyKey,
      ownerPartitionId,
      status,
      enqueuedAt: NOW,
      attempts: status === "FAILED" ? 5 : 0,
      lastError: status === "FAILED" ? "Previous projection failed" : null,
      projectedAt: status === "PROJECTED" ? NOW : null,
      supersededAt: status === "SUPERSEDED" ? NOW : null,
      supersededByIdempotencyKey: status === "SUPERSEDED" ? "replacement" : null,
    });
  }

  async function stored(idempotencyKey: string) {
    const rows = await db
      .select()
      .from(authorizationOutbox)
      .where(eq(authorizationOutbox.idempotencyKey, idempotencyKey));
    return rows[0];
  }

  function completion(authorization = new FakeAuthorization(PERMISSIONS)) {
    // Waiting out another worker's claim advances a virtual clock, so a claim
    // that is never released refuses without spending real seconds.
    let elapsedMs = 0;
    return createCompleteAccessChanges({
      statusReader,
      retry: statusReader,
      ownerLock,
      now: () => elapsedMs,
      delay: (milliseconds) => {
        elapsedMs += milliseconds;
        return Promise.resolve();
      },
      projector: new ApplyAccessChanges(claims, authorization, () => NOW, ownerLock),
    });
  }

  it("reads only pending and failed facts in the exact named partitions", async () => {
    await seed("pending");
    await seed("failed", ORGANIZATION, "FAILED");
    await seed("projected", ORGANIZATION, "PROJECTED");
    await seed("superseded", ORGANIZATION, "SUPERSEDED");
    await seed("other", OTHER_ORGANIZATION);
    await seed("unpartitioned", null);

    const unfinished = await statusReader.readUnfinished({
      ownerPartitionIds: [ORGANIZATION, ORGANIZATION],
    });
    expect(unfinished.map((fact) => fact.idempotencyKey).sort()).toEqual(["failed", "pending"]);
    expect(await statusReader.readUnfinished({ ownerPartitionIds: [] })).toEqual([]);
  });

  it("names only the asked resources that still hold a pending fact", async () => {
    await seed("pending");
    await seed("failed", OTHER_ORGANIZATION, "FAILED");

    const pending = await statusReader.pendingResources([
      { type: "organization", id: ORGANIZATION },
      { type: "organization", id: OTHER_ORGANIZATION },
      { type: "workspace", id: ORGANIZATION },
    ]);

    expect([...pending]).toEqual([`organization:${ORGANIZATION}`]);
    expect(await statusReader.pendingResources([])).toEqual(new Set());
  });

  it("treats projected and superseded facts as terminal without reviving them", async () => {
    await seed("superseded", ORGANIZATION, "SUPERSEDED");
    await seed("replacement", ORGANIZATION, "PROJECTED");
    expect(
      await completion().complete({
        ownerPartitionIds: [ORGANIZATION],
        retryFailed: true,
      }),
    ).toEqual(ok(undefined));
    expect(await stored("superseded")).toMatchObject({
      status: "SUPERSEDED",
      supersededByIdempotencyKey: "replacement",
    });
    expect(await stored("replacement")).toMatchObject({ status: "PROJECTED" });
  });

  it("retries only explicitly named unlocked failed facts under the matching lease", async () => {
    await seed("retry", ORGANIZATION, "FAILED");
    await seed("unnamed", ORGANIZATION, "FAILED");
    await seed("other", OTHER_ORGANIZATION, "FAILED");
    await seed("superseded", ORGANIZATION, "SUPERSEDED");
    await seed("projected", ORGANIZATION, "PROJECTED");
    await seed("claimed");
    await seed("locked-failed", ORGANIZATION, "FAILED");
    for (const key of ["claimed", "locked-failed"]) {
      await db
        .update(authorizationOutbox)
        .set({ lockedBy: "active-worker", lockedAt: NOW })
        .where(eq(authorizationOutbox.idempotencyKey, key));
    }

    await ownerLock.run(ORGANIZATION, (lease) =>
      statusReader.retryFailed({
        ownerPartitionId: ORGANIZATION,
        idempotencyKeys: ["retry", "other", "superseded", "projected", "claimed", "locked-failed"],
        lease,
      }),
    );

    expect(await stored("retry")).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastError: null,
    });
    expect(await stored("unnamed")).toMatchObject({
      status: "FAILED",
      attempts: 5,
    });
    expect(await stored("other")).toMatchObject({
      status: "FAILED",
      attempts: 5,
    });
    expect(await stored("superseded")).toMatchObject({ status: "SUPERSEDED" });
    expect(await stored("projected")).toMatchObject({ status: "PROJECTED" });
    expect(await stored("claimed")).toMatchObject({
      status: "PENDING",
      lockedBy: "active-worker",
      lockedAt: NOW,
    });
    expect(await stored("locked-failed")).toMatchObject({
      status: "FAILED",
      lockedBy: "active-worker",
      lockedAt: NOW,
    });
  });

  it("refuses an unrelated or released owner lease", async () => {
    await seed("failed", ORGANIZATION, "FAILED");
    const releasedLease = await ownerLock.run(OTHER_ORGANIZATION, async (lease) => {
      await expect(
        statusReader.retryFailed({
          ownerPartitionId: ORGANIZATION,
          idempotencyKeys: ["failed"],
          lease,
        }),
      ).rejects.toThrow();
      return lease;
    });
    await expect(
      statusReader.retryFailed({
        ownerPartitionId: OTHER_ORGANIZATION,
        idempotencyKeys: ["failed"],
        lease: releasedLease,
      }),
    ).rejects.toThrow();
    expect(await stored("failed")).toMatchObject({
      status: "FAILED",
      attempts: 5,
    });
  });

  it("reports graph failure and later confirms a successful explicit retry", async () => {
    await seed("failed", ORGANIZATION, "FAILED");
    expect(
      await completion(new RefusingAuthorization(PERMISSIONS)).complete({
        ownerPartitionIds: [ORGANIZATION],
        retryFailed: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE" },
    });
    expect(await stored("failed")).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
    expect(await completion().complete({ ownerPartitionIds: [ORGANIZATION] })).toEqual(ok(undefined));
    expect(await stored("failed")).toMatchObject({ status: "PROJECTED" });
  });

  it("does not treat an actively claimed pending row as completion", async () => {
    await seed("pending");
    await claims.claimByKeys({
      idempotencyKeys: ["pending"],
      workerId: "active-worker",
      now: NOW,
      leaseCutoff: NOW,
    });
    expect(
      await completion().complete({
        ownerPartitionIds: [ORGANIZATION],
        retryFailed: true,
      }),
    ).toMatchObject({ ok: false });
    expect(await stored("pending")).toMatchObject({
      status: "PENDING",
      lockedBy: "active-worker",
      lockedAt: NOW,
    });
  });
});
