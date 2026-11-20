/**
 * What: reporting never disturbs the page, a burst costs one request, and the
 * envelope on the wire is the contract's.
 * Why: this driver runs inside error handlers, so its failure modes are
 * nastier than most — a throw here replaces a diagnosable fault with an
 * undiagnosable one, and a request per error turns one broken component into
 * a storm against an API that may already be the unwell thing.
 */

import { describe, expect, it, vi } from "vitest";

import { reportClientDiagnosticsBodySchema } from "@dads-framework/contract";

import { LocalClientTelemetry } from "./local-client-telemetry.js";

function telemetryWith(send: typeof fetch) {
  return new LocalClientTelemetry({
    endpoint: "/api/client-diagnostics",
    release: "0192f2a0",
    clientContext: () => undefined,
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    send,
  });
}

/** Typed as `fetch` so `mock.calls` keeps the init the driver actually sent. */
/** The JSON body the driver sent, as a value the contract can parse. */
function sentBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected the driver to send a JSON string body");
  }
  return JSON.parse(body);
}

function accepting() {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
}

describe("LocalClientTelemetry", () => {
  it("sends a batch the contract accepts", async () => {
    const send = accepting();
    const telemetry = telemetryWith(send);

    telemetry.reportError(new TypeError("boom"), { kind: "render" });
    await telemetry.flush(1_000);

    expect(send).toHaveBeenCalledTimes(1);
    const [, init] = send.mock.calls[0] ?? [];
    const body: unknown = sentBody(init);
    expect(reportClientDiagnosticsBodySchema.safeParse(body).success).toBe(
      true,
    );
  });

  it("coalesces a burst into one request", async () => {
    // A component failing in a loop must not become a request storm.
    const send = accepting();
    const telemetry = telemetryWith(send);

    telemetry.reportError(new TypeError("one"), { kind: "render" });
    telemetry.reportError(new TypeError("two"), { kind: "render" });
    telemetry.reportError(new TypeError("three"), { kind: "render" });
    await telemetry.flush(1_000);

    expect(send).toHaveBeenCalledTimes(1);
    const [, init] = send.mock.calls[0] ?? [];
    const parsed = reportClientDiagnosticsBodySchema.parse(sentBody(init));
    expect(parsed.events).toHaveLength(3);
  });

  it("asks to survive the unload a fatal error usually causes", async () => {
    const send = accepting();
    const telemetry = telemetryWith(send);

    telemetry.reportError(new TypeError("boom"), { kind: "render" });
    await telemetry.flush(1_000);

    const [, init] = send.mock.calls[0] ?? [];
    expect(init?.keepalive).toBe(true);
    expect(init?.credentials).toBe("include");
  });

  it("carries the request id that joins the fault to its request", async () => {
    const send = accepting();
    const telemetry = telemetryWith(send);

    telemetry.reportError(new TypeError("boom"), {
      kind: "query",
      requestId: "req-42",
    });
    await telemetry.flush(1_000);

    const [, init] = send.mock.calls[0] ?? [];
    const parsed = reportClientDiagnosticsBodySchema.parse(sentBody(init));
    expect(parsed.events[0]?.requestId).toBe("req-42");
  });

  it("attaches the breadcrumbs that preceded the fault", async () => {
    const send = accepting();
    const telemetry = telemetryWith(send);

    telemetry.addBreadcrumb({
      at: "2026-09-14T09:59:00.000Z",
      category: "navigation",
      label: "/orders",
    });
    telemetry.reportError(new TypeError("boom"), { kind: "render" });
    await telemetry.flush(1_000);

    const [, init] = send.mock.calls[0] ?? [];
    const parsed = reportClientDiagnosticsBodySchema.parse(sentBody(init));
    expect(parsed.events[0]?.breadcrumbs).toHaveLength(1);
  });

  it("answers false, and never throws, when the report could not be sent", async () => {
    const telemetry = telemetryWith(
      vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError("Failed to fetch")),
      ),
    );

    telemetry.reportError(new TypeError("boom"), { kind: "render" });

    await expect(telemetry.flush(1_000)).resolves.toBe(false);
  });

  it("does not throw out of reportError when describing the fault fails", () => {
    const telemetry = telemetryWith(accepting());
    const hostile = {
      get stack(): string {
        throw new Error("nope");
      },
    };

    expect(() => {
      telemetry.reportError(hostile, { kind: "window-error" });
    }).not.toThrow();
  });

  it("sends nothing when there is nothing to send", async () => {
    const send = accepting();
    const telemetry = telemetryWith(send);

    await expect(telemetry.flush(1_000)).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a failed batch rather than growing a buffer forever", async () => {
    // Offline is a design state here; re-buffering would grow without bound.
    const send = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("offline")),
    );
    const telemetry = telemetryWith(send);

    telemetry.reportError(new TypeError("boom"), { kind: "render" });
    await telemetry.flush(1_000);
    await telemetry.flush(1_000);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
