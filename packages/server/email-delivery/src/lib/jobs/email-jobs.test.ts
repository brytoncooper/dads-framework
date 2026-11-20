/**
 * WHAT: the two job edges — the payload they accept, the retry policy they
 * declare, and the sweep's cron.
 *
 * WHY `attempts: 1` is pinned here: it is the only thing stopping the queue
 * from becoming a second retry engine beside the row (INV-EMAILDELIVERY-3),
 * and it is one character away from being wrong in a way no other test sees.
 */
import { describe, expect, it, vi } from "vitest";

import { describeJobs } from "@dads-framework/job-queue/core";

import { createDeliverOutboundEmailJob } from "./deliver-outbound-email.job.js";
import { EMAIL_DELIVER_JOB, EMAIL_SWEEP_JOB } from "./email-job-names.js";
import {
  createSweepOutboundEmailsJob,
  EMAIL_SWEEP_SCHEDULE_ID,
} from "./sweep-outbound-emails.job.js";

const OUTBOUND_EMAIL_ID = "0199a1f0-0000-7000-8000-000000000001";

describe("createDeliverOutboundEmailJob", () => {
  it("passes the parsed id to the mutation", async () => {
    const execute = vi.fn(() => Promise.resolve());
    const job = createDeliverOutboundEmailJob({ execute });

    await job.run({ outboundEmailId: OUTBOUND_EMAIL_ID });

    expect(execute).toHaveBeenCalledWith({
      outboundEmailId: OUTBOUND_EMAIL_ID,
    });
  });

  it("refuses a payload that is not one outbound email id", async () => {
    const job = createDeliverOutboundEmailJob({
      execute: () => Promise.resolve(),
    });

    await expect(job.run({ outboundEmailId: "not-a-uuid" })).rejects.toThrow();
    await expect(
      job.run({ outboundEmailId: OUTBOUND_EMAIL_ID, extra: true }),
    ).rejects.toThrow();
  });

  it("runs once, leaving retries to the row", () => {
    const job = createDeliverOutboundEmailJob({
      execute: () => Promise.resolve(),
    });

    expect(describeJobs([job])).toEqual([
      {
        name: EMAIL_DELIVER_JOB,
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [],
      },
    ]);
  });
});

describe("createSweepOutboundEmailsJob", () => {
  it("runs the sweep every minute in UTC, once per occurrence", () => {
    const job = createSweepOutboundEmailsJob({
      execute: () => Promise.resolve(),
    });

    expect(describeJobs([job])).toEqual([
      {
        name: EMAIL_SWEEP_JOB,
        retry: { attempts: 1, backoffMs: 1 },
        schedules: [
          {
            id: EMAIL_SWEEP_SCHEDULE_ID,
            kind: "cron",
            pattern: "0 * * * * *",
            timeZone: "UTC",
          },
        ],
      },
    ]);
  });

  it("takes no payload", async () => {
    const execute = vi.fn(() => Promise.resolve());
    const job = createSweepOutboundEmailsJob({ execute });

    await job.run({});

    expect(execute).toHaveBeenCalledOnce();
    await expect(job.run({ limit: 10 })).rejects.toThrow();
  });
});
