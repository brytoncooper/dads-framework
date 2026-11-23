/** What a slot file holds. Nothing here is secret; it is a diagnosis. */
export type ContainerTestRunLock = {
  readonly pid: number;
  readonly runId: number;
  readonly tier: string;
  /** The checkout the holder runs in, so a waiter can say where to look. */
  readonly worktree: string;
  readonly startedAt: string;
};

export type ContainerTierSemaphoreDecision =
  | { readonly action: "reenter"; readonly message: null }
  | { readonly action: "take"; readonly slot: number; readonly message: null }
  | {
      readonly action: "steal";
      readonly slot: number;
      readonly message: string;
    }
  | { readonly action: "wait"; readonly message: string }
  | { readonly action: "abort"; readonly message: string };

/**
 * Parses a slot file, tolerating anything a half-written file might contain —
 * including a record written before slots knew about worktrees.
 */
export function parseContainerTestRunLock(text: string): ContainerTestRunLock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!hasRequiredSlotFields(raw)) return null;
  const { pid, runId, tier, startedAt } = raw;
  const worktree = "worktree" in raw ? raw.worktree : "";
  if (!isInteger(pid) || !isInteger(runId)) return null;
  if (typeof tier !== "string" || typeof startedAt !== "string") return null;
  if (typeof worktree !== "string") return null;
  return { pid, runId, tier, worktree, startedAt };
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function hasRequiredSlotFields(raw: unknown): raw is Record<"pid" | "tier" | "startedAt" | "runId", unknown> {
  return (
    typeof raw === "object" && raw !== null && "pid" in raw && "tier" in raw && "startedAt" in raw && "runId" in raw
  );
}

/** Human-readable age, so the message says "started 4m ago" not a timestamp. */
function describeAge(startedAt: string, now: Date): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now.getTime() - started) / 1000));
  if (seconds < 90) return `${String(seconds)}s ago`;
  return `${String(Math.round(seconds / 60))}m ago`;
}

/** `pid 99 in /checkouts/command, started 4m ago` — everything a human needs. */
function describeHolder(held: ContainerTestRunLock, now: Date): string {
  const where = held.worktree.length === 0 ? "" : ` in ${held.worktree}`;
  return `pid ${String(held.pid)}${where}, started ${describeAge(held.startedAt, now)}`;
}

function refusal(input: {
  readonly headline: string;
  readonly holders: readonly ContainerTestRunLock[];
  readonly now: Date;
}): string {
  const [first] = input.holders;
  const killHint = first === undefined ? "" : `    kill ${String(first.pid)}\n`;
  return (
    `${input.headline}\n` +
    input.holders.map((held) => `  holder: ${describeHolder(held, input.now)}\n`).join("") +
    `  Stacked runs cannot finish: they compete for the same Docker daemon and CPU,\n` +
    `  so each one looks slow and invites another retry. Kill one or wait.\n` +
    killHint +
    `    npm run doctor         # see what is actually on this box\n` +
    `    npm run doctor -- --fix   # reap orphans and stale containers`
  );
}

function waitOrRefuse(input: {
  readonly waitedMs: number;
  readonly waitBudgetMs: number;
  readonly waiting: string;
  readonly refused: string;
}): ContainerTierSemaphoreDecision {
  if (input.waitedMs < input.waitBudgetMs) {
    return { action: "wait", message: input.waiting };
  }
  return { action: "abort", message: input.refused };
}

/**
 * The whole decision, with no filesystem in it: re-enter a slot this run
 * already holds, queue behind this worktree's own run, take a free slot, steal
 * a dead holder's, queue behind foreign runs, and refuse once the wait budget
 * is spent. Slot numbers are 1-based, matching `<slot>.lock`.
 */
type SemaphoreState = {
  readonly slots: readonly (ContainerTestRunLock | null)[];
  readonly isAlive: (pid: number) => boolean;
  readonly now: Date;
  readonly tier: string;
  readonly runId: number;
  readonly worktree: string;
  readonly waitedMs: number;
  readonly waitBudgetMs: number;
};

export function decideContainerTierSemaphore(input: SemaphoreState): ContainerTierSemaphoreDecision {
  const { slots, isAlive, now, tier, runId } = input;

  // Same nx invocation: a sibling project already holds a slot. One
  // `nx run-many` is ONE run, however many projects it fans out to.
  if (slots.some((held) => held?.runId === runId)) {
    return { action: "reenter", message: null };
  }

  const queuedBehindWorktree = decideWorktreeWait(input);
  if (queuedBehindWorktree !== null) return queuedBehindWorktree;

  for (const [index, held] of slots.entries()) {
    if (held === null) return { action: "take", slot: index + 1, message: null };
  }

  for (const [index, held] of slots.entries()) {
    if (held !== null && !isAlive(held.pid)) {
      return {
        action: "steal",
        slot: index + 1,
        message: `stale ${held.tier} slot ${String(index + 1)} from pid ${String(held.pid)} (dead) — taking it`,
      };
    }
  }

  const holders = slots.filter((held): held is ContainerTestRunLock => held !== null);
  const [first] = holders;
  const busy = `${String(holders.length)} of ${String(slots.length)} container-tier slots busy`;
  return waitOrRefuse({
    waitedMs: input.waitedMs,
    waitBudgetMs: input.waitBudgetMs,
    waiting:
      first === undefined
        ? `waiting for a ${tier} slot — ${busy}`
        : `waiting for ${describeHolder(first, now)} — ${busy}`,
    refused: refusal({
      headline: `all ${String(slots.length)} ${tier} slots stayed busy past the wait budget — refusing to stack.`,
      holders,
      now,
    }),
  });
}

function decideWorktreeWait(input: SemaphoreState): ContainerTierSemaphoreDecision | null {
  const { slots, isAlive, now, tier, worktree } = input;
  const mine = slots.find(
    (held): held is ContainerTestRunLock =>
      held !== null && held.worktree.length > 0 && held.worktree === worktree && isAlive(held.pid),
  );
  if (mine === undefined) return null;
  return waitOrRefuse({
    waitedMs: input.waitedMs,
    waitBudgetMs: input.waitBudgetMs,
    waiting:
      `another ${tier} run is already going in THIS worktree, ${describeHolder(mine, now)} — waiting for it.\n` +
      `  One run per checkout: two would share this checkout's template postgres.`,
    refused: refusal({
      headline: `another ${tier} run in THIS worktree outlasted the wait budget — refusing to stack.`,
      holders: [mine],
      now,
    }),
  });
}
