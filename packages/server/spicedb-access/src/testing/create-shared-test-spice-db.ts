import type { TestSpiceDb } from "./start-test-spice-db.js";

/** Each caller owns a datastore token, never the shared server's lifetime. */
export function createSharedTestSpiceDb(
  endpoint: string,
  createUniqueToken: () => string,
): TestSpiceDb {
  return {
    endpoint,
    presharedKey: `dads-test-${createUniqueToken()}`,
    stop: () => Promise.resolve(),
  };
}
