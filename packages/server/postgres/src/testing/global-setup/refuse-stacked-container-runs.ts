import {
  decideContainerTierSemaphore,
  parseContainerTestRunLock,
  type ContainerTierSemaphoreDecision,
  type ContainerTestRunLock,
} from "./container-tier-semaphore.js";
export {
  decideContainerTierSemaphore,
  parseContainerTestRunLock,
  type ContainerTierSemaphoreDecision,
  type ContainerTestRunLock,
} from "./container-tier-semaphore.js";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARED_TEST_POSTGRES_URL } from "../start-test-postgres.js";
import { currentWorktreePath } from "./worktree-identity.js";

/**
 * A counting semaphore over container-tier runs. The wall against pileups.
 *
 * WHY THIS EXISTS. On 2026-08-02 a root npm script became an inferred Nx target
 * and re-invoked itself, and separately a foreground run that hit its timeout
 * orphaned its process tree so every retry added another full sweep. The box
 * reached ~200 concurrent runs and 74 containers; nothing could finish, so
 * every run looked "slow" rather than "duplicated", which invited more retries.
 * The failure mode is not any one of those bugs — it is that stacking is
 * SILENT. Nothing anywhere said "one of these is already running."
 *
 * WHY IT COUNTS INSTEAD OF REFUSING. The first version allowed exactly one run
 * per machine, which was right when one checkout was the only checkout. With a
 * worktree per initiative, a single writer means an agent's integration run
 * refuses because an unrelated checkout is busy. So the tier now owns N slots
 * (`DADS_TEST_TIER_SLOTS`, default 2): a run takes a free one, and when all
 * are busy it QUEUES rather than dying, printing who it is waiting for and
 * where. The refusal is still there — it is what happens when the wait budget
 * (`DADS_TEST_TIER_WAIT_MS`, default ten minutes) runs out.
 *
 * ONE RUN PER WORKTREE, THOUGH. Two runs in one checkout would share that
 * checkout's migrated template Postgres, so a live slot held by this worktree
 * makes a second run wait however many slots are free.
 *
 * ADVISORY, NOT MANDATORY, AND DELIBERATELY SO. A slot is a pidfile, not an
 * OS lock: a crashed run leaves the file behind, and the next run STEALS it
 * once it sees the holder's pid is gone. A lock that can wedge a repo after a
 * crash would be worse than the pileup it prevents.
 */

/** The number of container-tier runs this machine allows at once. */
export const CONTAINER_TIER_SLOTS = "DADS_TEST_TIER_SLOTS";
/** How long a run queues for a slot before refusing. `0` refuses at once. */
export const CONTAINER_TIER_WAIT_MS = "DADS_TEST_TIER_WAIT_MS";

const DEFAULT_SLOTS = 2;
const DEFAULT_WAIT_BUDGET_MS = 600_000;
const POLL_INTERVAL_MS = 2_000;
const ANNOUNCE_INTERVAL_MS = 15_000;

/**
 * The pid of the `nx` invocation this process belongs to, so the 12 projects
 * of ONE `nx run-many -t test:integration` share a slot instead of fighting
 * over it. Each project gets its own vitest process and its own `globalSetup`,
 * and without this the second project to start would abort the run it is part
 * of — which is exactly what happened the first time this shipped.
 *
 * A direct `vitest run` with no `nx` ancestor gets its own pid, so two of those
 * still see each other as separate runs and the second queues. That is the
 * behaviour we want in both directions.
 */
export function findNxRunProcessId(
  pid: number,
  table: ReadonlyMap<number, { readonly ppid: number; readonly command: string }>,
): number {
  let current = pid;
  let root = pid;
  const seen = new Set<number>();
  while (!seen.has(current)) {
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) break;
    if (/\bnx\b/.test(entry.command)) root = current;
    if (entry.ppid <= 1) break;
    current = entry.ppid;
  }
  return root;
}

/** A release that owns nothing. Named so it is not an empty arrow literal. */
const noRelease = (): void => undefined;

/** Thrown instead of booting, so the abort is loud and immediate. */
export class ContainerTestRunAlreadyActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerTestRunAlreadyActiveError";
  }
}

/** The tier's slot directory: `command-test-tier-integration/1.lock …`. */
export function containerTestRunLockDir(tier: string, dir: string = tmpdir()): string {
  return join(dir, `command-test-tier-${tier}`);
}

/** One slot file. `slot` is 1-based, so the names read as a count. */
export function containerTierSlotPath(tier: string, slot: number, dir: string = tmpdir()): string {
  return join(containerTestRunLockDir(tier, dir), `${String(slot)}.lock`);
}

/** A knob that is set to nonsense is a mistake worth saying out loud. */
function readNumericSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${String(minimum)} — got "${raw}"`);
  }
  return value;
}

export function containerTierSlotCount(env: Readonly<Record<string, string | undefined>>): number {
  return readNumericSetting(env, CONTAINER_TIER_SLOTS, DEFAULT_SLOTS, 1);
}

export function containerTierWaitBudgetMs(env: Readonly<Record<string, string | undefined>>): number {
  return readNumericSetting(env, CONTAINER_TIER_WAIT_MS, DEFAULT_WAIT_BUDGET_MS, 0);
}

/**
 * Set by a wrapper that already holds this run's slot (`run-integration-gate.ts`)
 * on the projects it starts after its shared vendors have stopped. Those
 * children inherit no shared Postgres URL, and without this they would queue
 * behind their own parent's slot until the wait budget ran out.
 */
export const CONTAINER_TIER_SLOT_HELD = "DADS_TEST_TIER_SLOT_HELD";

/**
 * The wrapper that starts shared Postgres holds the slot; children inherit
 * the URL (or the held-slot marker) and must not take a second slot with a
 * different nx runId.
 */
export function shouldHoldContainerTestRunLock(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env["CI"] !== undefined) return false;
  if (env[CONTAINER_TIER_SLOT_HELD] === "1") return false;
  const inherited = env[SHARED_TEST_POSTGRES_URL];
  return inherited === undefined || inherited.length === 0;
}

/** `process.kill(pid, 0)` throws only when the process is gone (or not ours). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

/** Reads the process table once, so `findNxRunProcessId` has something to walk. */
function processTable(): Map<number, { ppid: number; command: string }> {
  const table = new Map<number, { ppid: number; command: string }>();
  try {
    const text = execFileSync("ps", ["-eo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 4000,
    });
    for (const line of text.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      table.set(Number(match[1]), {
        ppid: Number(match[2]),
        command: match[3] ?? "",
      });
    }
  } catch {
    // No `ps` (or it timed out): fall back to a per-process run id, which is
    // stricter rather than looser — worst case a sibling waits its turn.
  }
  return table;
}

export type ContainerTierSlotDeps = {
  readonly readLock: (path: string) => string | null;
  readonly writeLock: (path: string, text: string) => void;
  readonly removeLock: (path: string) => void;
  readonly isAlive: (pid: number) => boolean;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pid: number;
  readonly runId: () => number;
  readonly worktree: () => string;
  readonly log: (line: string) => void;
};

const realDeps: ContainerTierSlotDeps = {
  readLock: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeLock: (path, text) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  },
  removeLock: (path) => {
    rmSync(path, { force: true });
  },
  isAlive: processIsAlive,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid: process.pid,
  runId: () => findNxRunProcessId(process.pid, processTable()),
  worktree: currentWorktreePath,
  log: (line) => process.stdout.write(`${line}\n`),
};

export function currentNxRunId(): number {
  return findNxRunProcessId(process.pid, processTable());
}

function readSlot(deps: ContainerTierSlotDeps, path: string): ContainerTestRunLock | null {
  const text = deps.readLock(path);
  return text === null ? null : parseContainerTestRunLock(text);
}

/**
 * Takes a slot for `tier`, queueing until one frees up, and throws
 * `ContainerTestRunAlreadyActiveError` once the wait budget is spent. Returns
 * the release function, which only removes the file if this process still owns
 * it — a run that had its slot stolen must not delete its successor's.
 */
export async function acquireContainerTierSlot(
  tier: string,
  options: {
    readonly dir?: string;
    readonly slots?: number;
    readonly waitBudgetMs?: number;
    readonly deps?: Partial<ContainerTierSlotDeps>;
    /**
     * Runs once, the first time this run is about to take or steal a slot —
     * never for a sibling project that re-enters its run's slot. The memory
     * preflight goes here, so it measures before this run uses anything.
     */
    readonly beforeTake?: () => Promise<void>;
  } = {},
): Promise<() => void> {
  const deps: ContainerTierSlotDeps = { ...realDeps, ...options.deps };
  const slotCount = options.slots ?? containerTierSlotCount(process.env);
  return waitForSlot({
    tier,
    deps,
    dir: options.dir,
    paths: Array.from({ length: slotCount }, (_unused, index) => containerTierSlotPath(tier, index + 1, options.dir)),
    runId: deps.runId(),
    worktree: deps.worktree(),
    waitBudgetMs: options.waitBudgetMs ?? containerTierWaitBudgetMs(process.env),
    beforeTake: options.beforeTake,
  });
}

type SlotSearch = {
  readonly tier: string;
  readonly deps: ContainerTierSlotDeps;
  readonly dir: string | undefined;
  readonly paths: readonly string[];
  readonly runId: number;
  readonly worktree: string;
  readonly waitBudgetMs: number;
  readonly beforeTake: (() => Promise<void>) | undefined;
};

async function waitForSlot(search: SlotSearch): Promise<() => void> {
  const { deps, paths, tier, runId, worktree, waitBudgetMs } = search;
  const logWait = createWaitLogger(deps.log);
  let waitedMs = 0;
  let beforeTake = search.beforeTake;

  for (;;) {
    const decision = decideContainerTierSemaphore({
      slots: paths.map((path) => readSlot(deps, path)),
      isAlive: deps.isAlive,
      now: deps.now(),
      tier,
      runId,
      worktree,
      waitedMs,
      waitBudgetMs,
    });

    // A sibling project of the same run already holds a slot: nothing to
    // write, and nothing to release — the project that took it owns teardown.
    if (decision.action === "reenter") return noRelease;

    if (decision.action === "abort") {
      throw new ContainerTestRunAlreadyActiveError(decision.message);
    }

    if (decision.action === "wait") {
      logWait(decision.message, waitedMs);
    } else if (beforeTake !== undefined) {
      // The hook may wait; the slots can change meanwhile, so decide again.
      await beforeTake();
      beforeTake = undefined;
      continue;
    } else {
      const release = tryTakeSlot(tier, decision, search);
      if (release !== null) return release;
    }
    await deps.sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }
}

function createWaitLogger(log: (line: string) => void) {
  let announcedAtMs: number | null = null;
  return (message: string, waitedMs: number): void => {
    if (announcedAtMs !== null && waitedMs - announcedAtMs < ANNOUNCE_INTERVAL_MS) return;
    log(message);
    announcedAtMs = waitedMs;
  };
}

function tryTakeSlot(
  tier: string,
  decision: Extract<ContainerTierSemaphoreDecision, { action: "take" | "steal" }>,
  context: {
    readonly runId: number;
    readonly worktree: string;
    readonly dir: string | undefined;
    readonly deps: ContainerTierSlotDeps;
  },
): (() => void) | null {
  const { runId, worktree, dir, deps } = context;
  if (decision.action === "steal") deps.log(decision.message);

  const path = containerTierSlotPath(tier, decision.slot, dir);
  const mine: ContainerTestRunLock = {
    pid: deps.pid,
    runId,
    tier,
    worktree,
    startedAt: deps.now().toISOString(),
  };
  deps.writeLock(path, JSON.stringify(mine));

  // Two runs can pick the same slot in the same instant; the file says which
  // one ended up with it. The loser waits a tick and picks again.
  if (readSlot(deps, path)?.pid === deps.pid) {
    return () => {
      if (readSlot(deps, path)?.pid === deps.pid) deps.removeLock(path);
    };
  }
  return null;
}
