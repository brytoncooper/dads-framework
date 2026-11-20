import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_PER_FILE,
  SHARED_TEST_POSTGRES_URL,
} from "../start-test-postgres.js";
import {
  CONTAINER_TEST_TIER,
  VITEST_TIER,
} from "./skip-unless-container-tests.js";
import { currentWorktreeIdentity } from "./worktree-identity.js";

export type SharedTestPostgresLease = {
  readonly runId: number;
  readonly starterPid: number;
  readonly url: string | null;
  readonly startedAt: string;
};

export type SharedTestPostgresDecision =
  | { readonly action: "skip" }
  | { readonly action: "per-file" }
  | { readonly action: "use-inherited"; readonly url: string }
  | { readonly action: "use-lease"; readonly url: string }
  | { readonly action: "wait" }
  | { readonly action: "start" }
  | { readonly action: "steal" };

/**
 * Where one checkout publishes the Postgres its run migrated.
 *
 * Keyed on the worktree: every checkout on this machine shares one tmpdir, and
 * a lease named for the tier alone would hand worktree B the template that
 * worktree A migrated from a different set of migrations.
 */
export function sharedTestPostgresLeasePath(
  dir: string = tmpdir(),
  identity: string = currentWorktreeIdentity(),
): string {
  return join(dir, `command-test-postgres-${identity}.lease`);
}

export function parseSharedTestPostgresLease(
  text: string,
): SharedTestPostgresLease | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!hasLeaseFields(raw)) return null;
  const { runId, starterPid, url, startedAt } = raw;
  if (typeof runId !== "number" || !Number.isInteger(runId)) return null;
  if (typeof starterPid !== "number" || !Number.isInteger(starterPid)) {
    return null;
  }
  if (url !== null && typeof url !== "string") return null;
  if (typeof startedAt !== "string") return null;
  return { runId, starterPid, url, startedAt };
}

function hasLeaseFields(
  raw: unknown,
): raw is Record<keyof SharedTestPostgresLease, unknown> {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "runId" in raw &&
    "starterPid" in raw &&
    "url" in raw &&
    "startedAt" in raw
  );
}

export function readSharedTestPostgresLease(
  path: string,
): SharedTestPostgresLease | null {
  if (!existsSync(path)) return null;
  return parseSharedTestPostgresLease(readFileSync(path, "utf8"));
}

export function writeSharedTestPostgresLease(
  path: string,
  lease: SharedTestPostgresLease,
): void {
  writeFileSync(path, JSON.stringify(lease));
}

export function claimSharedTestPostgresLease(
  path: string,
  lease: SharedTestPostgresLease,
): boolean {
  try {
    writeFileSync(path, JSON.stringify(lease), { flag: "wx" });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether this vitest process should boot Postgres, attach to one already
 * started for the Nx run, or do nothing.
 */
export function decideSharedTestPostgres(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly lease: SharedTestPostgresLease | null;
  readonly runId: number;
  readonly isAlive: (pid: number) => boolean;
}): SharedTestPostgresDecision {
  if (input.env[VITEST_TIER] !== CONTAINER_TEST_TIER) {
    return { action: "skip" };
  }
  if (input.env[CONTAINER_PER_FILE] === "1") {
    return { action: "per-file" };
  }
  const inherited = input.env[SHARED_TEST_POSTGRES_URL];
  if (inherited !== undefined && inherited.length > 0) {
    return { action: "use-inherited", url: inherited };
  }
  if (input.lease === null) {
    return { action: "start" };
  }
  const starterAlive = input.isAlive(input.lease.starterPid);
  if (input.lease.runId !== input.runId) {
    return starterAlive ? { action: "start" } : { action: "steal" };
  }
  if (input.lease.url !== null) {
    return { action: "use-lease", url: input.lease.url };
  }
  return starterAlive ? { action: "wait" } : { action: "steal" };
}

export async function waitForSharedTestPostgresUrl(input: {
  readonly readLease: () => SharedTestPostgresLease | null;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<string> {
  for (;;) {
    const lease = input.readLease();
    if (lease?.url !== undefined && lease.url !== null) {
      return lease.url;
    }
    if (lease === null || !input.isAlive(lease.starterPid)) {
      throw new Error(
        "shared test postgres starter died before publishing a URL",
      );
    }
    await input.sleep(50);
  }
}
