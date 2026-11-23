/**
 * The inline dispatch. Two properties matter: it projects exactly
 * the facts it was given, and it NEVER throws — by the time it runs, the row
 * and its facts are committed and the caller has already succeeded.
 */
import { describe, expect, it, vi } from "vitest";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { FakeClaimAccessChanges, testAccessChangeId } from "../../testing/fake-claim.js";
import { InMemoryOwnerLock } from "../../testing/in-memory-owner-lock.js";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { ApplyAccessChanges } from "./apply.js";
import { createApplyAccessChangesAfterCommit, type HeldClaimWait } from "./apply-after-commit.js";
import { accessChangesToWrite } from "./enqueue.js";

const ORG_TYPE = "organizations/organization";
const ORG_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e01";
const USER_ID = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e02";
const NOW = new Date("2026-08-03T00:00:00.000Z");
const PERMISSIONS = { [ORG_TYPE]: { manage: ["admin"] } };

const FACTS = accessChangesToWrite(
  [
    relationshipWrite({ type: ORG_TYPE, id: ORG_ID }, "admin", {
      type: "user",
      id: USER_ID,
    }),
  ],
  ORG_ID,
  ORG_ID,
);

const FACT_ID = testAccessChangeId(`seeded-0-${FACTS[0]?.idempotencyKey ?? ""}`);
const FACT = FACTS[0]?.relationship;

function setup(
  authorization = new FakeAuthorization(PERMISSIONS),
  delay: HeldClaimWait["delay"] = () => Promise.resolve(),
) {
  const store = new FakeClaimAccessChanges();
  store.seedEntries(...FACTS);
  const log = { warn: vi.fn() };
  const projector = new ApplyAccessChanges(store, authorization, () => NOW, new InMemoryOwnerLock());
  return {
    store,
    log,
    authorization,
    dispatch: createApplyAccessChangesAfterCommit(projector, log, "inline-dispatch", {
      checks: 40,
      intervalMs: 50,
      delay,
    }),
  };
}

function creatorMayManage(authorization: FakeAuthorization) {
  return authorization.check({
    subject: { type: "user", id: USER_ID },
    permission: "manage",
    resource: { type: ORG_TYPE, id: ORG_ID },
  });
}

describe("createApplyAccessChangesAfterCommit", () => {
  it("projects the facts it was handed, so a create is usable at once", async () => {
    const { authorization, dispatch } = setup();

    await dispatch.dispatch(FACTS);

    await expect(
      authorization.check({
        subject: { type: "user", id: USER_ID },
        permission: "manage",
        resource: { type: ORG_TYPE, id: ORG_ID },
      }),
    ).resolves.toBe(true);
  });

  it("settles them through the projector, not by marking them itself", async () => {
    const { store, dispatch } = setup();

    await dispatch.dispatch(FACTS);

    const key = FACTS[0]?.idempotencyKey ?? "";
    expect(store.statusOf(testAccessChangeId(`seeded-0-${key}`))).toBe("PROJECTED");
  });

  it("leaves an unrelated pending fact alone — the claim is scoped", async () => {
    const { store, dispatch } = setup();
    const other = accessChangesToWrite(
      [
        relationshipWrite({ type: ORG_TYPE, id: "other" }, "admin", {
          type: "user",
          id: "u",
        }),
      ],
      "other",
      "other",
    );
    store.seedEntries(...other);

    await dispatch.dispatch(FACTS);

    expect(store.statusOf(testAccessChangeId(`seeded-0-${other[0]?.idempotencyKey ?? ""}`))).toBe("PENDING");
  });

  it("does NOT throw when the graph is unreachable — the row is committed", async () => {
    const unreachable = new FakeAuthorization(PERMISSIONS);
    unreachable.writeRelationships = () => Promise.reject(new Error("spicedb unreachable"));
    const { dispatch, log, store } = setup(unreachable);

    await expect(dispatch.dispatch(FACTS)).resolves.toBeUndefined();

    // Reported, and left for the projector to retry.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(store.statusOf(testAccessChangeId(`seeded-0-${FACTS[0]?.idempotencyKey ?? ""}`))).toBe("PENDING");
  });

  it("does NOT throw when the claim itself fails", async () => {
    const { dispatch, log, store } = setup();
    store.claimByKeys = () => Promise.reject(new Error("database gone"));

    await expect(dispatch.dispatch(FACTS)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when there are no facts", async () => {
    const { dispatch, log, store } = setup();
    const claimByKeys = vi.spyOn(store, "claimByKeys");

    await dispatch.dispatch([]);

    // "Nothing" has to mean the store was never TOUCHED. Asserting only that
    // no warning was logged is also satisfied by a dispatch that claimed an
    // empty batch successfully — a database round trip on every request that
    // happens to have no facts, which is the cost this early return exists to
    // avoid, and which no other assertion here would notice.
    expect(claimByKeys).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("a dispatch whose own facts another worker holds", () => {
  it("waits until that worker has projected them, without taking them over", async () => {
    const authorization = new FakeAuthorization(PERMISSIONS);
    let pauses = 0;
    const context = setup(authorization, async () => {
      pauses += 1;
      if (pauses === 3 && FACT !== undefined) {
        // The background projector finishes its batch.
        await authorization.writeRelationships([FACT]);
        await context.store.markProjected([FACT_ID], NOW, "site-pull");
      }
    });
    context.store.claimBy(FACT_ID, "site-pull", NOW);

    await context.dispatch.dispatch(FACTS);

    expect({
      pauses,
      mayManage: await creatorMayManage(authorization),
      status: context.store.statusOf(FACT_ID),
      warned: context.log.warn.mock.calls.length,
    }).toEqual({ pauses: 3, mayManage: true, status: "PROJECTED", warned: 0 });
  });

  it("returns after the bound as before, logging it, when the holder never finishes", async () => {
    const delay = vi.fn(() => Promise.resolve());
    const { authorization, dispatch, log, store } = setup(undefined, delay);
    store.claimBy(FACT_ID, "site-pull", NOW);

    await expect(dispatch.dispatch(FACTS)).resolves.toBeUndefined();

    expect({
      pauses: delay.mock.calls.length,
      mayManage: await creatorMayManage(authorization),
      status: store.statusOf(FACT_ID),
      lockedBy: store.lockedByOf(FACT_ID),
    }).toEqual({
      pauses: 40,
      mayManage: false,
      status: "PENDING",
      lockedBy: "site-pull",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      {
        event: "authorization.dispatch.held_elsewhere",
        held: 1,
        waitedMs: 2000,
      },
      expect.any(String),
    );
  });

  it("stops waiting when the holder releases the fact unprojected", async () => {
    let pauses = 0;
    const context = setup(undefined, () => {
      pauses += 1;
      context.store.rePend(FACT_ID);
      return Promise.resolve();
    });
    context.store.claimBy(FACT_ID, "site-pull", NOW);

    await context.dispatch.dispatch(FACTS);

    expect({
      pauses,
      status: context.store.statusOf(FACT_ID),
      warned: context.log.warn.mock.calls.length,
    }).toEqual({ pauses: 1, status: "PENDING", warned: 0 });
  });

  it("claims a fact whose holder's lease has expired instead of waiting on it", async () => {
    const delay = vi.fn(() => Promise.resolve());
    const { authorization, dispatch, store } = setup(undefined, delay);
    store.claimBy(FACT_ID, "crashed-worker", new Date(NOW.getTime() - 120_000));

    await dispatch.dispatch(FACTS);

    expect({
      pauses: delay.mock.calls.length,
      mayManage: await creatorMayManage(authorization),
    }).toEqual({ pauses: 0, mayManage: true });
  });

  it("costs nothing extra when the claim took every fact: no read, no pause", async () => {
    const delay = vi.fn(() => Promise.resolve());
    const { dispatch, store } = setup(undefined, delay);
    const heldByLiveClaim = vi.spyOn(store, "heldByLiveClaim");

    await dispatch.dispatch(FACTS);

    expect({
      reads: heldByLiveClaim.mock.calls.length,
      pauses: delay.mock.calls.length,
    }).toEqual({ reads: 0, pauses: 0 });
  });

  it("reads once and does not pause when an unclaimed fact is already projected", async () => {
    const delay = vi.fn(() => Promise.resolve());
    const { dispatch, store } = setup(undefined, delay);
    store.claimBy(FACT_ID, "earlier-dispatch", NOW);
    await store.markProjected([FACT_ID], NOW, "earlier-dispatch");
    const heldByLiveClaim = vi.spyOn(store, "heldByLiveClaim");

    await dispatch.dispatch(FACTS);

    expect({
      reads: heldByLiveClaim.mock.calls.length,
      pauses: delay.mock.calls.length,
    }).toEqual({ reads: 1, pauses: 0 });
  });

  it("does not wait on a fact its own claim failed to project", async () => {
    const unreachable = new FakeAuthorization(PERMISSIONS);
    unreachable.writeRelationships = () => Promise.reject(new Error("spicedb unreachable"));
    const delay = vi.fn(() => Promise.resolve());
    const { dispatch, store } = setup(unreachable, delay);
    const heldByLiveClaim = vi.spyOn(store, "heldByLiveClaim");

    await dispatch.dispatch(FACTS);

    expect({
      reads: heldByLiveClaim.mock.calls.length,
      pauses: delay.mock.calls.length,
    }).toEqual({ reads: 0, pauses: 0 });
  });

  it("does NOT throw when the read of held facts fails", async () => {
    const { dispatch, log, store } = setup();
    store.claimBy(FACT_ID, "site-pull", NOW);
    store.heldByLiveClaim = () => Promise.reject(new Error("database gone"));

    await expect(dispatch.dispatch(FACTS)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
