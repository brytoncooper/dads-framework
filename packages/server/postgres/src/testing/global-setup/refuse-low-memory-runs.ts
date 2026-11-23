import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, platform } from "node:os";
import { promisify } from "node:util";
import { getContainerRuntimeClient } from "testcontainers";
import { TEST_POSTGRES_STORAGE, testPostgresStorage, type TestPostgresStorage } from "../test-postgres-storage.js";

/**
 * A memory floor under container-tier runs. The wall against a test run
 * taking the developer's machine down.
 *
 * WHY THIS EXISTS. The slot semaphore (refuse-stacked-container-runs.ts)
 * bounds HOW MANY runs share a machine, and the gate sizes workers from
 * cores — but nothing looked at memory. On the 25 GB test VM one
 * `nx run-many` of two integration projects at Vitest's default worker count
 * took `MemAvailable` down to 1.4 GB (2026-11-18), and on a Mac the Docker VM
 * (6 GB by default) is smaller still. Out of memory, Linux kills whatever is
 * biggest — often the editor or the agent, not the test.
 *
 * WHAT IT DOES. Before a run takes its slot it measures what is free, on the
 * host and (when Docker runs in a VM) inside Docker's VM. Below the floor it
 * WAITS like the slot queue does, then refuses with what is free, what is
 * needed and how to override. It is advisory: a reading it cannot take is
 * skipped, never fatal, and the wait is bounded.
 */

const GIB = 1024 ** 3;
const INTEGRATION_WORKER_GB = 0.3;

/** Free host memory a run needs before it starts, in GB. `0` skips the check. */
export const MIN_FREE_MEMORY_GB = "DADS_TEST_MIN_FREE_MEMORY_GB";
/** Free memory inside Docker's VM a run needs, in GB. `0` skips the check. */
export const MIN_FREE_DOCKER_MEMORY_GB = "DADS_TEST_MIN_FREE_DOCKER_MEMORY_GB";
/** How long a run waits for memory before refusing. `0` refuses at once. */
export const MEMORY_WAIT_MS = "DADS_TEST_MEMORY_WAIT_MS";

const DEFAULT_MIN_FREE_GB = 4;
const DEFAULT_MIN_FREE_DOCKER_GB = 3;
/**
 * Shorter than the slot queue's ten minutes: a busy slot frees itself when its
 * run ends, but memory held by something else usually does not, and this wait
 * stacks on top of the slot wait.
 */
const DEFAULT_MEMORY_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const ANNOUNCE_INTERVAL_MS = 15_000;
/** Each reading gives up after this; a slow Docker daemon skips the Docker half. */
const READING_TIMEOUT_MS = 1_500;

/**
 * `TEST_POSTGRES_STORAGE=ram` puts a 4 GB tmpfs inside Docker. It needs that
 * much plus room for Postgres, SpiceDB and the rest of what Docker runs.
 */
export const RAM_STORAGE_MIN_DOCKER_MEMORY_GB = 8;

export type DockerMemoryReading = {
  /** All the memory Docker's containers can use: the VM's size on a Mac. */
  readonly totalBytes: number;
  /**
   * True when Docker runs in its own VM (Docker Desktop, OrbStack, colima), so
   * the host's free memory says nothing about room inside Docker.
   */
  readonly inVm: boolean;
  /** VM size minus what running containers hold; `null` when not in a VM. */
  readonly freeBytes: number | null;
};

export type MemoryReading = {
  readonly hostAvailableBytes: number;
  /** Which measurement `hostAvailableBytes` came from, for the message. */
  readonly hostSource: "MemAvailable" | "vm_stat" | "os.freemem";
  /** `null` when Docker could not be reached in time. */
  readonly docker: DockerMemoryReading | null;
};

export type MemoryThresholds = {
  readonly hostMinFreeBytes: number;
  readonly dockerMinFreeBytes: number;
  readonly waitBudgetMs: number;
};

/** Linux: `MemAvailable` — free memory plus cache the kernel can reclaim. */
export function parseLinuxMemAvailable(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match === null ? null : Number(match[1]) * 1024;
}

/**
 * macOS: free + inactive + speculative + purgeable pages, times the page size
 * `vm_stat` prints in its header.
 *
 * `os.freemem()` is only the "Pages free" line — on a 48 GB Mac it read under
 * about 1 GB while 14 GB was reclaimable cache. `memory_pressure`'s "free
 * percentage" errs the other way: it counts compressible memory as free and
 * read 27 GB on the same Mac while 18 GB sat in the compressor. Inactive pages
 * are the ones the kernel reclaims first, which is the honest middle and what
 * Activity Monitor's own figures are built from.
 */
export function parseMacAvailableMemory(vmStat: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(vmStat);
  if (pageSize === null) return null;
  const pages = (label: string): number | null => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.$`, "m").exec(vmStat);
    return match === null ? null : Number(match[1]);
  };
  const counts = [pages("Pages free"), pages("Pages inactive"), pages("Pages speculative"), pages("Pages purgeable")];
  let total = 0;
  for (const count of counts) {
    if (count === null) return null;
    total += count;
  }
  return total * Number(pageSize[1]);
}

/**
 * What one container holds that the VM cannot simply take back: its usage
 * minus inactive page cache, the same figure `docker stats` shows.
 */
export function containerWorkingSetBytes(memory: { readonly usage?: number; readonly inactiveFile?: number }): number {
  return Math.max(0, (memory.usage ?? 0) - (memory.inactiveFile ?? 0));
}

/**
 * Docker runs in a VM everywhere but Linux, and on Linux under Docker Desktop.
 * Natively on Linux its containers share the host's memory, which the host
 * reading already covers.
 */
export function dockerRunsInVm(hostPlatform: string, operatingSystem: string): boolean {
  return hostPlatform !== "linux" || /docker desktop/i.test(operatingSystem);
}

/** A knob set to nonsense is a mistake worth saying out loud. */
function readNonNegative(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number of at least 0 — got "${raw}"`);
  }
  return value;
}

export function memoryThresholds(env: Readonly<Record<string, string | undefined>>): MemoryThresholds {
  return {
    hostMinFreeBytes: readNonNegative(env, MIN_FREE_MEMORY_GB, DEFAULT_MIN_FREE_GB) * GIB,
    dockerMinFreeBytes: readNonNegative(env, MIN_FREE_DOCKER_MEMORY_GB, DEFAULT_MIN_FREE_DOCKER_GB) * GIB,
    waitBudgetMs: Math.round(readNonNegative(env, MEMORY_WAIT_MS, DEFAULT_MEMORY_WAIT_MS)),
  };
}

/** `5.8 GB` — one decimal is the precision anyone acts on. */
export function describeGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

export type MemoryPreflightDecision =
  | { readonly action: "go"; readonly message: null }
  | { readonly action: "wait"; readonly message: string }
  | { readonly action: "abort"; readonly message: string };

/**
 * The whole decision, with no measuring in it: go when every floor is met,
 * wait while the budget lasts, then refuse with what is short and how to
 * override it.
 */
export function decideMemoryPreflight(input: {
  readonly reading: MemoryReading;
  readonly thresholds: MemoryThresholds;
  readonly tier: string;
  readonly waitedMs: number;
}): MemoryPreflightDecision {
  const { reading, thresholds, tier } = input;
  const short: string[] = [];
  if (thresholds.hostMinFreeBytes > 0 && reading.hostAvailableBytes < thresholds.hostMinFreeBytes) {
    short.push(
      `host: ${describeGb(reading.hostAvailableBytes)} free (${reading.hostSource}), ` +
        `needs ${describeGb(thresholds.hostMinFreeBytes)} — ${MIN_FREE_MEMORY_GB}`,
    );
  }
  const docker = reading.docker;
  if (
    docker !== null &&
    docker.freeBytes !== null &&
    thresholds.dockerMinFreeBytes > 0 &&
    docker.freeBytes < thresholds.dockerMinFreeBytes
  ) {
    short.push(
      `Docker VM: ${describeGb(docker.freeBytes)} free of ${describeGb(docker.totalBytes)}, ` +
        `needs ${describeGb(thresholds.dockerMinFreeBytes)} — ${MIN_FREE_DOCKER_MEMORY_GB}`,
    );
  }
  if (short.length === 0) return { action: "go", message: null };

  if (input.waitedMs < thresholds.waitBudgetMs) {
    return {
      action: "wait",
      message: `waiting for memory before the ${tier} run — ${short.join("; ")}`,
    };
  }
  return {
    action: "abort",
    message:
      `not enough free memory for the ${tier} run after waiting ${String(Math.round(input.waitedMs / 1000))}s — refusing to start.\n` +
      short.map((line) => `  ${line}\n`).join("") +
      `  A run that starts anyway can push the machine out of memory, and the kernel\n` +
      `  then kills whatever is biggest — often your editor, not the test.\n` +
      `    npm run doctor            # other test runs or stale containers holding memory?\n` +
      `  To run anyway, lower the floor (0 skips it):\n` +
      `    ${MIN_FREE_MEMORY_GB}=2 ${MIN_FREE_DOCKER_MEMORY_GB}=2 <your command>`,
  };
}

export type RamStorageDecision = {
  readonly storage: TestPostgresStorage;
  readonly message: string | null;
};

/**
 * `ram` needs Docker to have room for the 4 GB tmpfs plus headroom. When it
 * does not — a Mac's default 6 GB Docker VM — the run uses disk and says why,
 * instead of letting the tmpfs push the VM's other containers out of memory.
 */
export function decideRamStorageFallback(input: {
  readonly storage: TestPostgresStorage;
  readonly docker: DockerMemoryReading | null;
}): RamStorageDecision {
  if (input.storage !== "ram" || input.docker === null) {
    return { storage: input.storage, message: null };
  }
  const needed = RAM_STORAGE_MIN_DOCKER_MEMORY_GB * GIB;
  if (input.docker.totalBytes >= needed) {
    return { storage: "ram", message: null };
  }
  const where = input.docker.inVm ? "Docker's VM has" : "this machine has";
  return {
    storage: "disk",
    message:
      `${TEST_POSTGRES_STORAGE}=ram ignored: ${where} ${describeGb(input.docker.totalBytes)} of memory, ` +
      `and ram needs ${String(RAM_STORAGE_MIN_DOCKER_MEMORY_GB)} GB (a 4 GB tmpfs plus headroom) — using disk. ` +
      `Give Docker more memory to use ram.`,
  };
}

/**
 * How many workers fit in what is free: everything above `reserveBytes`,
 * divided by what one worker was measured to need. Never below one.
 */
export function memoryWorkerLimit(input: {
  readonly availableBytes: number;
  readonly reserveBytes: number;
  readonly perWorkerBytes: number;
}): number {
  const spare = input.availableBytes - input.reserveBytes;
  return Math.max(1, Math.floor(spare / input.perWorkerBytes));
}

const run = promisify(execFile);

/** Resolves `null` instead of hanging when a reading is slow. */
function withinTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, READING_TIMEOUT_MS).unref();
    }),
  ]);
}

async function readHostAvailableMemory(): Promise<Pick<MemoryReading, "hostAvailableBytes" | "hostSource">> {
  if (platform() === "linux") {
    const meminfo = await withinTimeout(readFile("/proc/meminfo", "utf8"));
    const bytes = meminfo === null ? null : parseLinuxMemAvailable(meminfo);
    if (bytes !== null) {
      return { hostAvailableBytes: bytes, hostSource: "MemAvailable" };
    }
  }
  if (platform() === "darwin") {
    const output = await withinTimeout(run("vm_stat", [], { encoding: "utf8", timeout: READING_TIMEOUT_MS }));
    const bytes = output === null ? null : parseMacAvailableMemory(output.stdout);
    if (bytes !== null) {
      return { hostAvailableBytes: bytes, hostSource: "vm_stat" };
    }
  }
  return { hostAvailableBytes: freemem(), hostSource: "os.freemem" };
}

/**
 * Docker's memory through the same client testcontainers starts containers
 * with, so it measures the daemon the run will actually use. Inside a VM it
 * also sums what running containers hold: one `one-shot` stats call each, in
 * parallel — without `one-shot` Docker waits a second for a CPU sample.
 */
async function readDockerMemory(): Promise<DockerMemoryReading | null> {
  const client = await getContainerRuntimeClient();
  const runtime = client.info.containerRuntime;
  const inVm = dockerRunsInVm(platform(), runtime.operatingSystem);
  if (!inVm) {
    return { totalBytes: runtime.memory, inVm, freeBytes: null };
  }
  const running = (await client.container.list()).filter((container) => container.State === "running");
  // A container that is restarting or just exited reports empty stats; it
  // counts as holding nothing rather than dropping the whole reading.
  const held = await Promise.all(
    running.map(async (container) => {
      try {
        const stats = await client.container.getById(container.Id).stats({ stream: false, "one-shot": true });
        return containerWorkingSetBytes({
          usage: stats.memory_stats.usage,
          inactiveFile: stats.memory_stats.stats.inactive_file,
        });
      } catch {
        return 0;
      }
    }),
  );
  const used = held.reduce((sum, bytes) => sum + bytes, 0);
  return {
    totalBytes: runtime.memory,
    inVm,
    freeBytes: Math.max(0, runtime.memory - used),
  };
}

/** One reading of host and Docker memory; the Docker half may be `null`. */
export async function readTestMemory(): Promise<MemoryReading> {
  const [host, docker] = await Promise.all([readHostAvailableMemory(), withinTimeout(readDockerMemory())]);
  return { ...host, docker };
}

/** Thrown instead of booting, so the refusal is loud and immediate. */
export class NotEnoughTestMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotEnoughTestMemoryError";
  }
}

export type TestMemoryDeps = {
  readonly read: () => Promise<MemoryReading>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
};

const realDeps: TestMemoryDeps = {
  read: readTestMemory,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => process.stdout.write(`${line}\n`),
};

/**
 * Waits until the machine has the memory a `tier` run needs, and throws
 * `NotEnoughTestMemoryError` once the wait budget is spent. Returns the
 * reading that let it through.
 */
export async function awaitEnoughTestMemory(
  tier: string,
  options: {
    readonly thresholds?: MemoryThresholds;
    readonly deps?: Partial<TestMemoryDeps>;
  } = {},
): Promise<MemoryReading> {
  const deps: TestMemoryDeps = { ...realDeps, ...options.deps };
  const thresholds = options.thresholds ?? memoryThresholds(process.env);
  let waitedMs = 0;
  let announcedAtMs: number | null = null;
  for (;;) {
    const reading = await deps.read();
    const decision = decideMemoryPreflight({
      reading,
      thresholds,
      tier,
      waitedMs,
    });
    if (decision.action === "go") return reading;
    if (decision.action === "abort") {
      throw new NotEnoughTestMemoryError(decision.message);
    }
    if (announcedAtMs === null || waitedMs - announcedAtMs >= ANNOUNCE_INTERVAL_MS) {
      deps.log(decision.message);
      announcedAtMs = waitedMs;
    }
    await deps.sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }
}

/**
 * Turns `TEST_POSTGRES_STORAGE=ram` into `disk` in `env` when Docker is too
 * small for it, before any container starts, so every child and worker that
 * inherits `env` makes the same choice. Reads Docker only when `ram` is asked
 * for. Returns the storage the run will use.
 */
export async function applyRamStorageFallback(
  env: Record<string, string | undefined>,
  log: (line: string) => void = realDeps.log,
): Promise<TestPostgresStorage> {
  const storage = testPostgresStorage(env);
  if (storage !== "ram") return storage;
  const decision = decideRamStorageFallback({
    storage,
    docker: await withinTimeout(readDockerMemory()),
  });
  if (decision.message !== null) {
    env[TEST_POSTGRES_STORAGE] = decision.storage;
    log(decision.message);
  }
  return decision.storage;
}

/**
 * Peak memory one Vitest worker thread of an integration project adds,
 * measured 2026-11-18 on the test VM: `domain-facilities` (39 files) peaked at
 * 0.9, 1.2, 1.7 and 2.7 GB with 1, 2, 4 and 8 workers — about 0.25 GB a
 * worker, rounded up.
 */
export const INTEGRATION_WORKER_MEMORY_BYTES = INTEGRATION_WORKER_GB * GIB;

export type VitestWorkerCap = {
  /** The worker count to use, or `null` to leave Vitest's own. */
  readonly workers: number | null;
  readonly message: string | null;
};

/**
 * Vitest's default is one worker per core but one. On the 32-core test VM
 * that is 31 workers per project, and three projects at once (Nx's default
 * parallelism) outgrow 25 GB. This lowers — never raises — a container-tier
 * project's workers to what fits in free memory above the floor. It leaves
 * alone a count someone chose (`VITEST_MAX_WORKERS`, which the integration
 * gate always sets after its own memory-aware plan) and CI.
 */
export function decideVitestWorkerCap(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configuredWorkers: number | undefined;
  readonly cores: number;
  readonly availableBytes: number;
  readonly reserveBytes: number;
}): VitestWorkerCap {
  const chosen = input.env["VITEST_MAX_WORKERS"];
  if (input.env["CI"] !== undefined || (chosen !== undefined && chosen !== "")) {
    return { workers: null, message: null };
  }
  const planned = input.configuredWorkers ?? Math.max(1, input.cores - 1);
  const fit = memoryWorkerLimit({
    availableBytes: input.availableBytes,
    reserveBytes: input.reserveBytes,
    perWorkerBytes: INTEGRATION_WORKER_MEMORY_BYTES,
  });
  if (fit >= planned) return { workers: null, message: null };
  return {
    workers: fit,
    message:
      `vitest workers: ${String(fit)} instead of ${String(planned)} — ` +
      `${describeGb(input.availableBytes)} free, ${describeGb(input.reserveBytes)} kept free, ` +
      `~${describeGb(INTEGRATION_WORKER_MEMORY_BYTES)} per worker. Set VITEST_MAX_WORKERS to choose.`,
  };
}

/** The slice of Vitest's `TestProject` the cap reads and writes. */
export type VitestProjectWorkers = {
  readonly config: { maxWorkers?: number };
};

/**
 * Applies `decideVitestWorkerCap` to the project a `globalSetup` was handed.
 * Vitest reads `config.maxWorkers` when it schedules files, after every
 * `globalSetup` has run, so the lowered count takes effect for this run.
 */
export async function capVitestWorkersToFreeMemory(
  project: VitestProjectWorkers,
  cores: number,
  log: (line: string) => void = realDeps.log,
): Promise<void> {
  const host = await readHostAvailableMemory();
  const cap = decideVitestWorkerCap({
    env: process.env,
    configuredWorkers: project.config.maxWorkers,
    cores,
    availableBytes: host.hostAvailableBytes,
    reserveBytes: memoryThresholds(process.env).hostMinFreeBytes,
  });
  if (cap.workers === null) return;
  project.config.maxWorkers = cap.workers;
  if (cap.message !== null) log(cap.message);
}
