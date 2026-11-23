/**
 * What: reading one tab's environment, where every browser API is optional and
 * a hostile one can throw on access.
 * Why: this runs inside the request path. A browser that hides `navigator`
 * extras, or a privacy shield whose getter throws, must cost one `undefined`
 * field — never the request the reader is waiting on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markTabStarted,
  readClientEnvironment,
  setCurrentRouteId,
  type ClientNavigatorLike,
  type ClientWindowLike,
} from "./read-client-environment.js";

const FULL_WINDOW: ClientWindowLike = {
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 2,
  screen: { width: 2560, height: 1440 },
};

const FULL_NAVIGATOR: ClientNavigatorLike = {
  language: "en-US",
  maxTouchPoints: 0,
  onLine: true,
  connection: { effectiveType: "4g" },
  deviceMemory: 8,
  hardwareConcurrency: 10,
};

function readWith(
  window: ClientWindowLike,
  navigator: ClientNavigatorLike,
): ReturnType<typeof readClientEnvironment> {
  return readClientEnvironment({
    build: "2026.09.10-abc1234",
    window,
    navigator,
    nowMs: Date.now(),
  });
}

afterEach(() => {
  setCurrentRouteId(undefined);
});

describe("reading what this tab can say about itself", () => {
  it("reports every API the browser offers", () => {
    const environment = readWith(FULL_WINDOW, FULL_NAVIGATOR);

    expect(environment).toMatchObject({
      build: "2026.09.10-abc1234",
      locale: "en-US",
      viewport: { w: 1440, h: 900, dpr: 2 },
      screen: { w: 2560, h: 1440 },
      touch: false,
      online: true,
      connection: "4g",
      deviceMemory: 8,
      hardwareConcurrency: 10,
    });
    expect(environment.timeZone).toEqual(expect.any(String));
  });

  it("calls a device with contact points a touch device", () => {
    const environment = readWith(FULL_WINDOW, {
      ...FULL_NAVIGATOR,
      maxTouchPoints: 5,
    });

    expect(environment.touch).toBe(true);
  });

  it("reports nothing for an API this browser does not have", () => {
    const environment = readWith({}, {});

    expect(environment).toMatchObject({
      locale: undefined,
      viewport: undefined,
      screen: undefined,
      touch: undefined,
      online: undefined,
      connection: undefined,
      deviceMemory: undefined,
      hardwareConcurrency: undefined,
    });
  });

  it("drops a viewport the browser only half answered", () => {
    const environment = readWith(
      { innerWidth: 1440, screen: { width: 2560 } },
      FULL_NAVIGATOR,
    );

    expect(environment.viewport).toBeUndefined();
    expect(environment.screen).toBeUndefined();
  });

  it("survives a getter that throws instead of answering", () => {
    const hostile: ClientNavigatorLike = {
      get language(): string {
        throw new Error("blocked by a privacy extension");
      },
      onLine: true,
    };

    const environment = readWith(FULL_WINDOW, hostile);

    expect(environment.locale).toBeUndefined();
    expect(environment.online).toBe(true);
  });

  it("reports the route the app last said the reader was on", () => {
    setCurrentRouteId("/orders/$orderId");

    expect(readWith(FULL_WINDOW, FULL_NAVIGATOR).routeId).toBe(
      "/orders/$orderId",
    );
  });

  it("stops reporting a route once the app clears it", () => {
    setCurrentRouteId("/orders/$orderId");
    setCurrentRouteId(undefined);

    expect(readWith(FULL_WINDOW, FULL_NAVIGATOR).routeId).toBeUndefined();
  });

  it("ages the tab forward from the start the app stamped", () => {
    markTabStarted(1_000);

    expect(readAt(1_000).tabAgeMs).toBe(0);
    expect(readAt(6_000).tabAgeMs).toBe(5_000);
  });

  // A fresh module: the point is the state BEFORE any stamp, which no test
  // that has already stamped one can observe.
  it("reports no age until the app stamps a start", async () => {
    vi.resetModules();
    const fresh = await import("./read-client-environment.js");

    expect(
      fresh.readClientEnvironment({
        build: undefined,
        window: FULL_WINDOW,
        navigator: FULL_NAVIGATOR,
        nowMs: 6_000,
      }).tabAgeMs,
    ).toBeUndefined();
  });
});

function readAt(nowMs: number): ReturnType<typeof readClientEnvironment> {
  return readClientEnvironment({
    build: undefined,
    window: FULL_WINDOW,
    navigator: FULL_NAVIGATOR,
    nowMs,
  });
}
