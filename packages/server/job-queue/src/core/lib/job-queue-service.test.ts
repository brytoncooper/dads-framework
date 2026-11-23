/**
 * What: jobQueueService narrow capability token.
 * Why: domain plugins enqueue background jobs without naming which queue driver the host wires.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { createTestHost, definePlugin, overrideService } from "@dads-framework/core/plugin";

import type { JobQueue } from "./job-queue.js";
import { jobQueueService } from "./job-queue-service.js";
import { FakeJobQueue } from "./testing/in-memory-job-queue.js";

describe("jobQueueService", () => {
  it("provides a typed JobQueue capability token for plugin compositions", async () => {
    expect(jobQueueService.kind).toBe("service");
    expect(jobQueueService.name).toBe("job-queue");
    expect(jobQueueService.dependencyName).toBe("service:job-queue");

    const worker = definePlugin({
      name: "mailer",
      requires: [jobQueueService],
      setup: ({ use }) => {
        const queue = use(jobQueueService);
        expectTypeOf(queue).toEqualTypeOf<JobQueue>();
        return { provides: { queue } };
      },
    });

    const fakeQueue = new FakeJobQueue();
    const host = await createTestHost({
      plugins: [worker],
      overrides: [overrideService(jobQueueService, fakeQueue)],
    });
    try {
      expect(host.read(worker).queue).toBe(fakeQueue);
      expect(host.read(jobQueueService)).toBe(fakeQueue);
    } finally {
      await host.stop();
    }
  });
});
