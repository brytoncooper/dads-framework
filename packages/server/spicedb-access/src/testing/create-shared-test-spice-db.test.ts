// A shared SpiceDB process is safe only when every test file receives a unique
// auth token, because serve-testing uses that token as the datastore boundary.
import { describe, expect, it } from "vitest";
import { createSharedTestSpiceDb } from "./create-shared-test-spice-db.js";

describe("createSharedTestSpiceDb", () => {
  it("shares the server while isolating each caller behind a unique auth token", async () => {
    let tokenSequence = 0;
    const createUniqueToken = () => `datastore-${++tokenSequence}`;

    const first = createSharedTestSpiceDb("127.0.0.1:50051", createUniqueToken);
    const second = createSharedTestSpiceDb("127.0.0.1:50051", createUniqueToken);

    expect(first.endpoint).toBe("127.0.0.1:50051");
    expect(second.endpoint).toBe(first.endpoint);
    expect(first.presharedKey).toBe("dads-test-datastore-1");
    expect(second.presharedKey).toBe("dads-test-datastore-2");
    expect(second.presharedKey).not.toBe(first.presharedKey);
    expect(tokenSequence).toBe(2);

    await expect(first.stop()).resolves.toBeUndefined();
    await expect(second.stop()).resolves.toBeUndefined();
  });
});
