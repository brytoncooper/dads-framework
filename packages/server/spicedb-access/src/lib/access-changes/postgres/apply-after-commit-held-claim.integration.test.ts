/**
 * A save's inline dispatch against Testcontainers Postgres while another
 * worker holds the save's own facts.
 *
 * The holder is a second connection running the real claim, exactly as a
 * site's background projector does after a pulled page: it stamps the rows
 * under its own worker id, then settles them one at a time. The save's claim
 * skips stamped rows, so before claim tracking the save answered before its grants
 * reached the graph and read its own record back as missing.
 *
 * The pause between re-reads is injected, so nothing here sleeps: the holder
 * finishes inside a pause, or never does.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres, truncateTables } from "@dads-framework/postgres/testing";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { InMemoryOwnerLock } from "../../../testing/in-memory-owner-lock.js";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { ApplyAccessChanges } from "../apply.js";
import { createApplyAccessChangesAfterCommit, type HeldClaimWait } from "../apply-after-commit.js";
import { accessChangesToWrite } from "../enqueue.js";
import { leaseCutoff } from "../logic/claim-rules.js";
import { authorizationOutbox } from "./access-changes.tables.js";
import { PostgresClaimAccessChanges } from "./claim.js";
import { PostgresEnqueueAccessChanges } from "./enqueue.js";

const RECIPE_TYPE = "products/recipe";
const RECIPE_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e11";
const WORKSPACE_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e12";
const USER_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e13";
const PERMISSIONS = { [RECIPE_TYPE]: { view: ["viewer"] } };
const HOLDER = "site-pull";

const SAVED_FACTS = accessChangesToWrite(
  [
    relationshipWrite({ type: RECIPE_TYPE, id: RECIPE_ID }, "viewer", {
      type: "user",
      id: USER_ID,
    }),
  ],
  `recipe-created:${RECIPE_ID}`,
  WORKSPACE_ID,
);

describe("a save's dispatch while another connection holds its facts (integration)", () => {
  let postgres: TestPostgres;
  let db: ReturnType<typeof drizzle>;
  let releaseHolder: (() => void) | undefined;
  let holder: PostgresClaimAccessChanges;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    db = drizzle(postgres.pool);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await truncateTables(postgres.pool, ["authorization_outbox"]);
    const holderConnection = await postgres.pool.connect();
    releaseHolder = () => {
      holderConnection.release();
    };
    holder = new PostgresClaimAccessChanges(drizzle(holderConnection));
  });

  afterEach(() => {
    releaseHolder?.();
    releaseHolder = undefined;
  });

  /** The save: commit its facts, then dispatch them as a create does. */
  function save(delay: HeldClaimWait["delay"]) {
    const authorization = new FakeAuthorization(PERMISSIONS);
    const store = new PostgresClaimAccessChanges(db);
    const log = { warn: vi.fn() };
    const dispatch = createApplyAccessChangesAfterCommit(
      new ApplyAccessChanges(store, authorization, () => new Date(), new InMemoryOwnerLock()),
      log,
      "inline-dispatch",
      { checks: 40, intervalMs: 50, delay },
    );
    return {
      authorization,
      store,
      log,
      commit: () =>
        db.transaction(async (tx) => {
          await new PostgresEnqueueAccessChanges(db).enqueue(SAVED_FACTS, tx);
        }),
      dispatch: () => dispatch.dispatch(SAVED_FACTS),
      readsItsRecord: () =>
        authorization.check({
          subject: { type: "user", id: USER_ID },
          permission: "view",
          resource: { type: RECIPE_TYPE, id: RECIPE_ID },
        }),
    };
  }

  /** The background projector's claim, on its own connection. */
  async function holderClaims() {
    const now = new Date();
    return holder.claim({
      batchSize: 50,
      workerId: HOLDER,
      now,
      leaseCutoff: leaseCutoff(now),
    });
  }

  async function outboxRow() {
    const [row] = await db
      .select({
        status: authorizationOutbox.status,
        lockedBy: authorizationOutbox.lockedBy,
      })
      .from(authorizationOutbox)
      .where(eq(authorizationOutbox.idempotencyKey, SAVED_FACTS[0]?.idempotencyKey ?? ""));
    return row;
  }

  it("waits while the other connection projects the save's facts, then reads its record", async () => {
    let pauses = 0;
    const saving = save(async () => {
      pauses += 1;
      if (pauses !== 2) return;
      // The holder finishes: the fact reaches the graph, then settles.
      for (const row of claimed) {
        const fact = SAVED_FACTS.find((entry) => entry.idempotencyKey === row.idempotencyKey);
        if (fact !== undefined) {
          await saving.authorization.writeRelationships([fact.relationship]);
        }
      }
      await holder.markProjected(
        claimed.map((row) => row.id),
        new Date(),
        HOLDER,
      );
    });
    await saving.commit();
    const claimed = await holderClaims();

    await saving.dispatch();

    expect({
      held: claimed.length,
      pauses,
      readsItsRecord: await saving.readsItsRecord(),
      row: await outboxRow(),
      warned: saving.log.warn.mock.calls.length,
    }).toEqual({
      held: 1,
      pauses: 2,
      readsItsRecord: true,
      row: { status: "PROJECTED", lockedBy: null },
      warned: 0,
    });
  });

  it("returns after the bound, as before, when the other connection never finishes", async () => {
    const delay = vi.fn(() => Promise.resolve());
    const saving = save(delay);
    await saving.commit();
    await holderClaims();

    await expect(saving.dispatch()).resolves.toBeUndefined();

    expect({
      pauses: delay.mock.calls.length,
      readsItsRecord: await saving.readsItsRecord(),
      row: await outboxRow(),
    }).toEqual({
      pauses: 40,
      readsItsRecord: false,
      row: { status: "PENDING", lockedBy: HOLDER },
    });
    expect(saving.log.warn).toHaveBeenCalledWith(
      {
        event: "authorization.dispatch.held_elsewhere",
        held: 1,
        waitedMs: 2000,
      },
      expect.any(String),
    );
  });

  it("does not read again or pause when nothing holds the save's facts", async () => {
    const delay = vi.fn(() => Promise.reject(new Error("a save with no contention never pauses")));
    const saving = save(delay);
    const heldByLiveClaim = vi.spyOn(saving.store, "heldByLiveClaim");
    await saving.commit();

    await saving.dispatch();

    expect({
      reads: heldByLiveClaim.mock.calls.length,
      pauses: delay.mock.calls.length,
      readsItsRecord: await saving.readsItsRecord(),
      row: await outboxRow(),
      warned: saving.log.warn.mock.calls.length,
    }).toEqual({
      reads: 0,
      pauses: 0,
      readsItsRecord: true,
      row: { status: "PROJECTED", lockedBy: null },
      warned: 0,
    });
  });
});
