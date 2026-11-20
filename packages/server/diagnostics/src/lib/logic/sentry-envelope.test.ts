import { describe, expect, it } from "vitest";

import { describeException } from "./describe-exception.js";
import {
  buildSentryEnvelope,
  buildSentryEvent,
  parseStackFrames,
  sentryAuthHeader,
  sentryEnvelopeUrl,
} from "./sentry-envelope.js";

const CONTEXT = {
  eventId: "0123456789abcdef0123456789abcdef",
  now: new Date("2026-11-03T12:00:00.000Z"),
  environment: "production",
  release: "sha256:release",
};

function errorWith(message: string): Error {
  const error = new TypeError(message);
  error.stack = [
    `TypeError: ${message}`,
    "    at createOrder (/app/apps/service/domains/orders/server/src/lib/create-order.mutation.js:88:15)",
    "    at Object.query (/app/node_modules/pg/lib/client.js:500:1)",
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at async /app/dist/apps/api/server/main.cjs:90210:41",
  ].join("\n");
  return error;
}

describe("sentry destination", () => {
  it("posts to the project's envelope endpoint with the public key", () => {
    const destination = {
      publicKey: "publickey",
      host: "o1.ingest.us.sentry.io",
      projectId: "42",
    };

    expect(sentryEnvelopeUrl(destination)).toBe(
      "https://o1.ingest.us.sentry.io/api/42/envelope/",
    );
    expect(sentryAuthHeader(destination)).toBe(
      "Sentry sentry_version=7, sentry_key=publickey, sentry_client=dads-diagnostics/1.0",
    );
  });
});

describe("buildSentryEnvelope", () => {
  it("is an envelope header, an item header, and the event", () => {
    const lines = buildSentryEnvelope(
      { error: errorWith("boom"), source: "request" },
      CONTEXT,
    ).split("\n");

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      event_id: CONTEXT.eventId,
      sent_at: "2026-11-03T12:00:00.000Z",
    });
    expect(JSON.parse(lines[1] ?? "")).toEqual({ type: "event" });
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({
      event_id: CONTEXT.eventId,
    });
  });
});

describe("buildSentryEvent", () => {
  it("carries the exception, environment, release and request tags", () => {
    const event = buildSentryEvent(
      {
        error: errorWith("boom"),
        source: "request",
        requestId: "req-1",
        routeId: "/api/orders/:id",
      },
      CONTEXT,
    );

    expect(event).toMatchObject({
      level: "error",
      platform: "node",
      environment: "production",
      release: "sha256:release",
      timestamp: CONTEXT.now.getTime() / 1_000,
      exception: { values: [{ type: "TypeError", value: "boom" }] },
      tags: {
        source: "request",
        route: "/api/orders/:id",
        request_id: "req-1",
      },
    });
  });

  it("groups by our own fingerprint, so Sentry splits where request_log does", () => {
    const error = errorWith("boom");

    expect(
      buildSentryEvent({ error, source: "request" }, CONTEXT)["fingerprint"],
    ).toEqual([describeException(error).fingerprint]);
    expect(
      buildSentryEvent(
        { error, source: "request", fingerprint: "authz.lookup@/orgs/:id" },
        CONTEXT,
      )["fingerprint"],
    ).toEqual(["authz.lookup@/orgs/:id"]);
  });

  it("reports a poisoned process as fatal and a guard warning as a warning", () => {
    const error = errorWith("boom");

    expect(
      buildSentryEvent({ error, source: "process" }, CONTEXT),
    ).toMatchObject({
      level: "fatal",
      exception: { values: [{ mechanism: { handled: false } }] },
    });
    expect(
      buildSentryEvent(
        { error, source: "request", severity: "warning" },
        CONTEXT,
      )["level"],
    ).toBe("warning");
  });

  it("names the job a fault came out of", () => {
    expect(
      buildSentryEvent(
        { error: errorWith("boom"), source: "job", jobName: "audit.prune" },
        CONTEXT,
      )["tags"],
    ).toEqual({ source: "job", job_name: "audit.prune" });
  });

  it("prefers the release the fault carries over the configured one", () => {
    expect(
      buildSentryEvent(
        {
          error: errorWith("boom"),
          source: "request",
          release: "sha256:other",
        },
        CONTEXT,
      )["release"],
    ).toBe("sha256:other");
  });

  it("sends the user's id and nothing else about them", () => {
    const event = buildSentryEvent(
      {
        error: errorWith("boom"),
        source: "request",
        actor: { kind: "user", id: "user-1" },
      },
      CONTEXT,
    );

    expect(event["user"]).toEqual({ id: "user-1" });
  });

  it("never sends a query string, a header, a body, or an email address", () => {
    const event = buildSentryEvent(
      {
        error: errorWith("no account for jane.doe@example.com"),
        source: "request",
        routeId: "/api/orders?token=secret",
      },
      CONTEXT,
    );
    const serialized = JSON.stringify(event);

    expect(event["tags"]).toMatchObject({ route: "/api/orders" });
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("jane.doe@example.com");
    expect(serialized).toContain("no account for [email]");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("contexts");
    expect(event).not.toHaveProperty("extra");
  });

  it("describes a thrown non-error without leaking its contents", () => {
    const serialized = JSON.stringify(
      buildSentryEvent(
        { error: { secret: "customer-private-value" }, source: "job" },
        CONTEXT,
      ),
    );

    expect(serialized).not.toContain("customer-private-value");
  });
});

describe("parseStackFrames", () => {
  it("lists frames oldest first, marking only application frames in_app", () => {
    const frames = parseStackFrames(errorWith("boom").stack);

    expect(frames).toEqual([
      {
        filename: "/app/dist/apps/api/server/main.cjs",
        lineno: 90210,
        colno: 41,
        in_app: true,
      },
      {
        function: "processTicksAndRejections",
        filename: "node:internal/process/task_queues",
        lineno: 95,
        colno: 5,
        in_app: false,
      },
      {
        function: "Object.query",
        filename: "/app/node_modules/pg/lib/client.js",
        lineno: 500,
        colno: 1,
        in_app: false,
      },
      {
        function: "createOrder",
        filename:
          "/app/apps/service/domains/orders/server/src/lib/create-order.mutation.js",
        lineno: 88,
        colno: 15,
        in_app: true,
      },
    ]);
  });

  it("returns no frames for a stackless fault", () => {
    expect(parseStackFrames(undefined)).toEqual([]);
  });
});
