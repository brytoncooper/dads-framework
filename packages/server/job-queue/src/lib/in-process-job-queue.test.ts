/**
 * In-process driver: definitions bind before start, recurring timers enqueue
 * through the same handler, and inspection makes ongoing progress visible.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AuditActor,
  currentAuditActor,
} from "@dads-framework/audit-actor";

import { InProcessJobQueue } from "./in-process-job-queue.js";
import { cronSchedule, defineJob, intervalSchedule } from "../core/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("InProcessJobQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the bound function off the enqueue path", async () => {
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    const seen: unknown[] = [];
    queue.register([
      defineJob({
        name: "resize-image",
        payload: z.unknown(),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
        run: (payload) => {
          seen.push(payload);
          return Promise.resolve();
        },
      }),
    ]);
    await queue.start();
    const accepted = queue.enqueue("resize-image", { id: "a" });
    expect(seen).toEqual([]); // not yet — off the request path
    await accepted;
    await tick();
    expect(seen).toEqual([{ id: "a" }]);
    expect(await queue.inspect()).toMatchObject({
      driver: "in-process",
      counts: { waiting: 0, active: 0, completed: 1, failed: 0 },
      jobs: [{ name: "resize-image", schedules: [] }],
    });
  });

  it("reports run failures instead of throwing into the caller", async () => {
    const failures: object[] = [];
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: (entry) => failures.push(entry),
    });
    queue.register([
      defineJob({
        name: "explode",
        payload: z.unknown(),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
        run: () => Promise.reject(new Error("boom")),
      }),
    ]);
    await queue.start();
    await queue.enqueue("explode", {});
    await tick();
    expect(failures).toEqual([
      expect.objectContaining({ event: "job.failed", jobName: "explode" }),
    ]);
    expect(await queue.inspect()).toMatchObject({
      counts: { active: 0, completed: 0, failed: 1 },
    });
  });

  it("rejects unknown jobs and duplicate names or schedule ids", () => {
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    expect(() => queue.enqueue("nope", {})).toThrow("No handler");
    const job = defineJob({
      name: "x",
      payload: z.unknown(),
      retry: { attempts: 1, backoffMs: 1 },
      schedules: [
        intervalSchedule({ id: "same", everyMs: 1_000, payload: {} }),
      ],
      run: () => Promise.resolve(),
    });
    queue.register([job]);
    expect(() => {
      queue.register([job]);
    }).toThrow('Job "x" already has a handler');
    expect(() => {
      new InProcessJobQueue({
        info: () => undefined,
        error: () => undefined,
      }).register([
        job,
        defineJob({
          name: "y",
          payload: z.unknown(),
          retry: { attempts: 1, backoffMs: 1 },
          schedules: [
            intervalSchedule({ id: "same", everyMs: 2_000, payload: {} }),
          ],
          run: () => Promise.resolve(),
        }),
      ]);
    }).toThrow('Schedule "same" is registered more than once');
  });

  it("runs registered intervals after start and cancels them on close", async () => {
    vi.useFakeTimers();
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    const runs: number[] = [];
    queue.register([
      defineJob({
        name: "heartbeat",
        payload: z.strictObject({ sequence: z.number() }),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [
          intervalSchedule({
            id: "heartbeat.every-second",
            everyMs: 1_000,
            payload: { sequence: 1 },
          }),
        ],
        run: ({ sequence }) => {
          runs.push(sequence);
          return Promise.resolve();
        },
      }),
    ]);

    await queue.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual([1]);
    const inspection = await queue.inspect();
    expect(inspection).toMatchObject({
      schedules: [
        {
          id: "heartbeat.every-second",
          jobName: "heartbeat",
          kind: "interval",
          everyMs: 1_000,
        },
      ],
    });
    expect(typeof inspection.schedules[0]?.nextRunAt).toBe("string");

    await queue.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toEqual([1]);
  });

  it("runs cron schedules in container-free local development", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-29T20:00:00.000Z") });
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    const runs: number[] = [];
    queue.register([
      defineJob({
        name: "local-cron",
        payload: z.strictObject({ sequence: z.number() }),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [
          cronSchedule({
            id: "local-cron.every-two-seconds",
            pattern: "*/2 * * * * *",
            timeZone: "UTC",
            payload: { sequence: 1 },
          }),
        ],
        run: ({ sequence }) => {
          runs.push(sequence);
          return Promise.resolve();
        },
      }),
    ]);

    await queue.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runs).toEqual([1]);
    expect(await queue.inspect()).toMatchObject({
      schedules: [
        {
          id: "local-cron.every-two-seconds",
          kind: "cron",
          nextRunAt: "2026-08-29T20:00:04.000Z",
        },
      ],
    });
    await queue.close();
  });

  it("starts only once", async () => {
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    await queue.start();
    await expect(queue.start()).rejects.toThrow(
      "Job queue has already been started",
    );
  });

  it("runs the job as its own system actor, and logs where to find its rows", async () => {
    const started: object[] = [];
    const queue = new InProcessJobQueue({
      info: (entry) => started.push(entry),
      error: () => undefined,
    });
    let seen: AuditActor | undefined;
    queue.register([
      defineJob({
        name: "prune-sessions",
        payload: z.unknown(),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
        run: () => {
          seen = currentAuditActor();
          return Promise.resolve();
        },
      }),
    ]);
    await queue.start();
    await queue.enqueue("prune-sessions", {});
    await tick();

    expect(seen).toMatchObject({ kind: "system", id: "job:prune-sessions" });
    expect(seen?.requestId).toBeTruthy();
    expect(started).toContainEqual({
      event: "job.started",
      jobName: "prune-sessions",
      requestId: seen?.requestId,
    });
  });

  it("waits for accepted work to finish before close resolves", async () => {
    let finish: (() => void) | undefined;
    const heldRun = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = new InProcessJobQueue({
      info: () => undefined,
      error: () => undefined,
    });
    queue.register([
      defineJob({
        name: "held-job",
        payload: z.strictObject({}),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
        run: () => heldRun,
      }),
    ]);
    await queue.start();
    await queue.enqueue("held-job", {});
    await tick();

    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);

    finish?.();
    await closing;
    expect(closed).toBe(true);
  });
});
