/**
 * Redis history must remain bounded while retaining enough completed and
 * failed work for the queue inspection seam to be operationally useful.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { bullMqJobOptions } from "./bullmq-job-options.js";
import { defineJob } from "@dads-framework/job-queue-core";

describe("BullMQ job options", () => {
  it("maps retries and bounded completed/failed retention", () => {
    const definition = defineJob({
      name: "retained-job",
      payload: z.strictObject({}),
      retry: { attempts: 3, backoffMs: 250 },
      schedules: [],
      run: () => Promise.resolve(),
    });

    expect(bullMqJobOptions(definition)).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 250 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    });
  });
});
