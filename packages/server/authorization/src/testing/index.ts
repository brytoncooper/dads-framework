export { FakeApplyAccessChangesAfterCommit } from "./fake-apply-after-commit.js";
export { FakeAuthorization } from "@dads-framework/access/testing";
export { RecordingAuthorization } from "@dads-framework/access/testing";
export { FakeClaimAccessChanges } from "./fake-claim.js";
export { FakeEnqueueAccessChanges } from "./fake-enqueue.js";
export { InMemoryOwnerLock } from "./in-memory-owner-lock.js";
export { proveScopeMatchesLookup } from "./prove-scope-matches-lookup.js";
export {
  SHARED_TEST_SPICE_DB_ENDPOINT,
  startSharedTestSpiceDb,
  startTestSpiceDb,
  type TestSpiceDb,
} from "./start-test-spice-db.js";
export { runOutsideHeldPartitions } from "@dads-framework/access/testing";
