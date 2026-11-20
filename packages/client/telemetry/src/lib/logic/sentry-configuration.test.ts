/**
 * What: the vendor configuration masks everything, records only sessions that
 * broke, and never asserts an identity.
 * Why: these are the promises the whole Session Replay decision rests on, and
 * every one of them fails silently. A replay with `maskAllText` off looks
 * identical in code review and identical in the dashboard until somebody
 * watches a recording of a customer's order and reads their prices back. A
 * test is the only thing that notices.
 */

import { describe, expect, it } from "vitest";

import { sentryConfiguration } from "./sentry-configuration.js";

const INPUT = {
  dsn: "https://publickey@o0.ingest.example.com/1",
  release: "abc1234",
  environment: "production",
  tunnel: "/api/telemetry/envelope",
};

describe("sentryConfiguration", () => {
  it("masks every text node, input and media element", () => {
    const { replayMasking } = sentryConfiguration(INPUT);

    expect(replayMasking.maskAllText).toBe(true);
    expect(replayMasking.maskAllInputs).toBe(true);
    expect(replayMasking.blockAllMedia).toBe(true);
  });

  it("captures no request detail and no bodies at all", () => {
    // Empty and present, not absent: an allow-list that names nothing is a
    // decision, a missing one is a default nobody chose.
    const { replayMasking } = sentryConfiguration(INPUT);

    expect(replayMasking.networkDetailAllowUrls).toEqual([]);
    expect(replayMasking.networkCaptureBodies).toBe(false);
  });

  it("records only sessions that broke, and all of them", () => {
    const configuration = sentryConfiguration(INPUT);

    expect(configuration.replaysSessionSampleRate).toBe(0);
    expect(configuration.replaysOnErrorSampleRate).toBe(1);
  });

  it("collects no user, cookies, headers, bodies or query strings", () => {
    // The SDK's own defaults are the other way round for all but the first,
    // so every one of these is a category that would otherwise be sent.
    expect(sentryConfiguration(INPUT).dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
    });
  });

  it("leaves tracing to OpenTelemetry", () => {
    // Tracing is exported over OTLP from the API. Sampling spans
    // here would bill for a tree we already own and tie the swap point to
    // this vendor.
    expect(sentryConfiguration(INPUT).tracesSampleRate).toBe(0);
  });

  it("sends through our own origin rather than the vendor's host", () => {
    expect(sentryConfiguration(INPUT).tunnel).toBe("/api/telemetry/envelope");
  });

  it("carries the release so a minified frame can find its source map", () => {
    expect(sentryConfiguration(INPUT).release).toBe("abc1234");
  });
});
