import { randomUUID } from "node:crypto";
import { jobQueueConformance } from "@dads-framework/job-queue-core/testing";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AuditActor,
  currentAuditActor,
} from "@dads-framework/audit-actor";

import { BullMqJobQueue } from "./bullmq-job-queue.js";
import {
  cronSchedule,
  defineJob,
  intervalSchedule,
} from "@dads-framework/job-queue-core";

/** Real Redis via Testcontainers — proves the driver, not just the seam. */
describe("BullMqJobQueue (integration)", () => {
  let redis: StartedRedisContainer;

  beforeAll(async () => {
    redis = await new RedisContainer("redis:7-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await redis.stop();
  });

  it.each(jobQueueConformance)("$name", async ({ run }) => {
    const queue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      { info: () => undefined, error: () => undefined },
      `conformance-${randomUUID()}`,
    );
    try {
      await run({
        queue,
        awaitDelivery: async (received) => {
          await expect.poll(received, { timeout: 15_000 }).toBeDefined();
        },
      });
    } finally {
      await queue.close();
    }
  });

  it("delivers enqueued jobs to the bound run and reports failures", async () => {
    const errors: object[] = [];
    const queue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      {
        info: () => undefined,
        error: (entry) => errors.push(entry),
      },
      "dads-enqueue-test",
    );
    try {
      const seen: unknown[] = [];
      queue.register([
        defineJob({
          name: "greet",
          payload: z.unknown(),
          retry: { attempts: 1, backoffMs: 1 },
          schedules: [],
          run: (payload) => {
            seen.push(payload);
            return Promise.resolve();
          },
        }),
        defineJob({
          name: "explode",
          payload: z.unknown(),
          retry: { attempts: 1, backoffMs: 1 },
          schedules: [],
          run: () => Promise.reject(new Error("boom")),
        }),
      ]);
      await queue.start();

      await queue.enqueue("greet", { name: "alice" });
      await queue.enqueue("explode", {});

      await expect
        .poll(() => seen, { timeout: 15_000 })
        .toEqual([{ name: "alice" }]);
      await expect
        .poll(() => errors, { timeout: 15_000 })
        .toContainEqual(
          expect.objectContaining({ event: "job.failed", jobName: "explode" }),
        );
    } finally {
      await queue.close();
    }
  }, 60_000);

  // The same claim `in-process-job-queue.test.ts` makes of the other driver:
  // the two must not attribute one job under two identities.
  it("runs the job as its own system actor, and logs where to find its rows", async () => {
    const started: object[] = [];
    const queue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      {
        info: (entry) => started.push(entry),
        error: () => undefined,
      },
      "dads-actor-test",
    );
    let seen: AuditActor | undefined;
    try {
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

      await expect
        .poll(() => seen, { timeout: 15_000 })
        .toMatchObject({ kind: "system", id: "job:prune-sessions" });
      expect(seen?.requestId).toBeTruthy();
      expect(started).toContainEqual(
        expect.objectContaining({
          event: "job.started",
          jobName: "prune-sessions",
          requestId: seen?.requestId,
        }),
      );
    } finally {
      await queue.close();
    }
  }, 60_000);

  it("retries a failed attempt until the registered policy succeeds", async () => {
    const progress: object[] = [];
    const queue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      {
        info: (entry) => progress.push(entry),
        error: (entry) => progress.push(entry),
      },
      "dads-retry-test",
    );
    let attempts = 0;
    try {
      queue.register([
        defineJob({
          name: "eventually-succeeds",
          payload: z.strictObject({}),
          retry: { attempts: 3, backoffMs: 1 },
          schedules: [],
          run: () => {
            attempts += 1;
            return attempts < 3
              ? Promise.reject(new Error("try again"))
              : Promise.resolve();
          },
        }),
      ]);
      await queue.start();

      await queue.enqueue("eventually-succeeds", {});

      await expect.poll(() => attempts, { timeout: 15_000 }).toBe(3);
      await expect
        .poll(
          () =>
            progress.filter(
              (entry) => "event" in entry && entry.event === "job.completed",
            ).length,
          { timeout: 15_000 },
        )
        .toBe(1);
    } finally {
      await queue.close();
    }
  }, 60_000);

  it("executes a real cron schedule repeatedly and exposes its ongoing state", async () => {
    const progress: object[] = [];
    const queue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      {
        info: (entry) => progress.push(entry),
        error: () => undefined,
      },
      "dads-cron-test",
    );
    const runs: number[] = [];
    try {
      queue.register([
        defineJob({
          name: "cron-heartbeat",
          payload: z.strictObject({ sequence: z.number() }),
          retry: { attempts: 3, backoffMs: 10 },
          schedules: [
            cronSchedule({
              id: "cron-heartbeat.every-second",
              pattern: "* * * * * *",
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

      await expect
        .poll(() => runs.length, { timeout: 15_000 })
        .toBeGreaterThan(1);
      const inspection = await queue.inspect();
      expect(inspection).toMatchObject({
        driver: "bullmq",
        jobs: [
          {
            name: "cron-heartbeat",
            retry: { attempts: 3, backoffMs: 10 },
          },
        ],
        schedules: [
          {
            id: "cron-heartbeat.every-second",
            jobName: "cron-heartbeat",
            kind: "cron",
            pattern: "* * * * * *",
            timeZone: "UTC",
          },
        ],
      });
      expect(typeof inspection.schedules[0]?.nextRunAt).toBe("string");
      expect(typeof inspection.counts.active).toBe("number");
      expect(typeof inspection.counts.completed).toBe("number");
      expect(typeof inspection.counts.delayed).toBe("number");
      expect(typeof inspection.counts.failed).toBe("number");
      expect(typeof inspection.counts.waiting).toBe("number");
      expect(progress).toContainEqual(
        expect.objectContaining({
          event: "job.schedule.registered",
          jobName: "cron-heartbeat",
          scheduleId: "cron-heartbeat.every-second",
        }),
      );
      expect(progress).toContainEqual(
        expect.objectContaining({
          event: "job.completed",
          jobName: "cron-heartbeat",
        }),
      );
    } finally {
      await queue.close();
    }
  }, 60_000);

  it("removes schedules that are no longer in the assembled inventory", async () => {
    const queueName = "dads-schedule-reconciliation-test";
    const progress: object[] = [];
    const log = {
      info: (entry: object) => progress.push(entry),
      error: () => undefined,
    };
    const firstQueue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      log,
      queueName,
    );
    firstQueue.register([
      defineJob({
        name: "reconciled-job",
        payload: z.strictObject({}),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [
          intervalSchedule({
            id: "reconciled-job.removed-schedule",
            everyMs: 60_000,
            payload: {},
          }),
        ],
        run: () => Promise.resolve(),
      }),
    ]);
    await firstQueue.start();
    expect((await firstQueue.inspect()).schedules).toHaveLength(1);
    await firstQueue.close();

    const otherApplication = new BullMqJobQueue(
      redis.getConnectionUrl(),
      log,
      "another-application",
    );
    otherApplication.register([
      defineJob({
        name: "other-application-job",
        payload: z.strictObject({}),
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [
          intervalSchedule({
            id: "reconciled-job.removed-schedule",
            everyMs: 60_000,
            payload: {},
          }),
        ],
        run: () => Promise.resolve(),
      }),
    ]);
    await otherApplication.start();

    const replacementQueue = new BullMqJobQueue(
      redis.getConnectionUrl(),
      log,
      queueName,
    );
    try {
      replacementQueue.register([
        defineJob({
          name: "reconciled-job",
          payload: z.strictObject({}),
          retry: { attempts: 1, backoffMs: 1 },
          schedules: [],
          run: () => Promise.resolve(),
        }),
      ]);

      await replacementQueue.start();

      expect((await replacementQueue.inspect()).schedules).toEqual([]);
      expect(progress).toContainEqual(
        expect.objectContaining({
          event: "job.schedule.removed",
          jobName: "reconciled-job",
          scheduleId: "reconciled-job.removed-schedule",
        }),
      );
      expect((await otherApplication.inspect()).schedules).toMatchObject([
        { id: "reconciled-job.removed-schedule" },
      ]);
    } finally {
      await replacementQueue.close();
      await otherApplication.close();
    }
  });
});
