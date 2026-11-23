/**
 * What: shaping a browser snapshot into the wire contract — fallbacks for the
 * required fields, clamping for the bounded ones, and nothing for a field the
 * browser could not answer.
 * Why: the server's schema is strict and all-or-nothing (`decodeClientContext`
 * returns `null` on the first violation), so a single over-long or fractional
 * value would cost the whole context. The table below is every way a real
 * browser has of being unhelpful.
 */
import { describe, expect, it } from "vitest";

import { type ClientContext, clientContextSchema } from "@dads-framework/core/contract";

import { buildClientContext, type ClientEnvironmentSnapshot } from "./build-client-context.js";

const NOTHING_REPORTED: ClientEnvironmentSnapshot = {
  build: undefined,
  timeZone: undefined,
  locale: undefined,
  routeId: undefined,
  viewport: undefined,
  screen: undefined,
  touch: undefined,
  online: undefined,
  connection: undefined,
  deviceMemory: undefined,
  hardwareConcurrency: undefined,
  tabAgeMs: undefined,
};

const FULLY_REPORTED: ClientEnvironmentSnapshot = {
  build: "2026.09.10-abc1234",
  timeZone: "America/Los_Angeles",
  locale: "en-US",
  routeId: "/orders/$orderId",
  viewport: { w: 1440, h: 900, dpr: 2 },
  screen: { w: 2560, h: 1440 },
  touch: false,
  online: true,
  connection: "4g",
  deviceMemory: 8,
  hardwareConcurrency: 10,
  tabAgeMs: 61_000,
};

function contextFrom(overrides: Partial<ClientEnvironmentSnapshot>): ClientContext {
  return buildClientContext({ ...NOTHING_REPORTED, ...overrides });
}

describe("shaping one browser snapshot for the wire", () => {
  it("reports everything a browser answered", () => {
    expect(buildClientContext(FULLY_REPORTED)).toEqual({
      version: 1,
      client: "web",
      build: "2026.09.10-abc1234",
      timeZone: "America/Los_Angeles",
      locale: "en-US",
      routeId: "/orders/$orderId",
      viewport: { w: 1440, h: 900, dpr: 2 },
      screen: { w: 2560, h: 1440 },
      touch: false,
      online: true,
      connection: "4g",
      deviceMemory: 8,
      hardwareConcurrency: 10,
      tabAgeMs: 61_000,
    });
  });

  it("says 'unknown' rather than empty for the three required fields", () => {
    const context = contextFrom({});

    expect(context.build).toBe("unknown");
    expect(context.timeZone).toBe("unknown");
    expect(context.locale).toBe("unknown");
  });

  it.each([
    ["a blank build stamp", { build: "   " }, "build"],
    ["a blank time zone", { timeZone: "" }, "timeZone"],
    ["a blank locale", { locale: "" }, "locale"],
  ] as const)("treats %s as unreported", (_case, snapshot, field) => {
    expect(contextFrom(snapshot)[field]).toBe("unknown");
  });

  it.each([
    [
      "an over-long route id",
      { routeId: `/${"o".repeat(400)}` },
      (context: ClientContext) => {
        expect(context.routeId).toHaveLength(256);
      },
    ],
    [
      "an over-long build stamp",
      { build: "b".repeat(400) },
      (context: ClientContext) => {
        expect(context.build).toHaveLength(128);
      },
    ],
    [
      "a fractional viewport",
      { viewport: { w: 1439.5, h: 899.2, dpr: 1.5 } },
      (context: ClientContext) => {
        expect(context.viewport).toEqual({ w: 1440, h: 899, dpr: 1.5 });
      },
    ],
    [
      "a fractional core count",
      { hardwareConcurrency: 7.6 },
      (context: ClientContext) => {
        expect(context.hardwareConcurrency).toBe(8);
      },
    ],
    [
      "a negative tab age from a clock that moved",
      { tabAgeMs: -5 },
      (context: ClientContext) => {
        expect(context.tabAgeMs).toBe(0);
      },
    ],
    [
      "a half-answered viewport",
      { viewport: { w: Number.NaN, h: 900, dpr: 2 } },
      (context: ClientContext) => {
        expect(context.viewport).toBeUndefined();
      },
    ],
    [
      "an infinite screen",
      { screen: { w: Number.POSITIVE_INFINITY, h: 1440 } },
      (context: ClientContext) => {
        expect(context.screen).toBeUndefined();
      },
    ],
  ] as const)("survives %s", (_case, snapshot, expectation) => {
    expectation(contextFrom(snapshot));
  });

  it.each([
    ["nothing reported", NOTHING_REPORTED],
    ["everything reported", FULLY_REPORTED],
    ["hostile values", { ...FULLY_REPORTED, routeId: "/".repeat(9_000) }],
    ["broken numbers", { ...FULLY_REPORTED, deviceMemory: Number.NaN }],
  ] as const)("always produces a context the server accepts (%s)", (_case, snapshot) => {
    const parsed = clientContextSchema.safeParse(
      // The wire drops absent fields, and so must the check: the server never
      // sees a key explicitly set to `undefined`.
      JSON.parse(JSON.stringify(buildClientContext(snapshot))),
    );

    expect(parsed.success).toBe(true);
  });
});
