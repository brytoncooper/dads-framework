import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCALE_HEADER } from "@dads-framework/core/contract";

import { currentRequestLocale, setRequestLocale } from "./request-locale.js";

/**
 * What: every outbound request carries the language channel's current value on
 * `Accept-Language`, and reads it per request rather than once at import.
 * Why: the language rides a header precisely so no route contract has to grow a
 * parameter, which means this one chokepoint is the only thing making it true.
 * The per-request read is the half worth pinning and the half nothing else can
 * see: `SUPPORTED_LOCALES` holds one entry, so `setRequestLocale` cannot change
 * the VALUE a test observes today, and a locale captured at import time would
 * ship a stale language the day it can.
 */
vi.mock("./request-locale.js", { spy: true });

/**
 * The transport is imported here, after a reset, rather than at the top of the
 * file — this project runs `isolate: false`, so one module graph is shared by
 * every test file in the worker. Whichever file imports `./api-verbs` first is
 * the one whose mocks `send-api-request` binds, and three siblings import that
 * same chain without faking this channel. A static import would therefore hand
 * this file the REAL `currentRequestLocale` whenever the sequencer put a
 * sibling first, and the spy below would silently observe zero calls and prove
 * nothing. Re-evaluating under this file's own mock is what makes the per-call
 * assertion mean the same thing in every file order.
 */
vi.resetModules();
const { getFromApi, sendToApi } = await import("./api-verbs.js");

const widgetSchema = z.object({ id: z.string() });
const createWidgetSchema = z.object({ name: z.string().min(1) });

const calls: RequestInit[] = [];

function respondWith(body: unknown): void {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

function lastLanguageAsked(): string | undefined {
  const headers = calls.at(-1)?.headers;
  if (headers === undefined || headers instanceof Headers) return undefined;
  return new Headers(headers).get(LOCALE_HEADER) ?? undefined;
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(currentRequestLocale).mockClear();
  respondWith({ data: { id: "w1" } });
});

afterEach(() => {
  setRequestLocale("en");
  vi.unstubAllGlobals();
});

describe("the language every request asks for", () => {
  it("asks for English until something says otherwise", () => {
    expect(currentRequestLocale()).toBe("en");
  });

  it("rides along on a request with no body", async () => {
    await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    });

    expect(lastLanguageAsked()).toBe("en");
  });

  it("rides along on a request WITH a body", async () => {
    await sendToApi({
      route: { method: "POST", template: "/widgets", path: "/widgets" },
      body: { schema: createWidgetSchema, value: { name: "widget" } },
      returns: widgetSchema,
    });

    expect(lastLanguageAsked()).toBe("en");
  });

  it("asks the channel again on every request, not once at import time", async () => {
    setRequestLocale("en");
    await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    });
    await getFromApi({
      route: { method: "GET", template: "/widgets/w2", path: "/widgets/w2" },
      returns: widgetSchema,
    });

    // Two requests, two reads: a locale captured at import would read zero
    // times here and keep answering with whatever was set when the module
    // first loaded.
    expect(vi.mocked(currentRequestLocale)).toHaveBeenCalledTimes(2);
    expect(lastLanguageAsked()).toBe("en");
  });
});
