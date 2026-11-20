/**
 * What: descriptor-bound client verbs derive requests and parse API envelopes.
 * Why: callers must not be able to author an HTTP method independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineGeneratedRoute,
  paginationMetaSchema,
  REQUEST_ID_HEADER,
} from "@dads-framework/contract";

import { ApiError, NetworkError, UnauthorizedError } from "./api-error.js";
import {
  getFromApi,
  getPageFromApi,
  getPageWithMetaFromApi,
  sendToApi,
  sendToApiWithoutResponse,
} from "./api-verbs.js";
import { onUnauthorizedResponse } from "./unauthorized-response-channel.js";

const widgetSchema = z.object({ id: z.string(), name: z.string() });
const widgetQuerySchema = z.object({
  page: z.number().int().min(1),
  tags: z.array(z.string()).optional(),
});
const createWidgetSchema = z.object({ name: z.string().min(1) });
const archiveWidgetSchema = z.object({ reason: z.string().min(1).optional() });

const widgetRoutes = {
  detail: defineGeneratedRoute(
    "GET",
    "/widgets/:widgetId",
    "getWidgetsByWidgetId",
    (widgetId: string) => `/widgets/${encodeURIComponent(widgetId)}`,
  ),
  create: defineGeneratedRoute(
    "POST",
    "/widgets",
    "postWidgets",
    () => "/widgets",
  ),
  archive: defineGeneratedRoute(
    "DELETE",
    "/widgets/:widgetId",
    "deleteWidgetsByWidgetId",
    (widgetId: string) => `/widgets/${encodeURIComponent(widgetId)}`,
  ),
};

type FetchCall = { url: string; init: RequestInit };

const calls: FetchCall[] = [];

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

function respondWithNoContent(): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
}

function lastCall(): FetchCall {
  const call = calls.at(-1);
  if (!call) {
    throw new Error("fetch was never called");
  }
  return call;
}

function headerValue(name: string): string | undefined {
  const headers = lastCall().init.headers;
  if (headers === undefined || headers instanceof Headers) {
    return undefined;
  }
  return new Headers(headers).get(name) ?? undefined;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getFromApi", () => {
  it("derives GET and the URL from the bound route descriptor", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });

    await getFromApi({
      route: widgetRoutes.detail.bind("w1"),
      returns: widgetSchema,
    });

    expect(lastCall().url).toBe("/api/widgets/w1");
    expect(lastCall().init.method).toBe("GET");
  });

  it("returns the payload inside the success envelope", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });

    await expect(
      getFromApi({
        route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
        returns: widgetSchema,
      }),
    ).resolves.toEqual({ id: "w1", name: "Mixer" });
  });

  it("sends the session cookie, a correlation id, and no body", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });

    await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    });

    expect(lastCall().init.credentials).toBe("include");
    expect(headerValue(REQUEST_ID_HEADER)).toMatch(/[0-9a-f-]{36}/);
    expect(lastCall().init.body).toBeUndefined();
  });

  it("serializes a query only after its own contract accepts it", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });

    await getFromApi({
      route: { method: "GET", template: "/widgets", path: "/widgets" },
      returns: widgetSchema,
      query: {
        schema: widgetQuerySchema,
        value: { page: 2, tags: ["hot", "cold"] },
      },
    });

    expect(lastCall().url).toBe("/api/widgets?page=2&tags=hot&tags=cold");
  });

  it("refuses to send a query the contract rejects", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });

    await expect(
      getFromApi({
        route: { method: "GET", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
        query: { schema: widgetQuerySchema, value: { page: 0 } },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("rejects a response the contract does not describe", async () => {
    respondWith(200, { data: { id: "w1" } });

    await expect(
      getFromApi({
        route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
        returns: widgetSchema,
      }),
    ).rejects.toThrow();
  });

  it("forwards the caller's abort signal", async () => {
    respondWith(200, { data: { id: "w1", name: "Mixer" } });
    const controller = new AbortController();

    await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
      signal: controller.signal,
    });

    expect(lastCall().init.signal).toBe(controller.signal);
  });
});

describe("getPageFromApi", () => {
  it("splits the paginated envelope into items and meta", async () => {
    respondWith(200, {
      data: [{ id: "w1", name: "Mixer" }],
      meta: { total: 1, page: 1, perPage: 25 },
    });

    await expect(
      getPageFromApi({
        route: { method: "GET", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
      }),
    ).resolves.toEqual({
      items: [{ id: "w1", name: "Mixer" }],
      meta: { total: 1, page: 1, perPage: 25 },
    });
  });
});

describe("getPageWithMetaFromApi", () => {
  const countedMetaSchema = paginationMetaSchema.extend({
    counts: z.object({ red: z.number() }).optional(),
  });

  it("parses the endpoint's own meta beside the items", async () => {
    respondWith(200, {
      data: [{ id: "w1", name: "Mixer" }],
      meta: { total: 1, page: 1, perPage: 25, counts: { red: 2 } },
    });

    await expect(
      getPageWithMetaFromApi({
        route: { method: "GET", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
        meta: countedMetaSchema,
      }),
    ).resolves.toEqual({
      items: [{ id: "w1", name: "Mixer" }],
      meta: { total: 1, page: 1, perPage: 25, counts: { red: 2 } },
    });
  });

  it("refuses a meta without the page window", async () => {
    respondWith(200, { data: [], meta: { counts: { red: 2 } } });

    await expect(
      getPageWithMetaFromApi({
        route: { method: "GET", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
        meta: countedMetaSchema,
      }),
    ).rejects.toThrow();
  });
});

describe("sendToApi", () => {
  it("serializes a mutation query only after its contract accepts it", async () => {
    respondWith(201, { data: { id: "w2", name: "Blender" } });
    await sendToApi({
      route: widgetRoutes.create.bind(),
      returns: widgetSchema,
      query: {
        schema: widgetQuerySchema,
        value: { page: 2, tags: ["hot", "cold"] },
      },
      body: { schema: createWidgetSchema, value: { name: "Blender" } },
    });
    expect(lastCall().url).toBe("/api/widgets?page=2&tags=hot&tags=cold");
    expect(lastCall().init.method).toBe("POST");
  });

  it("rejects an invalid mutation query before sending its body", async () => {
    respondWith(201, { data: { id: "w2", name: "Blender" } });
    await expect(
      sendToApi({
        route: widgetRoutes.create.bind(),
        returns: widgetSchema,
        query: { schema: widgetQuerySchema, value: { page: 0 } },
        body: { schema: createWidgetSchema, value: { name: "Blender" } },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("derives a mutation method from the bound route descriptor", async () => {
    respondWith(201, { data: { id: "w2", name: "Blender" } });

    await sendToApi({
      route: widgetRoutes.create.bind(),
      returns: widgetSchema,
      body: { schema: createWidgetSchema, value: { name: "Blender" } },
    });

    expect(lastCall().url).toBe("/api/widgets");
    expect(lastCall().init.method).toBe("POST");
  });

  it("validates the body, sends it as JSON, and unwraps the answer", async () => {
    respondWith(201, { data: { id: "w2", name: "Blender" } });

    await expect(
      sendToApi({
        route: { method: "POST", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
        body: { schema: createWidgetSchema, value: { name: "Blender" } },
      }),
    ).resolves.toEqual({ id: "w2", name: "Blender" });
    expect(lastCall().init.body).toBe(JSON.stringify({ name: "Blender" }));
    expect(headerValue("Content-Type")).toBe("application/json");
  });

  it("never sends a body its contract rejects", async () => {
    respondWith(201, { data: { id: "w2", name: "Blender" } });

    await expect(
      sendToApi({
        route: { method: "POST", template: "/widgets", path: "/widgets" },
        returns: widgetSchema,
        body: { schema: createWidgetSchema, value: { name: "" } },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("sendToApiWithoutResponse", () => {
  it("derives DELETE from the bound route descriptor", async () => {
    respondWithNoContent();

    await sendToApiWithoutResponse({
      route: widgetRoutes.archive.bind("w2"),
      body: { schema: archiveWidgetSchema, value: { reason: "obsolete" } },
    });

    expect(lastCall().url).toBe("/api/widgets/w2");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("accepts the empty body a 204 actually sends", async () => {
    // A 204 carries no bytes at all, so reading it as an envelope throws
    // rather than degrading — which is the whole reason this verb exists.
    respondWithNoContent();

    await expect(
      sendToApiWithoutResponse({
        route: {
          method: "DELETE",
          template: "/widgets/w2",
          path: "/widgets/w2",
        },
        body: { schema: archiveWidgetSchema, value: { reason: "obsolete" } },
      }),
    ).resolves.toBeUndefined();
    expect(lastCall().init.body).toBe(JSON.stringify({ reason: "obsolete" }));
  });

  it("never sends a body its contract rejects", async () => {
    respondWithNoContent();

    await expect(
      sendToApiWithoutResponse({
        route: {
          method: "DELETE",
          template: "/widgets/w2",
          path: "/widgets/w2",
        },
        body: { schema: archiveWidgetSchema, value: { reason: "" } },
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("still raises the API's refusal", async () => {
    respondWith(404, { error: { code: "WIDGET_NOT_FOUND", message: "Gone" } });

    await expect(
      sendToApiWithoutResponse({
        route: {
          method: "DELETE",
          template: "/widgets/w2",
          path: "/widgets/w2",
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("failures", () => {
  it("turns a fetch rejection into a typed network failure", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("RAW_BROWSER_NETWORK_MESSAGE")),
    );

    await expect(
      getFromApi({
        route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
        returns: widgetSchema,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("preserves an aborted request as cancellation", async () => {
    const aborted = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", () => Promise.reject(aborted));

    await expect(
      getFromApi({
        route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
        returns: widgetSchema,
      }),
    ).rejects.toBe(aborted);
  });

  it("turns an error envelope into a typed ApiError", async () => {
    respondWith(422, {
      error: { code: "VALIDATION_FAILED", message: "Name is required" },
    });

    const failure = await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      message: "Name is required",
    });
  });

  it("still produces a typed failure when the body is not an envelope", async () => {
    respondWith(502, "<html>gateway</html>");

    const failure = await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 502, code: "HTTP_ERROR" });
  });

  it("announces a 401 on the unauthorized-response channel exactly once", async () => {
    respondWith(401, {
      error: { code: "UNAUTHENTICATED", message: "No session" },
    });
    const heard = vi.fn();
    const unsubscribe = onUnauthorizedResponse(heard);

    const failure = await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    }).catch((error: unknown) => error);
    unsubscribe();

    expect(failure).toBeInstanceOf(UnauthorizedError);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stops announcing after the listener unsubscribes", async () => {
    respondWith(401, {
      error: { code: "UNAUTHENTICATED", message: "No session" },
    });
    const heard = vi.fn();
    onUnauthorizedResponse(heard)();

    await getFromApi({
      route: { method: "GET", template: "/widgets/w1", path: "/widgets/w1" },
      returns: widgetSchema,
    }).catch(() => undefined);

    expect(heard).not.toHaveBeenCalled();
  });
});
