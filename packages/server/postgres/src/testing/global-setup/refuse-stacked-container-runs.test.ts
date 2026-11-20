/**
 * What: N container-tier runs may share this machine, one per worktree. Why:
 * a single writer refused an agent's run because an unrelated checkout was busy.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_TEST_POSTGRES_URL } from "../start-test-postgres.js";
import {
  acquireContainerTierSlot,
  containerTestRunLockDir,
  containerTierSlotCount,
  containerTierSlotPath,
  containerTierWaitBudgetMs,
  ContainerTestRunAlreadyActiveError,
  decideContainerTierSemaphore,
  findNxRunProcessId,
  parseContainerTestRunLock,
  processIsAlive,
  CONTAINER_TIER_SLOT_HELD,
  shouldHoldContainerTestRunLock,
  type ContainerTestRunLock,
  type ContainerTierSlotDeps,
} from "./refuse-stacked-container-runs.js";

const NOW = new Date("2026-08-02T22:00:00.000Z");
const THIS_WORKTREE = "/checkouts/command";
const OTHER_WORKTREE = "/checkouts/command/.claude/worktrees/dev-slots";

function held(
  overrides: Partial<ContainerTestRunLock> = {},
): ContainerTestRunLock {
  return {
    pid: 99,
    runId: 555,
    tier: "integration",
    worktree: OTHER_WORKTREE,
    startedAt: "2026-08-02T21:56:00.000Z",
    ...overrides,
  };
}

/** Everything the decision needs except the rows under test. */
function ask(
  slots: readonly (ContainerTestRunLock | null)[],
  overrides: {
    readonly isAlive?: (pid: number) => boolean;
    readonly runId?: number;
    readonly worktree?: string;
    readonly waitedMs?: number;
    readonly waitBudgetMs?: number;
  } = {},
) {
  return decideContainerTierSemaphore({
    slots,
    isAlive: overrides.isAlive ?? (() => true),
    now: NOW,
    tier: "integration",
    runId: overrides.runId ?? 999,
    worktree: overrides.worktree ?? THIS_WORKTREE,
    waitedMs: overrides.waitedMs ?? 0,
    waitBudgetMs: overrides.waitBudgetMs ?? 600_000,
  });
}

/** An in-memory slot directory, so the test never touches a real tmpdir. */
function fakeDeps(
  overrides: Partial<ContainerTierSlotDeps> & {
    readonly files?: Map<string, string>;
    readonly lines?: string[];
  } = {},
): ContainerTierSlotDeps & {
  readonly files: Map<string, string>;
  readonly lines: string[];
} {
  const files = overrides.files ?? new Map<string, string>();
  const lines = overrides.lines ?? [];
  return {
    files,
    lines,
    readLock: (path) => files.get(path) ?? null,
    writeLock: (path, text) => {
      files.set(path, text);
    },
    removeLock: (path) => {
      files.delete(path);
    },
    isAlive: () => false,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    pid: 4242,
    runId: () => 7777,
    worktree: () => THIS_WORKTREE,
    log: (line) => {
      lines.push(line);
    },
    ...overrides,
  };
}

describe("parseContainerTestRunLock", () => {
  it("reads a well-formed record", () => {
    expect(parseContainerTestRunLock(JSON.stringify(held()))).toEqual(held());
  });

  it("reads an old record written before slots knew about worktrees", () => {
    const record = parseContainerTestRunLock(
      JSON.stringify({ pid: 7, runId: 3, tier: "integration", startedAt: "x" }),
    );
    expect(record).toEqual({
      pid: 7,
      runId: 3,
      tier: "integration",
      worktree: "",
      startedAt: "x",
    });
  });

  it("returns null for a half-written or foreign file rather than throwing", () => {
    expect(parseContainerTestRunLock("{ not json")).toBeNull();
    expect(parseContainerTestRunLock("null")).toBeNull();
    expect(parseContainerTestRunLock(JSON.stringify({ pid: "7" }))).toBeNull();
    expect(
      parseContainerTestRunLock(
        JSON.stringify({ pid: 1.5, tier: "a", startedAt: "b" }),
      ),
    ).toBeNull();
    expect(
      parseContainerTestRunLock(JSON.stringify({ ...held(), worktree: 7 })),
    ).toBeNull();
  });
});

describe("decideContainerTierSemaphore", () => {
  it("RE-ENTERS for a sibling project of the same nx run, before anything else", () => {
    // One `nx run-many -t test:integration` fans out to 12 projects, each with
    // its own vitest process and its own globalSetup. They are ONE run, and
    // the first shipped version aborted 11 of them.
    const decision = ask(
      [held({ runId: 555 }), held({ pid: 77, runId: 555 })],
      {
        runId: 555,
      },
    );
    expect(decision.action).toBe("reenter");
  });

  it("WAITS for this worktree's own live run even though a slot is free", () => {
    const decision = ask([held({ worktree: THIS_WORKTREE }), null]);
    expect(decision.action).toBe("wait");
    expect(decision.message).toContain("THIS worktree");
    expect(decision.message).toContain("pid 99");
    expect(decision.message).toContain("4m ago");
  });

  it("ignores an old record with no worktree when asking whether this checkout is busy", () => {
    const decision = ask([held({ worktree: "" }), null], { worktree: "" });
    expect(decision).toEqual({ action: "take", slot: 2, message: null });
  });

  it("TAKES the first free slot", () => {
    expect(ask([held(), null])).toEqual({
      action: "take",
      slot: 2,
      message: null,
    });
    expect(ask([null, null])).toEqual({
      action: "take",
      slot: 1,
      message: null,
    });
  });

  it("STEALS a dead holder's slot — a crash must not wedge the repo", () => {
    const decision = ask([held({ pid: 99 }), held({ pid: 77 })], {
      isAlive: (pid) => pid !== 77,
    });
    expect(decision.action).toBe("steal");
    expect(decision).toMatchObject({ slot: 2 });
    expect(decision.message).toContain("stale");
    expect(decision.message).toContain("dead");
  });

  it("WAITS while every slot is live and foreign, naming who and where", () => {
    const decision = ask([held({ pid: 99 }), held({ pid: 77 })]);
    expect(decision.action).toBe("wait");
    expect(decision.message).toContain("pid 99");
    expect(decision.message).toContain(OTHER_WORKTREE);
    expect(decision.message).toContain("4m ago");
    expect(decision.message).toContain("2 of 2 container-tier slots busy");
  });

  it("ABORTS once the wait budget is spent, listing every holder", () => {
    const decision = ask([held({ pid: 99 }), held({ pid: 77 })], {
      waitedMs: 600_000,
      waitBudgetMs: 600_000,
    });
    expect(decision.action).toBe("abort");
    expect(decision.message).toContain("refusing to stack");
    expect(decision.message).toContain("pid 99");
    expect(decision.message).toContain("pid 77");
    expect(decision.message).toContain("kill 99");
    expect(decision.message).toContain("npm run doctor");
  });

  it("ABORTS rather than waiting forever on this worktree's own run", () => {
    const decision = ask([held({ worktree: THIS_WORKTREE })], {
      waitedMs: 1,
      waitBudgetMs: 0,
    });
    expect(decision.action).toBe("abort");
    expect(decision.message).toContain("THIS worktree");
  });

  it("survives an unparseable startedAt", () => {
    const decision = ask([held({ startedAt: "not-a-date" })]);
    expect(decision.message).toContain("unknown time");
  });
});

describe("containerTierSlotCount / containerTierWaitBudgetMs", () => {
  it("allows two runs and waits ten minutes by default", () => {
    expect(containerTierSlotCount({})).toBe(2);
    expect(containerTierWaitBudgetMs({})).toBe(600_000);
  });

  it("reads the environment, where 0 means refuse at once", () => {
    expect(containerTierSlotCount({ DADS_TEST_TIER_SLOTS: "4" })).toBe(4);
    expect(containerTierWaitBudgetMs({ DADS_TEST_TIER_WAIT_MS: "0" })).toBe(0);
  });

  it("refuses nonsense loudly instead of silently running with the default", () => {
    expect(() => containerTierSlotCount({ DADS_TEST_TIER_SLOTS: "0" })).toThrow(
      "DADS_TEST_TIER_SLOTS",
    );
    expect(() =>
      containerTierWaitBudgetMs({ DADS_TEST_TIER_WAIT_MS: "soon" }),
    ).toThrow("DADS_TEST_TIER_WAIT_MS");
  });
});

describe("acquireContainerTierSlot", () => {
  const dir = "/virtual";
  const first = containerTierSlotPath("integration", 1, dir);
  const second = containerTierSlotPath("integration", 2, dir);

  it("writes its own pid, run, worktree and start time, then releases", async () => {
    const deps = fakeDeps();
    const release = await acquireContainerTierSlot("integration", {
      dir,
      slots: 2,
      deps,
    });
    expect(parseContainerTestRunLock(deps.files.get(first) ?? "")).toEqual({
      pid: 4242,
      runId: 7777,
      tier: "integration",
      worktree: THIS_WORKTREE,
      startedAt: NOW.toISOString(),
    });
    release();
    expect(deps.files.has(first)).toBe(false);
  });

  it("runs beforeTake once before taking a slot, and never on re-entry", async () => {
    const files = new Map<string, string>();
    let checks = 0;
    const beforeTake = (): Promise<void> => {
      checks += 1;
      return Promise.resolve();
    };
    await acquireContainerTierSlot("integration", {
      dir,
      slots: 2,
      beforeTake,
      deps: fakeDeps({ files, runId: () => 111 }),
    });
    expect(checks).toBe(1);
    // A sibling project of the same nx run re-enters: no second check.
    await acquireContainerTierSlot("integration", {
      dir,
      slots: 2,
      beforeTake,
      deps: fakeDeps({ files, pid: 5151, runId: () => 111 }),
    });
    expect(checks).toBe(1);
  });

  it("takes no slot when beforeTake refuses", async () => {
    const deps = fakeDeps();
    await expect(
      acquireContainerTierSlot("integration", {
        dir,
        slots: 2,
        deps,
        beforeTake: () => Promise.reject(new Error("not enough memory")),
      }),
    ).rejects.toThrow("not enough memory");
    expect(deps.files.size).toBe(0);
  });

  it("gives a second worktree the second slot instead of refusing it", async () => {
    const files = new Map<string, string>();
    await acquireContainerTierSlot("integration", {
      dir,
      slots: 2,
      deps: fakeDeps({
        files,
        pid: 1001,
        runId: () => 111,
        worktree: () => THIS_WORKTREE,
        isAlive: () => true,
      }),
    });
    await acquireContainerTierSlot("integration", {
      dir,
      slots: 2,
      deps: fakeDeps({
        files,
        pid: 2002,
        runId: () => 222,
        worktree: () => OTHER_WORKTREE,
        isAlive: () => true,
      }),
    });
    expect(parseContainerTestRunLock(files.get(first) ?? "")?.pid).toBe(1001);
    expect(parseContainerTestRunLock(files.get(second) ?? "")?.pid).toBe(2002);
  });

  it("SEEDED VIOLATION: a third run refuses once both slots are busy", async () => {
    const files = new Map<string, string>();
    for (const [pid, runId, worktree] of [
      [1001, 111, "/checkouts/a"],
      [2002, 222, "/checkouts/b"],
    ] as const) {
      await acquireContainerTierSlot("integration", {
        dir,
        slots: 2,
        deps: fakeDeps({
          files,
          pid,
          runId: () => runId,
          worktree: () => worktree,
          isAlive: () => true,
        }),
      });
    }
    await expect(
      acquireContainerTierSlot("integration", {
        dir,
        slots: 2,
        waitBudgetMs: 0,
        deps: fakeDeps({
          files,
          pid: 3003,
          runId: () => 333,
          worktree: () => "/checkouts/c",
          isAlive: () => true,
        }),
      }),
    ).rejects.toThrow(ContainerTestRunAlreadyActiveError);
    // Both holders' slots are untouched — the loser must not clobber them.
    expect(parseContainerTestRunLock(files.get(first) ?? "")?.pid).toBe(1001);
    expect(parseContainerTestRunLock(files.get(second) ?? "")?.pid).toBe(2002);
  });

  it("queues, says who it is waiting for, and takes the slot when it frees", async () => {
    const files = new Map<string, string>();
    files.set(
      first,
      JSON.stringify(held({ pid: 1001, runId: 111, worktree: "/checkouts/a" })),
    );
    const lines: string[] = [];
    const deps = fakeDeps({
      files,
      lines,
      pid: 2002,
      runId: () => 222,
      worktree: () => "/checkouts/b",
      isAlive: () => true,
      // The holder finishes while this run is asleep.
      sleep: () => {
        files.delete(first);
        return Promise.resolve();
      },
    });
    await acquireContainerTierSlot("integration", { dir, slots: 1, deps });
    expect(lines.join("\n")).toContain("waiting for pid 1001 in /checkouts/a");
    expect(lines.join("\n")).toContain("1 of 1 container-tier slots busy");
    expect(parseContainerTestRunLock(files.get(first) ?? "")?.pid).toBe(2002);
  });

  it("steals a dead holder's slot and says so", async () => {
    const files = new Map<string, string>();
    files.set(first, JSON.stringify(held({ pid: 1001, runId: 111 })));
    const lines: string[] = [];
    const deps = fakeDeps({ files, lines, pid: 2002, isAlive: () => false });
    await acquireContainerTierSlot("integration", { dir, slots: 1, deps });
    expect(parseContainerTestRunLock(files.get(first) ?? "")?.pid).toBe(2002);
    expect(lines.join("\n")).toContain("stale");
  });

  it("release is a no-op once another run has stolen the slot", async () => {
    const files = new Map<string, string>();
    const release = await acquireContainerTierSlot("integration", {
      dir,
      slots: 1,
      deps: fakeDeps({ files, pid: 1001 }),
    });
    // Someone else stole it while this run was busy.
    files.set(first, JSON.stringify(held({ pid: 3003, runId: 333 })));
    release();
    expect(parseContainerTestRunLock(files.get(first) ?? "")?.pid).toBe(3003);
  });

  it("removes only its own slot file on a real filesystem", async () => {
    const root = mkdtempSync(join(tmpdir(), "dads-tier-slots-"));
    try {
      const release = await acquireContainerTierSlot("integration", {
        dir: root,
        slots: 2,
        deps: {
          pid: 1001,
          runId: () => 111,
          worktree: () => "/checkouts/a",
          isAlive: () => true,
        },
      });
      const neighbour = containerTierSlotPath("integration", 2, root);
      writeFileSync(neighbour, JSON.stringify(held({ pid: 2002, runId: 222 })));
      release();
      expect(
        parseContainerTestRunLock(readFileSync(neighbour, "utf8"))?.pid,
      ).toBe(2002);
      expect(() =>
        readFileSync(containerTierSlotPath("integration", 1, root), "utf8"),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("processIsAlive", () => {
  it("is true for this process and false for a pid that cannot exist", () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(2 ** 30)).toBe(false);
  });
});

describe("findNxRunProcessId", () => {
  /** vitest worker -> nx run-executor -> nx run-many -> the shell. */
  const table = new Map([
    [100, { ppid: 90, command: "node .../vitest/dist/worker.js" }],
    [90, { ppid: 80, command: "node .../nx/dist/bin/run-executor.js" }],
    [
      80,
      { ppid: 10, command: "node .../.bin/nx run-many -t test:integration" },
    ],
    [10, { ppid: 1, command: "-zsh" }],
  ]);

  it("returns the nx invocation, so sibling projects share one run id", () => {
    expect(findNxRunProcessId(100, table)).toBe(80);
    // A second project of the same run walks up to the same pid.
    const sibling = new Map(table).set(200, {
      ppid: 90,
      command: "node .../vitest/dist/worker.js",
    });
    expect(findNxRunProcessId(200, sibling)).toBe(80);
  });

  it("falls back to the process itself when no nx ancestor exists", () => {
    const direct = new Map([
      [
        500,
        {
          ppid: 10,
          command: "node .../vitest run --root apps/service/api/server",
        },
      ],
      [10, { ppid: 1, command: "-zsh" }],
    ]);
    // Two bare vitest runs therefore see each other as separate runs, which is
    // what we want — each takes its own slot.
    expect(findNxRunProcessId(500, direct)).toBe(500);
  });

  it("terminates on a cycle rather than spinning", () => {
    const cyclic = new Map([
      [1, { ppid: 2, command: "a" }],
      [2, { ppid: 1, command: "b" }],
    ]);
    expect(findNxRunProcessId(1, cyclic)).toBe(1);
  });
});

describe("shouldHoldContainerTestRunLock", () => {
  it("skips when the postgres wrapper already published a URL", () => {
    expect(
      shouldHoldContainerTestRunLock({
        [SHARED_TEST_POSTGRES_URL]: "postgres://shared/template",
      }),
    ).toBe(false);
  });

  it("skips in CI and holds locally when no URL is inherited", () => {
    expect(shouldHoldContainerTestRunLock({ CI: "true" })).toBe(false);
    expect(shouldHoldContainerTestRunLock({})).toBe(true);
  });

  it("skips when the run that started it already holds the slot", () => {
    // run-integration-gate.ts's exclusive lane: no shared URL any more, but
    // the gate still holds this run's slot; queueing behind it deadlocked.
    expect(
      shouldHoldContainerTestRunLock({ [CONTAINER_TIER_SLOT_HELD]: "1" }),
    ).toBe(false);
    expect(
      shouldHoldContainerTestRunLock({ [CONTAINER_TIER_SLOT_HELD]: "0" }),
    ).toBe(true);
  });
});

describe("containerTestRunLockDir", () => {
  it("names the directory after the tier, so tiers never block each other", () => {
    expect(containerTestRunLockDir("integration", "/tmp")).toBe(
      "/tmp/command-test-tier-integration",
    );
    expect(containerTierSlotPath("integration", 2, "/tmp")).toBe(
      "/tmp/command-test-tier-integration/2.lock",
    );
    expect(containerTestRunLockDir("fast", "/tmp")).not.toBe(
      containerTestRunLockDir("integration", "/tmp"),
    );
  });
});
