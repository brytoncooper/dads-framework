/**
 * What: a misconfigured reporter fails at boot instead of dropping faults.
 * Why: the failure this whole library exists to end is "we had no idea". A
 * reporter that booted without a way to write would recreate it exactly, and
 * silently — every capture would succeed and nothing would ever be recorded.
 */

import { describe, expect, it } from "vitest";

import { createDiagnosticsReporter } from "./create-diagnostics-reporter.js";
import { LogDiagnosticsReporter } from "./log-diagnostics-reporter.js";
import { NoneDiagnosticsReporter } from "./none-diagnostics-reporter.js";

describe("createDiagnosticsReporter", () => {
  it("builds the none driver without anything else", () => {
    expect(createDiagnosticsReporter({ driver: "none" })).toBeInstanceOf(
      NoneDiagnosticsReporter,
    );
  });

  it("builds the log driver with a logger", () => {
    const reporter = createDiagnosticsReporter({
      driver: "log",
      log: { error: () => undefined },
    });

    expect(reporter).toBeInstanceOf(LogDiagnosticsReporter);
  });

  it("refuses to boot a log driver with nowhere to write", () => {
    expect(() => createDiagnosticsReporter({ driver: "log" })).toThrow(
      /requires a logger/,
    );
  });

  it("refuses to boot a sentry driver with nowhere to send", () => {
    expect(() =>
      createDiagnosticsReporter({
        driver: "sentry",
        log: { error: () => undefined },
      }),
    ).toThrow(/DIAGNOSTICS_SENTRY_DSN/);
  });

  it("keeps the log line when it sends to Sentry", async () => {
    // Sentry is a rented copy; the line is the one that survives leaving it.
    const lines: object[] = [];
    let sends = 0;
    const reporter = createDiagnosticsReporter({
      driver: "sentry",
      log: { error: (entry) => lines.push(entry) },
      sentry: {
        destination: {
          publicKey: "publickey",
          host: "o1.ingest.us.sentry.io",
          projectId: "42",
        },
        send: () => {
          sends += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
    });

    reporter.captureException({ error: new Error("boom"), source: "request" });
    await expect(reporter.flush(1_000)).resolves.toBe(true);

    expect(lines).toHaveLength(1);
    expect(sends).toBe(1);
  });
});
