// Concurrent calls must carry the context captured by each caller, never a
// mutable global selection. Generic transport does not construct identities.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getFromApi, getPageFromApi, sendToApi, sendToApiWithoutResponse } from "./api-verbs.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
const returns = z.object({ id: z.string() });

describe("request-local API headers", () => {
  it("preserves independent A/B headers across concurrently pending requests", async () => {
    const requests: { headers: Headers; release: () => void }[] = [];
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({
            headers: new Headers(init.headers),
            release: () => {
              resolve(new Response(JSON.stringify({ data: { id: "same-document" } }), { status: 200 }));
            },
          });
        }),
    );
    const route = {
      method: "GET",
      template: "/documents/:id",
      path: "/documents/same",
    } satisfies Parameters<typeof getFromApi>[0]["route"];
    const first = getFromApi({
      route,
      returns,
      headers: { "x-test-context": "a" },
    });
    const second = getFromApi({
      route,
      returns,
      headers: { "x-test-context": "b" },
    });
    expect(requests.map((request) => request.headers.get("x-test-context"))).toEqual(["a", "b"]);
    for (const request of [...requests].reverse()) request.release();
    await Promise.all([first, second]);
  });

  it("forwards local headers on page, mutation, and no-response verbs", async () => {
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      const response =
        init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : new Response(
              JSON.stringify(
                init.method === "GET"
                  ? { data: [], meta: { page: 1, perPage: 20, total: 0 } }
                  : { data: { id: "document" } },
              ),
              { status: 200 },
            );
      return Promise.resolve(response);
    });
    await getPageFromApi({
      route: { method: "GET", template: "/documents", path: "/documents" },
      returns,
      headers: { "x-test-context": "page" },
    });
    await sendToApi({
      route: { method: "PATCH", template: "/documents", path: "/documents" },
      returns,
      headers: { "x-test-context": "write" },
    });
    await sendToApiWithoutResponse({
      route: { method: "DELETE", template: "/documents", path: "/documents" },
      headers: { "x-test-context": "delete" },
    });
    expect(headers.map((header) => header.get("x-test-context"))).toEqual(["page", "write", "delete"]);
  });
});
