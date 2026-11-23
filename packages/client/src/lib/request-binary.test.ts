import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { REQUEST_ID_HEADER } from "@dads-framework/core/contract";

import { UnauthorizedError } from "./api-error.js";
import { requestBinary } from "./api-verbs.js";
import { registerRequestMetadata } from "./request-metadata.js";
import { onUnauthorizedResponse } from "./unauthorized-response-channel.js";

afterEach(() => {
  registerRequestMetadata(undefined, undefined)();
  vi.unstubAllGlobals();
});

describe("requestBinary", () => {
  it("returns bytes while preserving credentials, context, metadata, and cancellation", async () => {
    const controller = new AbortController();
    const observed = vi.fn();
    registerRequestMetadata(
      (request) => ({
        "x-test-state": request.headers?.["x-test-context"] ?? "",
      }),
      observed,
    );
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () =>
        Promise.resolve(
          new Response("%PDF-1.7", {
            headers: { "Content-Type": "application/pdf" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const bytes = await requestBinary({
      route: {
        method: "GET",
        template: "/documents/:id/pdf",
        path: "/documents/one/pdf",
      },
      query: {
        schema: z.object({ paper: z.string() }),
        value: { paper: "letter" },
      },
      headers: { "x-test-context": "facility:one" },
      signal: controller.signal,
      accept: "application/pdf",
    });

    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7");
    const request = fetch.mock.calls[0];
    expect(request?.[0]).toBe("/api/documents/one/pdf?paper=letter");
    expect(request?.[1].credentials).toBe("include");
    expect(request?.[1].signal).toBe(controller.signal);
    const headers = new Headers(request?.[1].headers);
    expect(headers.get("Accept")).toBe("application/pdf");
    expect(headers.get("x-test-context")).toBe("facility:one");
    expect(headers.get("x-test-state")).toBe("facility:one");
    expect(headers.get(REQUEST_ID_HEADER)).toMatch(/[0-9a-f-]{36}/);
    expect(observed).toHaveBeenCalledOnce();
  });

  it("validates POST bodies and defaults to a binary response", async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response("pdf")),
    );
    vi.stubGlobal("fetch", fetch);
    await requestBinary({
      route: { method: "POST", template: "/preview", path: "/preview" },
      body: {
        schema: z.object({ label: z.string().min(1) }),
        value: { label: "Gross" },
      },
    });
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"label":"Gross"}');
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("Accept")).toBe(
      "application/octet-stream",
    );

    await expect(
      requestBinary({
        route: { method: "POST", template: "/preview", path: "/preview" },
        body: {
          schema: z.object({ label: z.string().min(1) }),
          value: { label: "" },
        },
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("converts API failures and announces an expired session", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "SESSION_EXPIRED", message: "Sign in" },
          }),
          { status: 401 },
        ),
      ),
    );
    const unauthorized = vi.fn();
    const unsubscribe = onUnauthorizedResponse(unauthorized);
    try {
      await expect(
        requestBinary({
          route: {
            method: "GET",
            template: "/ticket.pdf",
            path: "/ticket.pdf",
          },
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
      expect(unauthorized).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
});
