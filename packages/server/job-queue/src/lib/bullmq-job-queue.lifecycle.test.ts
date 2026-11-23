/**
 * What: the BullMQ driver's connection lifecycle — `start()` does not resolve
 * until the worker's Redis connections are ready, and `close()` closes the
 * worker before the queue.
 * Why: BullMQ opens a connection in the `Worker` constructor and finishes it
 * asynchronously (`INFO` for the version check). Closing a connection that is
 * still initializing makes BullMQ remove its own listeners and then emit
 * `error` on the listener-less connection, which rethrows out of an un-awaited
 * `.catch()` — an unhandled `Error: Connection is closed.` that fails the whole
 * process. A `start()` that resolves before the worker is ready lets any prompt
 * `close()` hit that window, which is what made the Redis suite flaky.
 *
 * The vendor is faked here because the claim is about call ordering, not about
 * Redis; `bullmq-job-queue.integration.test.ts` proves the same driver against
 * a real container.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BullMqJobQueue as BullMqJobQueueClass } from "./bullmq-job-queue.js";
import { defineJob, type JobLog } from "../core/index.js";

const bullmq = vi.hoisted(() => {
  const lifecycle: string[] = [];
  const workerReadiness: {
    announceReady?: () => void;
    announceFailure?: (error: Error) => void;
  } = {};
  // Every worker the driver constructed, in order, so a test can ask how often
  // each individual one was closed — `lifecycle` only says that some worker was.
  const workers: FakeWorker[] = [];

  class FakeQueue {
    constructor() {
      lifecycle.push("queue.created");
    }
    on(): this {
      return this;
    }
    getJobSchedulers(): Promise<readonly never[]> {
      return Promise.resolve([]);
    }
    getJobCounts(): Promise<Record<string, number>> {
      return Promise.resolve({});
    }
    close(): Promise<void> {
      lifecycle.push("queue.close");
      return Promise.resolve();
    }
  }

  class FakeWorker {
    closeCount = 0;
    constructor() {
      workers.push(this);
      lifecycle.push("worker.created");
    }
    on(): this {
      return this;
    }
    waitUntilReady(): Promise<void> {
      lifecycle.push("worker.waitUntilReady");
      return new Promise((resolve, reject) => {
        workerReadiness.announceReady = resolve;
        workerReadiness.announceFailure = reject;
      });
    }
    close(): Promise<void> {
      this.closeCount += 1;
      lifecycle.push("worker.close");
      return Promise.resolve();
    }
  }

  return { FakeQueue, FakeWorker, lifecycle, workers, workerReadiness };
});

vi.mock("bullmq", () => ({
  Queue: bullmq.FakeQueue,
  Worker: bullmq.FakeWorker,
}));

// Reset any driver module already loaded by another test in this worker.
let BullMqJobQueue: typeof BullMqJobQueueClass;

beforeAll(async () => {
  vi.resetModules();
  ({ BullMqJobQueue } = await import("./bullmq-job-queue.js"));
});

afterAll(() => {
  vi.resetModules();
});

const silent: JobLog = { info: () => undefined, error: () => undefined };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function startedQueue(queueName: string) {
  const queue = new BullMqJobQueue("redis://localhost:6379", silent, queueName);
  queue.register([
    defineJob({
      name: "prune-sessions",
      payload: z.strictObject({}),
      retry: { attempts: 1, backoffMs: 1 },
      schedules: [],
      run: () => Promise.resolve(),
    }),
  ]);
  return queue;
}

describe("BullMqJobQueue lifecycle", () => {
  it("closes an unused queue without opening Redis connections", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("unused-queue");

    await queue.close();
    await expect(queue.inspect()).rejects.toThrow("Job queue is closed");
    expect(bullmq.lifecycle).toEqual([]);
  });

  it("stays unstarted until the worker's redis connections are ready", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("readiness-test");

    let resolved = false;
    const starting = queue.start().then(() => {
      resolved = true;
    });
    await settle();

    expect(bullmq.lifecycle).toContain("worker.waitUntilReady");
    expect(resolved).toBe(false);

    bullmq.workerReadiness.announceReady?.();
    await starting;

    expect(resolved).toBe(true);
  });

  it("closes the worker before the queue", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("close-order-test");
    const starting = queue.start();
    await settle();
    bullmq.workerReadiness.announceReady?.();
    await starting;

    await queue.close();

    expect(bullmq.lifecycle.filter((step) => step.endsWith(".close"))).toEqual(["worker.close", "queue.close"]);
  });

  it("closes the worker it created when startup never becomes ready", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("failed-start-test");
    const starting = queue.start();
    await settle();

    bullmq.workerReadiness.announceFailure?.(new Error("redis unreachable"));

    await expect(starting).rejects.toThrow("redis unreachable");
    expect(bullmq.lifecycle).toContain("worker.close");
  });

  it("waits for an in-flight start to settle before it closes the worker", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("close-during-start-test");
    const starting = queue.start();
    await settle();

    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    await settle();

    expect(bullmq.lifecycle).not.toContain("worker.close");
    expect(closed).toBe(false);

    bullmq.workerReadiness.announceReady?.();
    await starting;
    await closing;

    expect(bullmq.lifecycle.filter((step) => step.endsWith(".close"))).toEqual(["worker.close", "queue.close"]);
  });

  it("closes the worker once when a close overlaps a start that fails", async () => {
    bullmq.lifecycle.length = 0;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const queue = startedQueue("close-during-failing-start-test");
      const starting = queue.start();
      await settle();

      const closing = queue.close();
      await settle();

      expect(bullmq.lifecycle).not.toContain("worker.close");

      bullmq.workerReadiness.announceFailure?.(new Error("redis unreachable"));

      await expect(starting).rejects.toThrow("redis unreachable");
      await closing;
      await settle();

      expect(bullmq.lifecycle.filter((step) => step.endsWith(".close"))).toEqual(["worker.close", "queue.close"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("closes the replacement worker after a failed start is retried", async () => {
    bullmq.lifecycle.length = 0;
    bullmq.workers.length = 0;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const queue = startedQueue("retried-start-test");

      const failing = queue.start();
      await settle();
      bullmq.workerReadiness.announceFailure?.(new Error("redis unreachable"));
      await expect(failing).rejects.toThrow("redis unreachable");

      const retried = queue.start();
      await settle();
      bullmq.workerReadiness.announceReady?.();
      await retried;

      await queue.close();
      await settle();

      // The abandoned worker and its replacement are different objects, so
      // close-once state that outlives the first one would leave the second
      // holding its Redis connections after shutdown resolved.
      expect(bullmq.workers).toHaveLength(2);
      expect(bullmq.workers.map((worker) => worker.closeCount)).toEqual([1, 1]);
      expect(bullmq.lifecycle.filter((step) => step.endsWith(".close"))).toEqual([
        "worker.close",
        "worker.close",
        "queue.close",
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  it("tears down once when close is called twice at the same time", async () => {
    bullmq.lifecycle.length = 0;
    const queue = startedQueue("double-close-test");
    const starting = queue.start();
    await settle();
    bullmq.workerReadiness.announceReady?.();
    await starting;

    await Promise.all([queue.close(), queue.close()]);

    expect(bullmq.lifecycle.filter((step) => step.endsWith(".close"))).toEqual(["worker.close", "queue.close"]);
  });
});
