/**
 * The outbox adapter against Testcontainers Postgres.
 *
 * The load-bearing test is the rollback one, and what it really proves is that
 * the adapter enqueues through the CALLER'S transaction rather than through a
 * handle of its own. An adapter that ignored `tx` and reached for an injected
 * database would pass every other test in this file and fail only this one —
 * and in production it would resurrect exactly the failure the outbox exists to
 * remove: a fact that outlives the state change it was recording.
 *
 * The companion property — a DOMAIN row and its fact committing together —
 * belongs to whichever domain owns the row, and is proved in the create
 * mutations converted alongside the detector re-aim. Proving it here would mean
 * importing a domain into this shared battery, which is a dependency cycle
 * (`api-authorization -> domain-organizations -> api-authorization`) rather than a test.
 */
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
  truncateTables,
} from "@dads-framework/postgres/testing";

import { type AccessChange, outboxKeyForRelationship } from "../enqueue.js";
import { authorizationOutbox } from "./access-changes.tables.js";
import { PostgresEnqueueAccessChanges } from "./enqueue.js";

const ORGANIZATION_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e01";

function entryFor(cause: string): AccessChange {
  const relationship = {
    resource: { type: "organizations/organization", id: ORGANIZATION_ID },
    relation: "admin",
    subject: { type: "user", id: "u1" },
  };
  return {
    idempotencyKey: outboxKeyForRelationship("WRITE", relationship, cause),
    operation: "WRITE",
    relationship,
    ownerPartitionId: ORGANIZATION_ID,
  };
}

describe("PostgresEnqueueAccessChanges (integration)", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let outbox: PostgresEnqueueAccessChanges;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
    outbox = new PostgresEnqueueAccessChanges(db);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, ["authorization_outbox"]);
  });

  it("records a relationship as a PENDING fact, flattened for the projector", async () => {
    await db.transaction(async (tx) => {
      await outbox.enqueue([entryFor("created")], tx);
    });

    const enqueued = await db.select().from(authorizationOutbox);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      operation: "WRITE",
      resourceType: "organizations/organization",
      resourceId: ORGANIZATION_ID,
      relation: "admin",
      subjectType: "user",
      subjectId: "u1",
      subjectRelation: null,
      ownerPartitionId: ORGANIZATION_ID,
      status: "PENDING",
      attempts: 0,
      projectedAt: null,
      lockedBy: null,
      lastError: null,
    });
  });

  it("keeps a subject-set relation, which subject-set tuples need", async () => {
    const relationship = {
      resource: { type: "organizations/workspace", id: ORGANIZATION_ID },
      relation: "viewer",
      subject: {
        type: "access_management/permission_set",
        id: ORGANIZATION_ID,
        relation: "member",
      },
    };
    await outbox.enqueue(
      [
        {
          idempotencyKey: outboxKeyForRelationship(
            "WRITE",
            relationship,
            "permission-set",
          ),
          operation: "WRITE",
          relationship,
          ownerPartitionId: null,
        },
      ],
      db,
    );

    const [row] = await db.select().from(authorizationOutbox);
    expect(row?.subjectRelation).toBe("member");
    expect(row?.ownerPartitionId).toBeNull();
  });

  it("a rollback after the enqueue leaves NOTHING — the entry is inside the caller's transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await outbox.enqueue([entryFor("created")], tx);
        // Whatever goes wrong after the writes — a later guard, a lost
        // connection — must take the fact with it. An adapter that used its
        // own handle would leave this row behind, which is precisely the
        // stranded-fact failure the outbox exists to make impossible.
        throw new Error("something after the writes went wrong");
      }),
    ).rejects.toThrow("something after the writes went wrong");

    const [facts] = await db
      .select({ total: count() })
      .from(authorizationOutbox);
    expect(facts?.total).toBe(0);
  });

  it("re-enqueuing the same fact is a no-op, not a failed transaction", async () => {
    const entry = entryFor("created");
    await outbox.enqueue([entry], db);
    // A retried transaction must not die on the unique index — the state
    // change it is recording is legitimate and already recorded.
    await outbox.enqueue([entry], db);

    const enqueued = await db.select().from(authorizationOutbox);
    expect(enqueued).toHaveLength(1);
  });

  it("a different cause for the same tuple is a different fact", async () => {
    await outbox.enqueue([entryFor("granted-on-create")], db);
    await outbox.enqueue([entryFor("regranted-after-removal")], db);

    const enqueued = await db.select().from(authorizationOutbox);
    expect(enqueued).toHaveLength(2);
  });

  it("enqueuing nothing touches nothing", async () => {
    await outbox.enqueue([], db);
    const [facts] = await db
      .select({ total: count() })
      .from(authorizationOutbox);
    expect(facts?.total).toBe(0);
  });

  it("append durably records a fact that has no row of its own", async () => {
    await outbox.append([entryFor("revoked")]);

    const enqueued = await db.select().from(authorizationOutbox);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ status: "PENDING" });
  });

  it("append is idempotent on the same cause, like enqueue", async () => {
    await outbox.append([entryFor("revoked")]);
    await outbox.append([entryFor("revoked")]);

    const [facts] = await db
      .select({ total: count() })
      .from(authorizationOutbox);
    expect(facts?.total).toBe(1);
  });
});
