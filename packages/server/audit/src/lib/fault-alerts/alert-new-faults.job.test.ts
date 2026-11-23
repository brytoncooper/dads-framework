/**
 * What: the sweep speaks only when something new happened, exactly once per
 * fault type, and only when it is switched on and has somebody to tell.
 * Why: this is the one part of the telemetry work that speaks FIRST. That
 * makes both failure modes expensive — a channel that cries wolf gets filtered
 * within a week, and a channel that stays quiet when it shouldn't is
 * indistinguishable from the silence we started with. Each guard gets a test.
 *
 * The reader fake carries a real memory rather than canned answers, because
 * "new" is now a fact about that memory: a stubbed list could not tell a fault
 * reported last hour from one nobody has heard of.
 */

import { describe, expect, it, vi } from "vitest";

import { type OutboundEmailId, outboundEmailIdSchema } from "@dads-framework/email/delivery";

import type {
  AlertedFault,
  FaultAlertReader,
  FaultGroup,
  FaultOrigin,
} from "../database/readers/fault-alert-reader.interface.js";
import { createAlertNewFaultsJob } from "./alert-new-faults.job.js";
import { MAX_FAULTS_PER_ALERT } from "./logic/summarize-new-faults.js";

const ENQUEUED_ID = outboundEmailIdSchema.parse("0192f2a0-0000-7000-8000-0000000000e1");

const NOW = new Date("2026-09-14T12:00:00.000Z");
const INSIDE_WINDOW = new Date("2026-09-14T11:30:00.000Z");
const BEFORE_WINDOW = new Date("2026-08-01T09:00:00.000Z");

/** One fault type as the fault tables hold it: when, and how loudly. */
type RecordedFault = {
  readonly origin: FaultOrigin;
  readonly fingerprint: string;
  readonly occurrences: number;
  readonly at: Date;
  readonly type?: string;
  readonly where?: string;
};

/**
 * The fault tables and the memory, in memory.
 *
 * Reads are the two real rules composed — happening inside the window, and not
 * in the memory — so a test can assert on what a second sweep does rather than
 * on which method was called.
 */
class FakeFaultAlertReader implements FaultAlertReader {
  readonly remembered = new Set<string>();
  readonly reads: FaultOrigin[] = [];

  constructor(private readonly recorded: readonly RecordedFault[] = []) {}

  unalertedServerFaultsSince(since: Date): Promise<readonly FaultGroup[]> {
    this.reads.push("server");
    return Promise.resolve(this.unalerted("server", since));
  }

  unalertedClientFaultsSince(since: Date): Promise<readonly FaultGroup[]> {
    this.reads.push("client");
    return Promise.resolve(this.unalerted("client", since));
  }

  hasRememberedAnyFault(): Promise<boolean> {
    return Promise.resolve(this.remembered.size > 0);
  }

  rememberFaultsSeenBefore(before: Date): Promise<number> {
    const older = this.recorded.filter((fault) => fault.at < before);
    const sizeBefore = this.remembered.size;
    for (const fault of older) {
      this.remembered.add(keyOf(fault));
    }
    return Promise.resolve(this.remembered.size - sizeBefore);
  }

  rememberAlertedFaults(faults: readonly AlertedFault[]): Promise<void> {
    for (const fault of faults) {
      this.remembered.add(keyOf(fault));
    }
    return Promise.resolve();
  }

  private unalerted(origin: FaultOrigin, since: Date): FaultGroup[] {
    return this.recorded
      .filter((fault) => fault.origin === origin && fault.at >= since && !this.remembered.has(keyOf(fault)))
      .map((fault) => ({
        fingerprint: fault.fingerprint,
        type: fault.type ?? "TypeError",
        occurrences: fault.occurrences,
        where: fault.where ?? "/api/orders",
      }));
  }
}

function keyOf(fault: { origin: FaultOrigin; fingerprint: string }): string {
  return `${fault.origin}:${fault.fingerprint}`;
}

function jobWith(options: {
  recorded?: readonly RecordedFault[];
  reader?: FakeFaultAlertReader;
  recipients?: readonly string[];
  dispatchFails?: boolean;
}) {
  // Typed so `mock.calls` keeps its shape — an untyped `vi.fn()` hands back
  // `any[]`, and destructuring that is what the unsafe-assignment rule flags.
  const enqueue = vi
    .fn<
      (
        template: unknown,
        props: unknown,
        envelope: unknown,
      ) => Promise<{
        id: OutboundEmailId;
        deduplicated: boolean;
        dispatched: boolean;
      }>
    >()
    .mockResolvedValue({
      id: ENQUEUED_ID,
      deduplicated: false,
      dispatched: false,
    });
  const dispatch = vi.fn<(ids: readonly OutboundEmailId[]) => Promise<void>>(
    options.dispatchFails === true
      ? () => Promise.reject(new Error("outbox is having a day"))
      : () => Promise.resolve(undefined),
  );
  const reader = options.reader ?? new FakeFaultAlertReader(options.recorded);
  const entries: object[] = [];
  const job = createAlertNewFaultsJob({
    reader,
    clock: { now: () => NOW },
    email: { enqueue, dispatch },
    recipients: options.recipients ?? ["ops@example.com"],
    windowHours: 1,
    log: {
      info: (entry: object) => entries.push(entry),
      error: (entry: object) => entries.push(entry),
    },
  });
  return { job, reader, enqueue, dispatch, entries };
}

describe("the new-fault sweep", () => {
  it("sends one digest naming what is newly broken", async () => {
    const { job, enqueue, dispatch } = jobWith({
      recorded: [
        {
          origin: "server",
          fingerprint: "server01",
          occurrences: 7,
          at: INSIDE_WINDOW,
        },
        {
          origin: "client",
          fingerprint: "client01",
          occurrences: 2,
          at: INSIDE_WINDOW,
          type: "render",
        },
      ],
    });

    await job.run({});

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, props, envelope] = enqueue.mock.calls[0] ?? [];
    expect(props).toMatchObject({ totalOccurrences: 9, windowHours: 1 });
    expect(envelope).toEqual({ to: [{ address: "ops@example.com" }] });
    // Handed to the outbox, then nudged — delivery and retry are its problem,
    // so a mail vendor having a bad day cannot fail this job.
    expect(dispatch).toHaveBeenCalledWith([ENQUEUED_ID]);
  });

  it("says nothing when nothing is new", async () => {
    // An hourly "nothing broke" is indistinguishable from no alerting after
    // about a week, because nobody reads it.
    const { job, enqueue } = jobWith({ recorded: [] });

    await job.run({});

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("names a fault once, however often the sweep runs", async () => {
    // The bug this replaced: any window longer than the schedule reported the
    // same fingerprint on every overlapping run.
    const { job, enqueue } = jobWith({
      recorded: [
        {
          origin: "server",
          fingerprint: "server01",
          occurrences: 3,
          at: INSIDE_WINDOW,
        },
      ],
    });

    await job.run({});
    await job.run({});
    await job.run({});

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("takes what was already broken as known, silently, on the first sweep", async () => {
    // Switching alerting on must not mail out months of familiar problems.
    const { job, enqueue, reader, entries } = jobWith({
      recorded: [
        {
          origin: "server",
          fingerprint: "olderthanwindow",
          occurrences: 900,
          at: BEFORE_WINDOW,
        },
      ],
    });

    await job.run({});

    expect(enqueue).not.toHaveBeenCalled();
    expect(reader.remembered.has("server:olderthanwindow")).toBe(true);
    expect(entries).toContainEqual(expect.objectContaining({ event: "fault-alerts.learned" }));
  });

  it("still alerts on the first fault a quiet system ever has", async () => {
    // The seeding rule must not swallow the one thing this job exists for:
    // nothing predates the window here, so nothing is taken as known.
    const { job, enqueue, reader } = jobWith({
      recorded: [
        {
          origin: "server",
          fingerprint: "thefirstone",
          occurrences: 1,
          at: INSIDE_WINDOW,
        },
      ],
    });

    await job.run({});

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(reader.remembered.has("server:thefirstone")).toBe(true);
  });

  it("carries a trimmed tail into the next sweep instead of losing it", async () => {
    const recorded = Array.from({ length: MAX_FAULTS_PER_ALERT + 3 }, (_unused, index): RecordedFault => ({
      origin: "server",
      fingerprint: `fault${String(index).padStart(2, "0")}`,
      // Descending, so the trimmed tail is the three quietest.
      occurrences: 100 - index,
      at: INSIDE_WINDOW,
    }));
    const { job, enqueue, reader } = jobWith({ recorded });

    await job.run({});

    expect(reader.remembered.size).toBe(MAX_FAULTS_PER_ALERT);
    const [, first] = enqueue.mock.calls[0] ?? [];
    expect(first).toMatchObject({ truncated: true });

    await job.run({});

    expect(enqueue).toHaveBeenCalledTimes(2);
    const [, second] = enqueue.mock.calls[1] ?? [];
    expect(second).toMatchObject({ truncated: false });
    expect(reader.remembered.size).toBe(recorded.length);
  });

  it("remembers nothing when the mail never got out", async () => {
    // Remembered-then-not-sent is a fault nobody ever hears about; the reverse
    // costs one duplicate email on a retry.
    const { job, reader } = jobWith({
      dispatchFails: true,
      recorded: [
        {
          origin: "server",
          fingerprint: "server01",
          occurrences: 3,
          at: INSIDE_WINDOW,
        },
      ],
    });

    await expect(job.run({})).rejects.toThrow(/outbox/);

    expect(reader.remembered.has("server:server01")).toBe(false);
  });

  it("does not send into the void when nobody is configured", async () => {
    const { job, enqueue, entries } = jobWith({
      recipients: [],
      recorded: [
        {
          origin: "server",
          fingerprint: "server01",
          occurrences: 1,
          at: INSIDE_WINDOW,
        },
      ],
    });

    await job.run({});

    expect(enqueue).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ event: "fault-alerts.no-recipients" });
  });

  it("refuses to be built with a nonsense window", () => {
    expect(() =>
      createAlertNewFaultsJob({
        reader: new FakeFaultAlertReader(),
        clock: { now: () => NOW },
        email: { enqueue: vi.fn(), dispatch: vi.fn() },
        recipients: [],
        windowHours: 0,
        log: { info: () => undefined, error: () => undefined },
      }),
    ).toThrow(/positive integer/);
  });
});
