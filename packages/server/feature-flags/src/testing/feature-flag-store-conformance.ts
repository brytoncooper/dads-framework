import type { FeatureFlagHistoryEntry, FeatureFlagState } from "../contract/index.js";
import { featureFlagBatchIdSchema } from "../contract/index.js";
import type { FeatureFlagStore } from "../lib/ports/feature-flag-store.js";

/** Returns an empty store each time it is called. */
export type FeatureFlagStoreFactory = () => Promise<FeatureFlagStore>;

const FIRST = "conformance.first";
const SECOND = "conformance.second";
const BATCH_ID = featureFlagBatchIdSchema.parse("01990000-0000-7000-8000-000000000001");

/**
 * Proves a `FeatureFlagStore` keeps the port's promises: it reads back what
 * it wrote, refuses a stale revision without writing any of the batch, and
 * pages history newest first. Run it against every store, the in-memory one
 * included, so a test that passes on the stand-in means the same on Postgres.
 * Throws an `Error` naming the first promise broken.
 */
export async function verifyFeatureFlagStoreConformance(createStore: FeatureFlagStoreFactory): Promise<void> {
  await readsBackWhatItWrote(await createStore());
  await refusesAStaleBatchWhole(await createStore());
  await pagesHistoryNewestFirst(await createStore());
}

function stateAt(slug: string, revision: number): FeatureFlagState {
  return {
    slug,
    audienceMode: "SELECTED_TENANTS",
    rememberedTenants: [
      { tenantId: "t-1", tenantName: "One", enabledAt: at(revision) },
      { tenantId: "t-2", tenantName: "Two", enabledAt: null },
    ],
    revision,
    globalEnabledAt: null,
    updatedAt: at(revision),
    updatedBy: "conformance-user",
  };
}

function at(revision: number): string {
  return new Date(Date.UTC(2026, 0, revision + 1)).toISOString();
}

function historyFor(state: FeatureFlagState): FeatureFlagHistoryEntry {
  return {
    batchId: BATCH_ID,
    slug: state.slug,
    revision: state.revision,
    previousState: stateAt(state.slug, state.revision - 1),
    nextState: state,
    changedAt: at(state.revision),
    changedBy: "conformance-user",
  };
}

function assertSame(actual: unknown, expected: unknown, promise: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `FeatureFlagStore broke "${promise}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Tenants are compared by id: a store need not keep their order. */
function sortedTenants(states: readonly FeatureFlagState[]) {
  return states.map((state) => ({
    ...state,
    rememberedTenants: [...state.rememberedTenants].sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
  }));
}

async function readsBackWhatItWrote(store: FeatureFlagStore): Promise<void> {
  assertSame(await store.listStates([FIRST]), [], "an empty store lists nothing");
  const first = stateAt(FIRST, 1);
  const outcome = await store.applyBatch({
    expectedRevisions: new Map([[FIRST, 0]]),
    nextStates: [first],
    history: [historyFor(first)],
  });
  assertSame(outcome, "applied", "a first write at revision 0 applies");
  const second = stateAt(FIRST, 2);
  await store.applyBatch({
    expectedRevisions: new Map([[FIRST, 1]]),
    nextStates: [second],
    history: [historyFor(second)],
  });
  assertSame(
    sortedTenants(await store.listStates([FIRST, SECOND])),
    sortedTenants([second]),
    "it reads back the latest state it wrote, and nothing it did not",
  );
}

async function refusesAStaleBatchWhole(store: FeatureFlagStore): Promise<void> {
  const existing = stateAt(SECOND, 1);
  await store.applyBatch({
    expectedRevisions: new Map([[SECOND, 0]]),
    nextStates: [existing],
    history: [historyFor(existing)],
  });
  const fresh = stateAt(FIRST, 1);
  const stale = stateAt(SECOND, 1);
  const outcome = await store.applyBatch({
    expectedRevisions: new Map([
      [FIRST, 0],
      [SECOND, 0],
    ]),
    nextStates: [fresh, stale],
    history: [historyFor(fresh), historyFor(stale)],
  });
  assertSame(outcome, "revision-conflict", "a stale revision is refused");
  assertSame(await store.listStates([FIRST]), [], "a refused batch writes none of its states");
  const history = await store.listHistory({
    slug: FIRST,
    page: 1,
    perPage: 10,
  });
  assertSame(history.total, 0, "a refused batch writes none of its history");
}

async function pagesHistoryNewestFirst(store: FeatureFlagStore): Promise<void> {
  for (const revision of [1, 2, 3]) {
    const next = stateAt(FIRST, revision);
    await store.applyBatch({
      expectedRevisions: new Map([[FIRST, revision - 1]]),
      nextStates: [next],
      history: [historyFor(next)],
    });
  }
  const page = await store.listHistory({ slug: FIRST, page: 2, perPage: 2 });
  assertSame(page.total, 3, "history counts every revision");
  assertSame(
    page.rows.map((row) => row.revision),
    [1],
    "history pages newest first",
  );
  assertSame(page.rows[0]?.nextState.rememberedTenants.length, 2, "history keeps the whole state");
}
