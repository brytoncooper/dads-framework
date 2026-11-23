import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { getFromApi } from "./api-verbs.js";
import { registerRequestMetadata } from "./request-metadata.js";

const responseSchema = z.object({ id: z.string() });

describe("request metadata composition", () => {
  afterEach(() => {
    registerRequestMetadata(undefined, undefined)();
    vi.unstubAllGlobals();
  });

  it("adds metadata for each captured context and observes rejected responses", async () => {
    const observed: {
      readonly context: string | null;
      readonly status: number;
    }[] = [];
    registerRequestMetadata(
      (request) => {
        const context = request.headers?.["x-test-caller-context"];
        return context === undefined
          ? undefined
          : { "x-test-client-state-hash": `hash:${context}` };
      },
      (response, request) => {
        observed.push({
          context: request.headers?.["x-test-caller-context"] ?? null,
          status: response.status,
        });
      },
    );
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return Promise.resolve(
        new Response(JSON.stringify({ code: "REJECTED" }), { status: 409 }),
      );
    });

    const call = getFromApi({
      route: { method: "GET", template: "/state", path: "/state" },
      returns: responseSchema,
      headers: { "x-test-caller-context": "company:a" },
    });

    await expect(call).rejects.toMatchObject({ status: 409 });
    expect(seen[0]?.get("x-test-client-state-hash")).toBe("hash:company:a");
    expect(observed).toEqual([{ context: "company:a", status: 409 }]);
  });

  it("keeps concurrent context metadata separate", async () => {
    const contexts: string[] = [];
    registerRequestMetadata((request) => {
      const context = request.headers?.["x-test-caller-context"];
      return context === undefined
        ? undefined
        : { "x-test-client-state-hash": context };
    }, undefined);
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      contexts.push(
        new Headers(init.headers).get("x-test-client-state-hash") ?? "missing",
      );
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "state" } }), {
          status: 200,
        }),
      );
    });
    await Promise.all([
      getFromApi({
        route: { method: "GET", template: "/state", path: "/state" },
        returns: responseSchema,
        headers: { "x-test-caller-context": "company:a" },
      }),
      getFromApi({
        route: { method: "GET", template: "/state", path: "/state" },
        returns: responseSchema,
        headers: { "x-test-caller-context": "company:b" },
      }),
    ]);

    expect(contexts).toEqual(["company:a", "company:b"]);
  });
});
