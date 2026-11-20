/**
 * The retention sweep declares its schedule beside the operation and stays a
 * thin adapter over the writer, so this proves cutoff math, the log line
 * operators read, and that a nonsense retention window fails loud at
 * construction rather than silently pruning nothing or everything.
 */
import { describe, expect, it, type Mock, vi } from "vitest";

import { describeJobs, type JobLog } from "@dads-framework/job-queue";

import {
  createPruneRequestLogJob,
  PRUNE_REQUEST_LOG_JOB,
} from "./prune-request-log.job.js";

function fakeClock(now: Date) {
  return { now: () => now };
}

/**
 * A `JobLog` whose two sinks are spies the test can assert on directly. Typed
 * as the spies rather than as `JobLog` so `log.info` is a value this file
 * owns, not a method pulled off the interface.
 */
type SpyingJobLog = {
  readonly info: Mock<JobLog["info"]>;
  readonly error: Mock<JobLog["error"]>;
};

function silentLog(): SpyingJobLog {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createPruneRequestLogJob", () => {
  it("deletes rows older than retentionDays and logs the outcome", async () => {
    const now = new Date("2026-04-10T03:00:00.000Z");
    const deleteRecordedBefore = vi.fn(() => Promise.resolve(7));
    const log = silentLog();
    const job = createPruneRequestLogJob({
      writer: { deleteRecordedBefore },
      clock: fakeClock(now),
      retentionDays: 90,
      log,
    });

    await job.run({});

    const expectedCutoff = new Date("2026-01-10T03:00:00.000Z");
    expect(deleteRecordedBefore).toHaveBeenCalledExactlyOnceWith(
      expectedCutoff,
    );
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      { event: "request-log.pruned", deleted: 7, cutoff: expectedCutoff },
      "request_log rows pruned",
    );
  });

  it("re-evaluates the clock on every run rather than caching a cutoff", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const deleteRecordedBefore = vi.fn(() => Promise.resolve(0));
    const job = createPruneRequestLogJob({
      writer: { deleteRecordedBefore },
      clock: { now: () => current },
      retentionDays: 1,
      log: silentLog(),
    });

    await job.run({});
    current = new Date("2026-01-02T00:00:00.000Z");
    await job.run({});

    expect(deleteRecordedBefore).toHaveBeenNthCalledWith(
      1,
      new Date("2025-12-31T00:00:00.000Z"),
    );
    expect(deleteRecordedBefore).toHaveBeenNthCalledWith(
      2,
      new Date("2026-01-01T00:00:00.000Z"),
    );
  });

  it("declares its daily cron schedule and retry policy", () => {
    const job = createPruneRequestLogJob({
      writer: { deleteRecordedBefore: () => Promise.resolve(0) },
      clock: fakeClock(new Date()),
      retentionDays: 90,
      log: silentLog(),
    });

    expect(describeJobs([job])).toEqual([
      {
        name: PRUNE_REQUEST_LOG_JOB,
        retry: { attempts: 5, backoffMs: 1_000 },
        schedules: [
          {
            id: "audit.prune-request-log.daily",
            kind: "cron",
            pattern: "0 0 3 * * *",
            timeZone: "UTC",
          },
        ],
      },
    ]);
  });

  it("rejects a retentionDays of 0 at construction", () => {
    expect(() =>
      createPruneRequestLogJob({
        writer: { deleteRecordedBefore: () => Promise.resolve(0) },
        clock: fakeClock(new Date()),
        retentionDays: 0,
        log: silentLog(),
      }),
    ).toThrow(/positive integer/);
  });

  it("rejects a negative or non-integer retentionDays", () => {
    const base = {
      writer: { deleteRecordedBefore: () => Promise.resolve(0) },
      clock: fakeClock(new Date()),
      log: silentLog(),
    };

    expect(() =>
      createPruneRequestLogJob({ ...base, retentionDays: -5 }),
    ).toThrow(/positive integer/);
    expect(() =>
      createPruneRequestLogJob({ ...base, retentionDays: 1.5 }),
    ).toThrow(/positive integer/);
  });
});
