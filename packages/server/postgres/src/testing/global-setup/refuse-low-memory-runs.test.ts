import { describe, expect, it } from "vitest";
import {
  awaitEnoughTestMemory,
  containerWorkingSetBytes,
  decideMemoryPreflight,
  decideRamStorageFallback,
  decideVitestWorkerCap,
  dockerRunsInVm,
  INTEGRATION_WORKER_MEMORY_BYTES,
  memoryThresholds,
  memoryWorkerLimit,
  NotEnoughTestMemoryError,
  parseLinuxMemAvailable,
  parseMacAvailableMemory,
  type DockerMemoryReading,
  type MemoryReading,
  type MemoryThresholds,
} from "./refuse-low-memory-runs.js";

const GIB = 1024 ** 3;

/** The head of `/proc/meminfo` on the 25 GB test VM, 2026-11-18. */
const LINUX_MEMINFO = [
  "MemTotal:       26660092 kB",
  "MemFree:         5208128 kB",
  "MemAvailable:   12697580 kB",
  "Buffers:          459416 kB",
  "Cached:          6689480 kB",
  "SwapCached:            0 kB",
].join("\n");

/** `vm_stat` on a 48 GB Apple-silicon Mac, 2026-11-18 (trimmed). */
const MAC_VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                                    64039.",
  "Pages active:                                 788687.",
  "Pages inactive:                               800887.",
  "Pages speculative:                              3307.",
  "Pages throttled:                                   0.",
  "Pages wired down:                             329136.",
  "Pages purgeable:                                1328.",
  '"Translation faults":                     1430952428.',
  "Pages occupied by compressor:                1100894.",
].join("\n");

const THRESHOLDS: MemoryThresholds = {
  hostMinFreeBytes: 4 * GIB,
  dockerMinFreeBytes: 3 * GIB,
  waitBudgetMs: 120_000,
};

function reading(overrides: Partial<MemoryReading> = {}): MemoryReading {
  return {
    hostAvailableBytes: 20 * GIB,
    hostSource: "MemAvailable",
    docker: null,
    ...overrides,
  };
}

function dockerVm(overrides: Partial<DockerMemoryReading> = {}): DockerMemoryReading {
  return {
    totalBytes: 6_212_771_840,
    inVm: true,
    freeBytes: 4.5 * GIB,
    ...overrides,
  };
}

describe("parseLinuxMemAvailable", () => {
  it("reads MemAvailable, not MemFree", () => {
    expect(parseLinuxMemAvailable(LINUX_MEMINFO)).toBe(12_697_580 * 1024);
  });

  it("returns null when the line is missing", () => {
    expect(parseLinuxMemAvailable("MemTotal: 1 kB\nMemFree: 1 kB")).toBeNull();
  });
});

describe("parseMacAvailableMemory", () => {
  it("counts free, inactive, speculative and purgeable pages at the printed page size", () => {
    const pages = 64_039 + 800_887 + 3_307 + 1_328;
    expect(parseMacAvailableMemory(MAC_VM_STAT)).toBe(pages * 16_384);
  });

  it("reads far more than the free pages alone, which is all os.freemem sees", () => {
    const available = parseMacAvailableMemory(MAC_VM_STAT) ?? 0;
    expect(available / GIB).toBeGreaterThan(13);
    expect((64_039 * 16_384) / GIB).toBeLessThan(1.1);
  });

  it("returns null without a page size or with a missing line", () => {
    expect(parseMacAvailableMemory(MAC_VM_STAT.split("\n").slice(1).join("\n"))).toBeNull();
    expect(parseMacAvailableMemory(MAC_VM_STAT.replace(/^Pages inactive.*$/m, ""))).toBeNull();
  });
});

describe("containerWorkingSetBytes", () => {
  it("is usage minus inactive page cache, like docker stats", () => {
    // A Postgres container from `docker stats` on the Mac's Docker VM.
    expect(
      containerWorkingSetBytes({
        usage: 208_000_000,
        inactiveFile: 39_000_000,
      }),
    ).toBe(169_000_000);
  });

  it("never goes negative and treats missing fields as zero", () => {
    expect(containerWorkingSetBytes({ usage: 10, inactiveFile: 20 })).toBe(0);
    expect(containerWorkingSetBytes({})).toBe(0);
  });
});

describe("dockerRunsInVm", () => {
  it("is a VM on macOS and Windows, and under Docker Desktop on Linux", () => {
    expect(dockerRunsInVm("darwin", "Docker Desktop")).toBe(true);
    expect(dockerRunsInVm("darwin", "OrbStack")).toBe(true);
    expect(dockerRunsInVm("win32", "Docker Desktop")).toBe(true);
    expect(dockerRunsInVm("linux", "Docker Desktop")).toBe(true);
  });

  it("shares the host's memory natively on Linux", () => {
    expect(dockerRunsInVm("linux", "Ubuntu 24.04.5 LTS")).toBe(false);
  });
});

describe("memoryThresholds", () => {
  it("defaults to 4 GB on the host, 3 GB in Docker and a two-minute wait", () => {
    expect(memoryThresholds({})).toEqual(THRESHOLDS);
  });

  it("reads overrides in GB, and 0 turns a check off", () => {
    expect(
      memoryThresholds({
        DADS_TEST_MIN_FREE_MEMORY_GB: "1.5",
        DADS_TEST_MIN_FREE_DOCKER_MEMORY_GB: "0",
        DADS_TEST_MEMORY_WAIT_MS: "0",
      }),
    ).toEqual({
      hostMinFreeBytes: 1.5 * GIB,
      dockerMinFreeBytes: 0,
      waitBudgetMs: 0,
    });
  });

  it("refuses nonsense instead of silently using the default", () => {
    expect(() => memoryThresholds({ DADS_TEST_MIN_FREE_MEMORY_GB: "lots" })).toThrow(
      /DADS_TEST_MIN_FREE_MEMORY_GB must be a number/,
    );
    expect(() => memoryThresholds({ DADS_TEST_MEMORY_WAIT_MS: "-1" })).toThrow(/DADS_TEST_MEMORY_WAIT_MS/);
  });
});

describe("decideMemoryPreflight", () => {
  const decide = (input: { reading: MemoryReading; waitedMs?: number; thresholds?: MemoryThresholds }) =>
    decideMemoryPreflight({
      reading: input.reading,
      thresholds: input.thresholds ?? THRESHOLDS,
      tier: "integration",
      waitedMs: input.waitedMs ?? 0,
    });

  it("goes when the host and Docker's VM both have room", () => {
    expect(decide({ reading: reading({ docker: dockerVm() }) }).action).toBe("go");
  });

  it("waits while the host is below its floor, saying what is free and needed", () => {
    const decision = decide({
      reading: reading({ hostAvailableBytes: 2.5 * GIB }),
    });
    expect(decision.action).toBe("wait");
    expect(decision.message).toContain("host: 2.5 GB free (MemAvailable)");
    expect(decision.message).toContain("needs 4.0 GB");
  });

  it("waits while Docker's VM is below its floor even when the host has room", () => {
    const decision = decide({
      reading: reading({ docker: dockerVm({ freeBytes: 1 * GIB }) }),
    });
    expect(decision.action).toBe("wait");
    expect(decision.message).toContain("Docker VM: 1.0 GB free of 5.8 GB");
  });

  it("ignores Docker when it shares the host's memory or could not be read", () => {
    expect(
      decide({
        reading: reading({
          docker: { totalBytes: 25 * GIB, inVm: false, freeBytes: null },
        }),
      }).action,
    ).toBe("go");
    expect(decide({ reading: reading({ docker: null }) }).action).toBe("go");
  });

  it("refuses once the wait budget is spent, naming the override", () => {
    const decision = decide({
      reading: reading({ hostAvailableBytes: 1 * GIB }),
      waitedMs: 120_000,
    });
    expect(decision.action).toBe("abort");
    expect(decision.message).toContain("after waiting 120s");
    expect(decision.message).toContain("DADS_TEST_MIN_FREE_MEMORY_GB=2");
    expect(decision.message).toContain("0 skips it");
  });

  it("never checks a floor set to 0", () => {
    expect(
      decide({
        reading: reading({
          hostAvailableBytes: 0,
          docker: dockerVm({ freeBytes: 0 }),
        }),
        thresholds: {
          ...THRESHOLDS,
          hostMinFreeBytes: 0,
          dockerMinFreeBytes: 0,
        },
      }).action,
    ).toBe("go");
  });
});

describe("awaitEnoughTestMemory", () => {
  it("waits for memory to free up, announcing once, then goes", async () => {
    const readings = [1 * GIB, 2 * GIB, 6 * GIB];
    const logged: string[] = [];
    const result = await awaitEnoughTestMemory("integration", {
      thresholds: THRESHOLDS,
      deps: {
        read: () => Promise.resolve(reading({ hostAvailableBytes: readings.shift() ?? 0 })),
        sleep: () => Promise.resolve(),
        log: (line) => logged.push(line),
      },
    });
    expect(result.hostAvailableBytes).toBe(6 * GIB);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^waiting for memory/);
  });

  it("refuses with NotEnoughTestMemoryError once the budget runs out", async () => {
    let reads = 0;
    await expect(
      awaitEnoughTestMemory("integration", {
        thresholds: { ...THRESHOLDS, waitBudgetMs: 6_000 },
        deps: {
          read: () => {
            reads += 1;
            return Promise.resolve(reading({ hostAvailableBytes: 1 * GIB }));
          },
          sleep: () => Promise.resolve(),
          log: () => undefined,
        },
      }),
    ).rejects.toThrow(NotEnoughTestMemoryError);
    // Read at 0, 2, 4 and 6 seconds: three waits, then the refusal.
    expect(reads).toBe(4);
  });
});

describe("decideRamStorageFallback", () => {
  it("falls back to disk when Docker's VM is too small for the tmpfs, saying why", () => {
    const decision = decideRamStorageFallback({
      storage: "ram",
      docker: dockerVm(),
    });
    expect(decision.storage).toBe("disk");
    expect(decision.message).toContain("Docker's VM has 5.8 GB");
    expect(decision.message).toContain("needs 8 GB");
  });

  it("keeps ram when Docker has room", () => {
    expect(
      decideRamStorageFallback({
        storage: "ram",
        docker: { totalBytes: 25 * GIB, inVm: false, freeBytes: null },
      }),
    ).toEqual({ storage: "ram", message: null });
  });

  it("leaves disk alone, and keeps ram when Docker could not be read", () => {
    expect(decideRamStorageFallback({ storage: "disk", docker: dockerVm() })).toEqual({
      storage: "disk",
      message: null,
    });
    expect(decideRamStorageFallback({ storage: "ram", docker: null })).toEqual({
      storage: "ram",
      message: null,
    });
  });
});

describe("memoryWorkerLimit", () => {
  it("fits workers into what is free above the reserve", () => {
    expect(
      memoryWorkerLimit({
        availableBytes: 12 * GIB,
        reserveBytes: 4 * GIB,
        perWorkerBytes: 1 * GIB,
      }),
    ).toBe(8);
  });

  it("never goes below one worker", () => {
    expect(
      memoryWorkerLimit({
        availableBytes: 2 * GIB,
        reserveBytes: 4 * GIB,
        perWorkerBytes: 1 * GIB,
      }),
    ).toBe(1);
  });
});

describe("decideVitestWorkerCap", () => {
  const base = {
    env: {},
    configuredWorkers: undefined,
    cores: 32,
    availableBytes: 12 * GIB,
    reserveBytes: 4 * GIB,
  };

  it("lowers Vitest's cores-minus-one default to what fits in free memory", () => {
    const cap = decideVitestWorkerCap(base);
    const fit = Math.floor((8 * GIB) / INTEGRATION_WORKER_MEMORY_BYTES);
    expect(fit).toBeLessThan(31);
    expect(cap.workers).toBe(fit);
    expect(cap.message).toContain(`${String(fit)} instead of 31`);
  });

  it("never raises a count that already fits", () => {
    expect(decideVitestWorkerCap({ ...base, configuredWorkers: 4 }).workers).toBeNull();
  });

  it("leaves a chosen VITEST_MAX_WORKERS, and CI, alone", () => {
    expect(decideVitestWorkerCap({ ...base, env: { VITEST_MAX_WORKERS: "16" } }).workers).toBeNull();
    expect(decideVitestWorkerCap({ ...base, env: { CI: "true" } }).workers).toBeNull();
  });
});
