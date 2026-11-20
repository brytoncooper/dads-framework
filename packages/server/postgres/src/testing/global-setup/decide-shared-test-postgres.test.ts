/**
 * What: one Nx integration run shares one migrated Postgres; later projects
 * attach instead of booting. Why: N vitest processes used to start N containers.
 */
import { describe, expect, it } from "vitest";
import {
  decideSharedTestPostgres,
  parseSharedTestPostgresLease,
  sharedTestPostgresLeasePath,
  type SharedTestPostgresLease,
} from "./decide-shared-test-postgres.js";

const SHARED_URL = "postgres://shared/dads_template";

const LEASE: SharedTestPostgresLease = {
  runId: 80,
  starterPid: 1001,
  url: SHARED_URL,
  startedAt: "2026-08-27T20:00:00.000Z",
};

describe("parseSharedTestPostgresLease", () => {
  it("reads a well-formed lease", () => {
    expect(parseSharedTestPostgresLease(JSON.stringify(LEASE))).toEqual(LEASE);
  });

  it("returns null for a half-written file rather than throwing", () => {
    expect(parseSharedTestPostgresLease("{ not json")).toBeNull();
    expect(parseSharedTestPostgresLease("null")).toBeNull();
    expect(
      parseSharedTestPostgresLease(JSON.stringify({ runId: 80 })),
    ).toBeNull();
  });
});

describe("decideSharedTestPostgres", () => {
  it("skips the boot on the fast tier", () => {
    expect(
      decideSharedTestPostgres({
        env: {},
        lease: null,
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "skip" });
  });

  it("leaves the honesty path alone", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration", CONTAINER_PER_FILE: "1" },
        lease: null,
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "per-file" });
  });

  it("uses a URL the wrapper already exported", () => {
    expect(
      decideSharedTestPostgres({
        env: {
          VITEST_TIER: "integration",
          SHARED_TEST_POSTGRES_URL: SHARED_URL,
        },
        lease: null,
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "use-inherited", url: SHARED_URL });
  });

  it("starts when this run has no lease yet", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration" },
        lease: null,
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "start" });
  });

  it("attaches to this run's ready lease", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration" },
        lease: LEASE,
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "use-lease", url: SHARED_URL });
  });

  it("waits when the starter is still migrating", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration" },
        lease: { ...LEASE, url: null },
        runId: 80,
        isAlive: () => true,
      }),
    ).toEqual({ action: "wait" });
  });

  it("steals when the starter died before publishing a URL", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration" },
        lease: { ...LEASE, url: null },
        runId: 80,
        isAlive: () => false,
      }),
    ).toEqual({ action: "steal" });
  });

  it("steals a leftover lease from a dead earlier run", () => {
    expect(
      decideSharedTestPostgres({
        env: { VITEST_TIER: "integration" },
        lease: { ...LEASE, runId: 11 },
        runId: 80,
        isAlive: () => false,
      }),
    ).toEqual({ action: "steal" });
  });
});

describe("sharedTestPostgresLeasePath", () => {
  it("names the file after the worktree, so two checkouts never share one", () => {
    expect(sharedTestPostgresLeasePath("/t", "abc")).toBe(
      "/t/command-test-postgres-abc.lease",
    );
    expect(sharedTestPostgresLeasePath("/t", "abc")).not.toBe(
      sharedTestPostgresLeasePath("/t", "def"),
    );
  });
});
