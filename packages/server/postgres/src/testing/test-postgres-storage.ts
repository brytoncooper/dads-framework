import type { PostgreSqlContainer } from "@testcontainers/postgresql";

/**
 * Where test Postgres keeps its data: `disk` (the default) or `ram`.
 *
 * `ram` mounts the data directory on a size-capped tmpfs and turns off
 * durability (fsync, synchronous commit, full-page writes) — test data is
 * thrown away, so a crash losing it costs nothing. Because RAM is scarce,
 * `ram` also drops each private database as soon as its file stops, where
 * `disk` keeps it until the container goes (DROP DATABASE forces a
 * checkpoint, which is slow on disk and nearly free without fsync).
 *
 * Opt in on machines with memory to spare (CI runners, the Proxmox test VM);
 * a laptop running many suites at once stays on `disk` by default.
 */
export const TEST_POSTGRES_STORAGE = "TEST_POSTGRES_STORAGE";

export type TestPostgresStorage = "disk" | "ram";

/**
 * Ceiling on one container's in-memory data directory. Past it Postgres fails
 * the write with "No space left on device" instead of the machine running out
 * of memory and killing an unrelated process.
 */
export const RAM_DATA_DIRECTORY_GB = 4;
export const RAM_DATA_DIRECTORY_LIMIT = `${String(RAM_DATA_DIRECTORY_GB)}g`;

/**
 * Memory ceiling on a test Postgres container's own processes, in GB, before
 * the tmpfs. A runaway container is then killed by Docker on its own instead
 * of taking the machine (or the Docker VM, and every container in it) down.
 */
export const TEST_POSTGRES_MEMORY_GB = "DADS_TEST_POSTGRES_MEMORY_GB";

/**
 * Measured 2026-11-18 on the test VM across 20 test Postgres containers (shared
 * and per-file, disk and ram, beside other checkouts' runs): the largest held
 * 1.3 GB of resident memory and shared buffers, most under 0.6 GB. The limit
 * is more than twice the largest, so a normal run should never trip it
 * (not yet measured over a whole gate run).
 */
const DEFAULT_POSTGRES_MEMORY_GB = 3;

const POSTGRES_DATA_DIRECTORY = "/var/lib/postgresql/data";

export function testPostgresStorage(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestPostgresStorage {
  const value = env[TEST_POSTGRES_STORAGE];
  if (value === undefined || value === "" || value === "disk") return "disk";
  if (value === "ram") return "ram";
  throw new Error(
    `${TEST_POSTGRES_STORAGE} must be "disk" or "ram", not "${value}".`,
  );
}

/** Extra `postgres -c` settings for the chosen storage. */
export function postgresStorageSettings(
  storage: TestPostgresStorage,
): readonly string[] {
  if (storage === "disk") return [];
  return [
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
  ];
}

/** Mount the data directory in memory when the storage is `ram`. */
export function withPostgresStorage(
  container: PostgreSqlContainer,
  storage: TestPostgresStorage,
): PostgreSqlContainer {
  if (storage === "disk") return container;
  return container.withTmpFs({
    [POSTGRES_DATA_DIRECTORY]: `rw,size=${RAM_DATA_DIRECTORY_LIMIT}`,
  });
}

/**
 * The container's memory limit for `storage`, in GB. In `ram` the tmpfs is
 * charged to the container too, so the limit is the process ceiling plus the
 * whole tmpfs — a full tmpfs then fails a write with "No space left on device"
 * rather than the container being killed.
 */
export function testPostgresMemoryLimitGb(
  storage: TestPostgresStorage,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[TEST_POSTGRES_MEMORY_GB];
  const processGb =
    raw === undefined || raw.trim() === ""
      ? DEFAULT_POSTGRES_MEMORY_GB
      : Number(raw);
  if (!Number.isFinite(processGb) || processGb <= 0) {
    throw new Error(
      `${TEST_POSTGRES_MEMORY_GB} must be a number of GB above 0 — got "${String(raw)}"`,
    );
  }
  return storage === "ram" ? processGb + RAM_DATA_DIRECTORY_GB : processGb;
}

/** Cap the container's memory at `testPostgresMemoryLimitGb(storage)`. */
export function withPostgresMemoryLimit(
  container: PostgreSqlContainer,
  storage: TestPostgresStorage,
): PostgreSqlContainer {
  return container.withResourcesQuota({
    memory: testPostgresMemoryLimitGb(storage),
  });
}
