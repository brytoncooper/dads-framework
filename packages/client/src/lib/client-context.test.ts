/**
 * What: the `x-client-context` header rides every request when an app has
 * described itself, and never breaks one when it has not.
 * Why: this is debugging exhaust. A provider that throws, returns
 * nothing, or describes something too large for the header budget must cost a
 * log field and nothing else — the request still has to reach the user's data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CLIENT_CONTEXT_HEADER,
  CLIENT_CONTEXT_MAX_BYTES,
  type ClientContext,
  decodeClientContext,
} from "@dads-framework/core/contract";

import { getFromApi, sendToApi } from "./api-verbs.js";
import {
  currentClientContextHeader,
  setClientContextProvider,
} from "./client-context.js";

const widgetSchema = z.object({ id: z.string() });

const calls: RequestInit[] = [];

const WEB_CONTEXT: ClientContext = {
  version: 1,
  client: "web",
  build: "2026.09.10-abc1234",
  timeZone: "America/Los_Angeles",
  locale: "en-US",
  routeId: "/orders/$orderId",
};

function lastContextSent(): string | undefined {
  const headers = calls.at(-1)?.headers;
  if (headers === undefined || headers instanceof Headers) return undefined;
  return new Headers(headers).get(CLIENT_CONTEXT_HEADER) ?? undefined;
}

async function fetchOneWidget(): Promise<void> {
  await getFromApi({
    route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
    returns: widgetSchema,
  });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(
      new Response(JSON.stringify({ data: { id: "w1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  setClientContextProvider(null);
  vi.unstubAllGlobals();
});

describe("the client context every request carries", () => {
  it("says nothing until an app describes this client", () => {
    expect(currentClientContextHeader()).toBeUndefined();
  });

  it("rides along on a request, and decodes back to what was described", async () => {
    setClientContextProvider(() => WEB_CONTEXT);

    await fetchOneWidget();

    expect(decodeClientContext(lastContextSent())).toEqual(WEB_CONTEXT);
  });

  it("rides along on a mutating call, which is what the request log joins on", async () => {
    setClientContextProvider(() => WEB_CONTEXT);

    await sendToApi({
      route: { method: "POST", template: "/widgets", path: "/widgets" },
      body: { schema: z.object({ name: z.string() }), value: { name: "w" } },
      returns: widgetSchema,
    });

    expect(decodeClientContext(lastContextSent())).toEqual(WEB_CONTEXT);
  });

  it("stops describing the client when the provider is cleared", async () => {
    setClientContextProvider(() => WEB_CONTEXT);
    setClientContextProvider(null);

    await fetchOneWidget();

    expect(lastContextSent()).toBeUndefined();
  });

  it("drops the header when the provider has nothing to say", async () => {
    setClientContextProvider(() => undefined);

    await fetchOneWidget();

    expect(lastContextSent()).toBeUndefined();
  });

  it("drops the header — and never the request — when the provider throws", async () => {
    setClientContextProvider(() => {
      throw new Error("router is not mounted yet");
    });

    await expect(fetchOneWidget()).resolves.toBeUndefined();
    expect(lastContextSent()).toBeUndefined();
  });

  it("drops a context too large for the header budget", async () => {
    setClientContextProvider(() => ({
      ...WEB_CONTEXT,
      // The contract caps each field, so only an unvalidated caller reaches
      // this size — the guard is what keeps it off the wire either way.
      routeId: "/o/".padEnd(CLIENT_CONTEXT_MAX_BYTES + 1, "x"),
    }));

    expect(currentClientContextHeader()).toBeUndefined();

    await fetchOneWidget();

    expect(lastContextSent()).toBeUndefined();
  });

  it("asks the provider again on every request, not once at import time", async () => {
    const describeClient = vi.fn(() => WEB_CONTEXT);
    setClientContextProvider(describeClient);

    await fetchOneWidget();
    await fetchOneWidget();

    expect(describeClient).toHaveBeenCalledTimes(2);
  });
});
