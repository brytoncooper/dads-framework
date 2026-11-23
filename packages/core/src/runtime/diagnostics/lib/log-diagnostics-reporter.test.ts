/**
 * What: one queryable line per fault, and capturing never becomes a fault.
 * Why: this runs inside the HTTP error handler, the fatal signal handler, and
 * the job failure handler. A throw here replaces a diagnosable fault with an
 * undiagnosable one — in the fatal case, while the process is already dying.
 * The line's shape matters too: it is what a plant-local operator greps.
 */

import { describe, expect, it } from "vitest";

import type { DiagnosticsReporter } from "./diagnostics-reporter.js";
import { LogDiagnosticsReporter } from "./log-diagnostics-reporter.js";

function recordingLog() {
  const entries: Record<string, unknown>[] = [];
  return {
    entries,
    error(entry: object): void {
      entries.push({ ...entry });
    },
  };
}

describe("LogDiagnosticsReporter", () => {
  it("writes one grouped line carrying the fingerprint", () => {
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new TypeError("boom"),
      source: "request",
      requestId: "req-1",
      routeId: "/api/orders",
    });

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      event: "fault.captured",
      source: "request",
      type: "TypeError",
      requestId: "req-1",
      routeId: "/api/orders",
    });
    expect(log.entries[0]?.["fingerprint"]).toEqual(expect.any(String));
  });

  it("uses its own discriminant, not the error handler's", () => {
    // The error handler still logs `unhandled.exception` with the full `err`.
    // Two lines sharing a discriminant would double every count built on it.
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "request",
    });

    expect(log.entries[0]?.["event"]).toBe("fault.captured");
  });

  it("carries the actor as kind and id, never a name", () => {
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "request",
      actor: { kind: "user", id: "user-1" },
    });

    expect(log.entries[0]).toMatchObject({
      actorKind: "user",
      actorId: "user-1",
    });
  });

  it("names the job a fault came out of", () => {
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "job",
      jobName: "audit.prune-request-log",
    });

    expect(log.entries[0]).toMatchObject({
      source: "job",
      jobName: "audit.prune-request-log",
    });
  });

  it("writes the severity, and the caller's fingerprint when it owns one", () => {
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "request",
      severity: "warning",
      fingerprint: "authz.lookup@/orgs/:id",
    });
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "process",
    });

    expect(log.entries[0]).toMatchObject({
      severity: "warning",
      fingerprint: "authz.lookup@/orgs/:id",
    });
    expect(log.entries[1]).toMatchObject({ severity: "fatal" });
  });

  it("omits what it was not told rather than writing nulls", () => {
    const log = recordingLog();
    new LogDiagnosticsReporter(log).captureException({
      error: new Error("boom"),
      source: "process",
    });

    expect(log.entries[0]).not.toHaveProperty("requestId");
    expect(log.entries[0]).not.toHaveProperty("jobName");
  });

  it("does not throw when the fault itself is hostile", () => {
    const log = recordingLog();
    const hostile = {
      get stack(): string {
        throw new Error("nope");
      },
    };

    expect(() => {
      new LogDiagnosticsReporter(log).captureException({
        error: hostile,
        source: "process",
      });
    }).not.toThrow();
  });

  it("does not throw when the logger itself fails", () => {
    // A fatal handler is often logging into a broken stdout.
    const broken = {
      error(): void {
        throw new Error("stdout closed");
      },
    };

    expect(() => {
      new LogDiagnosticsReporter(broken).captureException({
        error: new Error("boom"),
        source: "process",
      });
    }).not.toThrow();
  });

  it("flushes and closes without work, because nothing is buffered", async () => {
    // Held as the seam, which is how composition holds it — the driver's own
    // `flush` takes no argument because it has nothing to wait for.
    const reporter: DiagnosticsReporter = new LogDiagnosticsReporter(recordingLog());

    await expect(reporter.flush(1_000)).resolves.toBe(true);
    await expect(reporter.close()).resolves.toBeUndefined();
  });
});
