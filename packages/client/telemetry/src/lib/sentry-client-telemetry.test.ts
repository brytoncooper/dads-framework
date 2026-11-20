/**
 * What: the vendor driver keeps the faults raised before its SDK arrives,
 * hands the recorder masking it cannot loosen, and stays harmless when the
 * SDK never arrives at all.
 * Why: the SDK is a lazy chunk, so there is always a window between the first
 * paint and the reporter existing — and that window holds the most valuable
 * faults there are, the ones that happen before anything works. Dropping them
 * would make the vendor useless for exactly the crash we bought it for. The
 * "never arrives" case is not hypothetical either: a large share of real
 * browsers block this chunk outright.
 */

import { describe, expect, it, vi } from "vitest";

import type { TelemetryBreadcrumb } from "../core/index.js";
import { clientTelemetryConformance } from "../testing.js";
import type { SentryConfiguration } from "./logic/sentry-configuration.js";
import {
  SentryClientTelemetry,
  type LoadVendorReporter,
  type VendorCaptureHint,
} from "./sentry-client-telemetry.js";

const OPTIONS = {
  dsn: "https://publickey@o0.ingest.example.com/1",
  release: "abc1234",
  environment: "production",
  tunnel: "/api/telemetry/envelope",
};

type Captured = { error: unknown; hint: VendorCaptureHint };

function crumb(label: string): TelemetryBreadcrumb {
  return { at: new Date().toISOString(), category: "interaction", label };
}

/** A reporter that records what it was given, and the configuration it started with. */
function fakeVendor() {
  const captured: Captured[] = [];
  const crumbs: TelemetryBreadcrumb[] = [];
  let started: SentryConfiguration | undefined;
  let release: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  const load: LoadVendorReporter = async (configuration) => {
    started = configuration;
    await arrived;
    return {
      captureException: (error, hint) => captured.push({ error, hint }),
      addBreadcrumb: (crumb) => crumbs.push(crumb),
      flush: () => Promise.resolve(true),
    };
  };

  return {
    load,
    captured,
    crumbs,
    configuration: () => started,
    arrive: () => {
      release?.();
    },
  };
}

describe("SentryClientTelemetry", () => {
  it("keeps the faults raised before the SDK lands, and sends them once it does", async () => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });

    telemetry.reportError(new Error("crashed before the chunk"), {
      kind: "render",
    });
    expect(vendor.captured).toHaveLength(0);

    vendor.arrive();
    await telemetry.flush(1_000);

    expect(vendor.captured).toHaveLength(1);
    expect(vendor.captured[0]?.error).toBeInstanceOf(Error);
  });

  it("hands the recorder the masking it cannot loosen", async () => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });
    vendor.arrive();
    await telemetry.flush(1_000);

    const configuration = vendor.configuration();
    expect(configuration?.replayMasking).toMatchObject({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      networkCaptureBodies: false,
    });
    expect(configuration?.tunnel).toBe("/api/telemetry/envelope");
  });

  it("tags the fault with where it happened and which request it was about", async () => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });
    vendor.arrive();
    await telemetry.flush(1_000);

    telemetry.reportError(new Error("boom"), {
      kind: "mutation",
      requestId: "req-42",
    });

    expect(vendor.captured[0]?.hint.tags).toEqual({
      kind: "mutation",
      request_id: "req-42",
    });
  });

  it("drops the oldest when a loop reports faster than the SDK arrives", async () => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });

    for (let index = 0; index < 60; index += 1) {
      telemetry.reportError(new Error(`fault ${String(index)}`), {
        kind: "render",
      });
    }
    vendor.arrive();
    await telemetry.flush(1_000);

    // Bounded at 50, keeping the newest — the page is still failing, so the
    // recent ones are the ones with a live context around them.
    expect(vendor.captured).toHaveLength(50);
    const oldestKept = vendor.captured[0]?.error;
    expect(oldestKept).toBeInstanceOf(Error);
    expect(oldestKept instanceof Error ? oldestKept.message : "").toBe(
      "fault 10",
    );
  });

  it("stays harmless when the SDK never arrives", async () => {
    // The common case for a blocked chunk. Nothing may throw, and the queue
    // must not grow forever waiting for a load that will not happen.
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: () => Promise.reject(new Error("blocked by an extension")),
    });

    expect(() => {
      telemetry.reportError(new Error("boom"), { kind: "render" });
      telemetry.addBreadcrumb(crumb("clicked"));
    }).not.toThrow();
    expect(await telemetry.flush(1_000)).toBe(false);
    expect(telemetry.isReporting).toBe(false);
  });

  it("never lets a throwing SDK escape into the handler that called it", async () => {
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: () =>
        Promise.resolve({
          captureException: () => {
            throw new Error("the vendor is having a day");
          },
          addBreadcrumb: () => {
            throw new Error("as is its breadcrumb path");
          },
          flush: () => Promise.reject(new Error("and its flush")),
        }),
    });
    await telemetry.flush(1_000);

    expect(() => {
      telemetry.reportError(new Error("boom"), { kind: "render" });
      telemetry.addBreadcrumb(crumb("clicked"));
    }).not.toThrow();
    expect(await telemetry.flush(1_000)).toBe(false);
  });

  it("does not queue breadcrumbs, which are only worth anything beside a fault", async () => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });

    telemetry.addBreadcrumb(crumb("early"));
    vendor.arrive();
    await telemetry.flush(1_000);

    expect(vendor.crumbs).toHaveLength(0);
  });

  it("loads the SDK once, not once per report", async () => {
    const load = vi.fn<LoadVendorReporter>(() =>
      Promise.resolve({
        captureException: () => undefined,
        addBreadcrumb: () => undefined,
        flush: () => Promise.resolve(true),
      }),
    );
    const telemetry = new SentryClientTelemetry({ ...OPTIONS, load });

    telemetry.reportError(new Error("one"), { kind: "render" });
    telemetry.reportError(new Error("two"), { kind: "render" });
    await telemetry.flush(1_000);

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("ClientTelemetry conformance against the Sentry adapter", () => {
  it.each(clientTelemetryConformance)("$name", async ({ run }) => {
    const vendor = fakeVendor();
    const telemetry = new SentryClientTelemetry({
      ...OPTIONS,
      load: vendor.load,
    });
    vendor.arrive();

    await run({
      telemetry,
      reportedErrors: () => vendor.captured.map(({ error }) => error),
      breadcrumbs: () => vendor.crumbs,
    });
  });
});
