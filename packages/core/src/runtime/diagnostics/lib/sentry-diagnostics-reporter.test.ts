import { describe, expect, it } from "vitest";

import { SentryDiagnosticsReporter } from "./sentry-diagnostics-reporter.js";

const DESTINATION = {
  publicKey: "publickey",
  host: "o1.ingest.us.sentry.io",
  projectId: "42",
};

type Sent = { readonly url: string; readonly init: RequestInit | undefined };

function recordingSend(): { sent: Sent[]; send: typeof fetch } {
  const sent: Sent[] = [];
  return {
    sent,
    send: (input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        init,
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

describe("SentryDiagnosticsReporter", () => {
  it("posts one envelope with the public key in the auth header", async () => {
    const { sent, send } = recordingSend();
    const reporter = new SentryDiagnosticsReporter({
      destination: DESTINATION,
      environment: "production",
      send,
    });

    reporter.captureException({ error: new Error("boom"), source: "request" });
    await reporter.flush(1_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://o1.ingest.us.sentry.io/api/42/envelope/");
    expect(sent[0]?.init?.method).toBe("POST");
    expect(sent[0]?.init?.headers).toMatchObject({
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": "Sentry sentry_version=7, sentry_key=publickey, sentry_client=dads-diagnostics/1.0",
    });
  });

  it("never throws when the network fails", async () => {
    const reporter = new SentryDiagnosticsReporter({
      destination: DESTINATION,
      send: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    expect(() => {
      reporter.captureException({
        error: new Error("boom"),
        source: "request",
      });
    }).not.toThrow();
    await expect(reporter.flush(1_000)).resolves.toBe(true);
  });

  it("never throws when the send itself throws synchronously", () => {
    const reporter = new SentryDiagnosticsReporter({
      destination: DESTINATION,
      send: () => {
        throw new Error("fetch is broken");
      },
    });

    expect(() => {
      reporter.captureException({ error: new Error("boom"), source: "job" });
    }).not.toThrow();
  });

  it("gives up on a hung send at the flush deadline", async () => {
    const reporter = new SentryDiagnosticsReporter({
      destination: DESTINATION,
      send: () => new Promise<Response>(() => undefined),
    });
    reporter.captureException({ error: new Error("boom"), source: "process" });

    const started = Date.now();
    const delivered = await reporter.flush(50);

    expect(delivered).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("flushes at once when nothing is in flight", async () => {
    const reporter = new SentryDiagnosticsReporter({
      destination: DESTINATION,
      send: recordingSend().send,
    });

    await expect(reporter.flush(1_000)).resolves.toBe(true);
  });
});
