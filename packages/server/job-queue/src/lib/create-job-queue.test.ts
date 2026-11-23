/**
 * createJobQueue picks the driver and returns the JobQueue seam (including
 * close). Other shared-dependency factories are proven in their own libs.
 */
import { describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./create-job-queue.js";
import { InProcessJobQueue } from "./in-process-job-queue.js";

const log = { info: vi.fn(), error: vi.fn() };

describe("createJobQueue", () => {
  it("returns an in-process queue whose close resolves", async () => {
    const jobs = createJobQueue({ driver: "in-process", queueName: "dads-api" }, log);
    expect(jobs).toBeInstanceOf(InProcessJobQueue);
    await expect(jobs.inspect()).resolves.toMatchObject({
      queueName: "dads-api",
    });
    await expect(jobs.close()).resolves.toBeUndefined();
  });

  it("fails loudly when bullmq is selected without a redis url", () => {
    expect(() => createJobQueue({ driver: "bullmq", queueName: "dads-api" }, log)).toThrow(/REDIS_URL/);
  });
});
