import { randomUUID } from "node:crypto";
import type { StartedTestContainer } from "testcontainers";
import { createSharedTestSpiceDb } from "./create-shared-test-spice-db.js";

const SPICE_DB_IMAGE = "authzed/spicedb:v1.57.0";
const SPICE_DB_GRPC_PORT = 50051;
const CONTAINER_PER_FILE = "CONTAINER_PER_FILE";

/**
 * Memory ceiling on a test SpiceDB container, in GB. `serve-testing` keeps one
 * in-memory datastore per caller for the life of the process, so the shared
 * one grows across a whole run; past this Docker kills it on its own instead
 * of the Docker VM running out and taking every other container with it.
 */
export const TEST_SPICE_DB_MEMORY_GB = "DADS_TEST_SPICEDB_MEMORY_GB";

/**
 * Measured 2026-11-18 on the test VM across 68 test SpiceDB containers: the
 * largest held 0.47 GB, most under 0.2 GB. Four times the largest, so a
 * normal run should never trip it
 * (not yet measured over a whole gate run).
 */
const DEFAULT_SPICE_DB_MEMORY_GB = 2;

export function testSpiceDbMemoryLimitGb(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[TEST_SPICE_DB_MEMORY_GB];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SPICE_DB_MEMORY_GB;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${TEST_SPICE_DB_MEMORY_GB} must be a number of GB above 0 — got "${raw}"`);
  }
  return value;
}

/** Inherited by integration workers when one serve-testing process is shared. */
export const SHARED_TEST_SPICE_DB_ENDPOINT = "SHARED_TEST_SPICE_DB_ENDPOINT";

export type TestSpiceDb = {
  readonly endpoint: string;
  /** Unique per caller: serve-testing uses this token as the datastore key. */
  readonly presharedKey: string;
  readonly stop: () => Promise<void>;
};

/**
 * An isolated SpiceDB datastore for one test file.
 *
 * `spicedb serve-testing` hosts many empty in-memory datastores in one process;
 * the client auth token selects the datastore. The process is shared during the
 * integration gate, while every caller receives a new token and therefore new
 * schema and relationships. Focused runs retain a self-owned container fallback.
 */
export async function startTestSpiceDb(): Promise<TestSpiceDb> {
  const sharedEndpoint = process.env[SHARED_TEST_SPICE_DB_ENDPOINT];
  if (sharedEndpoint !== undefined && process.env[CONTAINER_PER_FILE] !== "1") {
    return createSharedTestSpiceDb(sharedEndpoint, randomUUID);
  }

  const presharedKey = `dads-test-${randomUUID()}`;
  const container = await startSpiceDbContainer();
  return {
    endpoint: endpointFor(container),
    presharedKey,
    stop: () => container.stop().then(() => undefined),
  };
}

/** Start the one process inherited by every integration-test worker. */
export async function startSharedTestSpiceDb(): Promise<{
  readonly endpoint: string;
  readonly stop: () => Promise<void>;
}> {
  const container = await startSpiceDbContainer();
  return {
    endpoint: endpointFor(container),
    stop: () => container.stop().then(() => undefined),
  };
}

async function startSpiceDbContainer(): Promise<StartedTestContainer> {
  const { GenericContainer, Wait } = await import("testcontainers");
  return new GenericContainer(SPICE_DB_IMAGE)
    .withCommand(["serve-testing"])
    .withExposedPorts(SPICE_DB_GRPC_PORT)
    .withResourcesQuota({ memory: testSpiceDbMemoryLimitGb() })
    .withWaitStrategy(Wait.forLogMessage(/grpc server started serving/))
    .start();
}

function endpointFor(container: StartedTestContainer): string {
  return `${container.getHost()}:${container.getMappedPort(SPICE_DB_GRPC_PORT)}`;
}
