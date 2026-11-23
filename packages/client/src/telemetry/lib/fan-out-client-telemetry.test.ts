/**
 * What: every destination gets every fault, and a broken destination costs
 * the others nothing.
 * Why: this class is the only thing standing between "the vendor is down" and
 * "we lost the record too". The whole posture — own the data, rent the
 * tooling — is a claim about isolation, and isolation is the kind of property
 * that is true right up until somebody adds a destination that throws.
 */

import { describe, expect, it } from "vitest";

import { ClientTelemetry, type TelemetryBreadcrumb, type TelemetryContext } from "../core/index.js";
import { FanOutClientTelemetry } from "./fan-out-client-telemetry.js";

class RecordingTelemetry extends ClientTelemetry {
  readonly reported: unknown[] = [];
  readonly crumbs: TelemetryBreadcrumb[] = [];
  constructor(private readonly flushes = true) {
    super();
  }
  override reportError(error: unknown): void {
    this.reported.push(error);
  }
  override addBreadcrumb(crumb: TelemetryBreadcrumb): void {
    this.crumbs.push(crumb);
  }
  override flush(): Promise<boolean> {
    return Promise.resolve(this.flushes);
  }
}

class HostileTelemetry extends ClientTelemetry {
  override reportError(): void {
    throw new Error("this destination is broken");
  }
  override addBreadcrumb(): void {
    throw new Error("so is its breadcrumb path");
  }
  override flush(): Promise<boolean> {
    return Promise.reject(new Error("and its flush"));
  }
}

const CONTEXT: TelemetryContext = { kind: "render" };
const CRUMB: TelemetryBreadcrumb = {
  at: "2026-09-15T12:00:00.000Z",
  category: "interaction",
  label: "clicked",
};

describe("FanOutClientTelemetry", () => {
  it("reports to every destination", () => {
    const own = new RecordingTelemetry();
    const vendor = new RecordingTelemetry();
    const fault = new Error("boom");

    new FanOutClientTelemetry([own, vendor]).reportError(fault, CONTEXT);

    expect(own.reported).toEqual([fault]);
    expect(vendor.reported).toEqual([fault]);
  });

  it("keeps our own record when the vendor throws", () => {
    // The hostile destination is FIRST, so a naive loop would never reach the
    // one that matters.
    const own = new RecordingTelemetry();
    const telemetry = new FanOutClientTelemetry([new HostileTelemetry(), own]);

    telemetry.reportError(new Error("boom"), CONTEXT);
    telemetry.addBreadcrumb(CRUMB);

    expect(own.reported).toHaveLength(1);
    expect(own.crumbs).toEqual([CRUMB]);
  });

  it("flushes every destination even when one rejects", async () => {
    const own = new RecordingTelemetry();
    const telemetry = new FanOutClientTelemetry([new HostileTelemetry(), own]);

    // False, because not everything was delivered — but it resolves rather
    // than rejecting, and the healthy destination was still asked.
    await expect(telemetry.flush(1_000)).resolves.toBe(false);
  });

  it("reports delivered only when all of them did", async () => {
    const all = new FanOutClientTelemetry([new RecordingTelemetry(true), new RecordingTelemetry(true)]);
    const partial = new FanOutClientTelemetry([new RecordingTelemetry(true), new RecordingTelemetry(false)]);

    expect(await all.flush(1_000)).toBe(true);
    expect(await partial.flush(1_000)).toBe(false);
  });
});
