import { deepEqual, rejects, throws } from "node:assert/strict";

import { defineJob } from "../job-definition.js";
import type { JobQueue } from "../job-queue.js";

type JobQueueConformanceFixture = {
  readonly queue: JobQueue;
  readonly awaitDelivery: (received: () => string | undefined) => Promise<void>;
};

type JobQueueConformanceCase = {
  readonly name: string;
  readonly run: (fixture: JobQueueConformanceFixture) => Promise<void>;
};

function exampleJob(handler: (payload: string) => Promise<void>) {
  return defineJob({
    name: "conformance-job",
    payload: {
      parse(payload: unknown): string {
        if (typeof payload !== "string") throw new Error("Expected text");
        return payload.trim();
      },
    },
    retry: { attempts: 1, backoffMs: 1 },
    schedules: [],
    run: handler,
  });
}

export const jobQueueConformance: readonly JobQueueConformanceCase[] = [
  {
    name: "lists one canonical definition and rejects a duplicate",
    async run({ queue }) {
      const job = exampleJob(() => Promise.resolve());
      queue.register([job]);

      throws(() => {
        queue.register([job]);
      }, /already|duplicate/i);
      const inspection = await queue.inspect();
      deepEqual(inspection.jobs, [{ name: job.name, retry: job.retry, schedules: [] }]);
    },
  },
  {
    name: "refuses an unregistered job without running any handler",
    async run({ queue }) {
      const job = exampleJob(() => Promise.reject(new Error("Unexpected job")));
      queue.register([job]);

      await rejects(async () => queue.enqueue("unknown", "payload"), /No handler registered/);
    },
  },
  {
    name: "runs accepted work with its parsed payload",
    async run({ queue, awaitDelivery }) {
      let received: string | undefined;
      const job = exampleJob((payload) => {
        received = payload;
        return Promise.resolve();
      });
      queue.register([job]);
      await queue.start();
      await queue.enqueue(job.name, "  payload  ");

      await awaitDelivery(() => received);
      deepEqual(received, "payload");
    },
  },
];
