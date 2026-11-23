/**
 * Job definitions bind payload parsing, execution policy, and recurring
 * schedules in one inspectable value so domain jobs cannot drift across files.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cronSchedule, defineJob, describeJobs, intervalSchedule } from "./job-definition.js";

describe("Job definitions", () => {
  it("parses payloads before invoking the bound run", async () => {
    const seen: string[] = [];
    const job = defineJob({
      name: "images.resize",
      payload: z.strictObject({ imageId: z.string() }),
      retry: { attempts: 5, backoffMs: 1_000 },
      schedules: [],
      run: ({ imageId }) => {
        seen.push(imageId);
        return Promise.resolve();
      },
    });

    await job.run({ imageId: "image-1" });
    await expect(job.run({ imageId: 42 })).rejects.toBeDefined();

    expect(seen).toEqual(["image-1"]);
  });

  it("describes cron and interval schedules without exposing handlers or payloads", () => {
    const job = defineJob({
      name: "platform.expire-support-sessions",
      payload: z.strictObject({}),
      retry: { attempts: 5, backoffMs: 1_000 },
      schedules: [
        cronSchedule({
          id: "platform.expire-support-sessions.every-five-minutes",
          pattern: "0 */5 * * * *",
          timeZone: "UTC",
          payload: {},
        }),
        intervalSchedule({
          id: "platform.expire-support-sessions.health-probe",
          everyMs: 60_000,
          payload: {},
        }),
      ],
      run: () => Promise.resolve(),
    });

    expect(describeJobs([job])).toEqual([
      {
        name: "platform.expire-support-sessions",
        retry: { attempts: 5, backoffMs: 1_000 },
        schedules: [
          {
            id: "platform.expire-support-sessions.every-five-minutes",
            kind: "cron",
            pattern: "0 */5 * * * *",
            timeZone: "UTC",
          },
          {
            id: "platform.expire-support-sessions.health-probe",
            kind: "interval",
            everyMs: 60_000,
          },
        ],
      },
    ]);
  });
});
