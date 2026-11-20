import { jobQueueConformance } from "./job-queue-conformance.js";
/**
 * The fake is what suites that enqueue work assert against, so the parts they
 * lean on are pinned here: an unregistered name is refused the way the real
 * drivers refuse it, enqueueing runs nothing on its own, `runEnqueued` is the
 * step that does, and a job that throws is counted rather than escaping — the
 * same trade the in-process driver makes.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineJob } from "../job-definition.js";
import { FakeJobQueue } from "./in-memory-job-queue.js";

const payloadSchema = z.strictObject({ id: z.string() });

function countingJob(run: (payload: { readonly id: string }) => Promise<void>) {
  return defineJob({
    name: "email.deliver",
    payload: payloadSchema,
    retry: { attempts: 1, backoffMs: 1 },
    schedules: [],
    run,
  });
}

describe("FakeJobQueue", () => {
  it("records what was enqueued without running it", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const queue = new FakeJobQueue();
    queue.register([countingJob(run)]);

    await queue.enqueue("email.deliver", { id: "one" });
    await queue.enqueue("email.deliver", { id: "two" });

    expect(queue.enqueued).toEqual([
      { jobName: "email.deliver", payload: { id: "one" } },
      { jobName: "email.deliver", payload: { id: "two" } },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  // Thrown, not rejected — the same shape `InProcessJobQueue` refuses with, so
  // a suite that swaps the fake in does not have to change how it asserts.
  it("refuses a name no job was registered under", () => {
    const queue = new FakeJobQueue();

    expect(() => queue.enqueue("email.deliver", {})).toThrow(
      'No handler registered for job "email.deliver"',
    );
    expect(queue.enqueued).toEqual([]);
  });

  it("runs each pending payload through the registered handler once", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const queue = new FakeJobQueue();
    queue.register([countingJob(run)]);
    await queue.enqueue("email.deliver", { id: "one" });

    await queue.runEnqueued();
    await queue.runEnqueued();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ id: "one" });
  });

  it("counts a failing job instead of letting it escape the drain", async () => {
    const queue = new FakeJobQueue();
    queue.register([
      countingJob(() => Promise.reject(new Error("vendor unavailable"))),
    ]);
    await queue.enqueue("email.deliver", { id: "one" });

    await expect(queue.runEnqueued()).resolves.toBeUndefined();

    expect(queue.failures.map((failure) => failure.message)).toEqual([
      "vendor unavailable",
    ]);
    expect((await queue.inspect()).counts).toMatchObject({
      waiting: 0,
      completed: 0,
      failed: 1,
    });
  });

  it("derives its counts from what is waiting and what has run", async () => {
    const queue = new FakeJobQueue();
    queue.register([countingJob(() => Promise.resolve())]);
    await queue.enqueue("email.deliver", { id: "one" });
    await queue.enqueue("email.deliver", { id: "two" });

    expect((await queue.inspect()).counts).toEqual({
      waiting: 2,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });

    await queue.runEnqueued();

    expect((await queue.inspect()).counts).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 2,
      failed: 0,
    });
  });

  it("reports the registered inventory without widening the driver union", async () => {
    const queue = new FakeJobQueue();
    queue.register([countingJob(() => Promise.resolve())]);

    const inspection = await queue.inspect();

    expect(inspection.driver).toBe("in-process");
    expect(inspection.queueName).toBe("dads-api");
    expect(inspection.jobs).toEqual([
      {
        name: "email.deliver",
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
      },
    ]);
    expect(inspection.schedules).toEqual([]);
  });

  it("refuses a second handler for a name it already has", () => {
    const queue = new FakeJobQueue();
    queue.register([countingJob(() => Promise.resolve())]);

    expect(() => {
      queue.register([countingJob(() => Promise.resolve())]);
    }).toThrow('Job "email.deliver" already has a handler');
  });

  it("refuses registration once started, like the real drivers", async () => {
    const queue = new FakeJobQueue();
    await queue.start();

    expect(() => {
      queue.register([countingJob(() => Promise.resolve())]);
    }).toThrow("Jobs must be registered before the job queue starts");
  });
});

describe("JobQueue conformance against the in-memory fake", () => {
  it.each(jobQueueConformance)("$name", async ({ run }) => {
    const queue = new FakeJobQueue();
    try {
      await run({
        queue,
        awaitDelivery: () => queue.runEnqueued(),
      });
    } finally {
      await queue.close();
    }
  });
});
