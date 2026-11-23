import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER } from "@dads-framework/core/contract";

import { type FetchHandler, mountFetchHandler } from "./mount-fetch-handler.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

type Seen = { url: string; method: string; requestId: string | null };

async function appWith(
  options: Parameters<typeof mountFetchHandler>[1],
): Promise<{ app: FastifyInstance; seen: Seen[] }> {
  const seen: Seen[] = [];
  const handler: FetchHandler = {
    handler: (request) => {
      seen.push({
        url: new URL(request.url).pathname,
        method: request.method,
        requestId: request.clone().headers.get(REQUEST_ID_HEADER),
      });
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
  };
  const app = Fastify({ logger: false, genReqId: () => "fastify-id" });
  await app.register(mountFetchHandler(handler, options), { prefix: "/mcp" });
  await app.ready();
  apps.push(app);
  return { app, seen };
}

describe("mountFetchHandler options", () => {
  it("does not answer the bare prefix unless asked to", async () => {
    const { app } = await appWith({});
    expect((await app.inject({ method: "POST", url: "/mcp" })).statusCode).toBe(404);
  });

  it("answers the bare prefix and paths under it with servePrefixRoot", async () => {
    const { app, seen } = await appWith({ servePrefixRoot: true });
    for (const url of ["/mcp", "/mcp/", "/mcp/deeper"]) {
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(200);
    }
    expect(seen.map((entry) => entry.url)).toEqual(["/mcp", "/mcp/", "/mcp/deeper"]);
  });

  it("forwards explicitly selected methods without adding HEAD", async () => {
    const { app, seen } = await appWith({
      methods: ["GET", "PUT", "PATCH", "DELETE"],
    });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/mcp/users" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "HEAD", url: "/mcp/users" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/mcp/users" })).statusCode).toBe(404);
    expect(seen.map(({ method }) => method)).toEqual(["PUT", "PATCH", "DELETE"]);
  });

  it("stamps Fastify's request id onto the fetch request, clones included", async () => {
    const { app, seen } = await appWith({
      servePrefixRoot: true,
      forwardRequestIdAs: REQUEST_ID_HEADER,
    });
    await app.inject({ method: "POST", url: "/mcp" });
    expect(seen[0]?.requestId).toBe("fastify-id");
  });

  it("applies its own body limit", async () => {
    const { app } = await appWith({
      servePrefixRoot: true,
      bodyLimitBytes: 10,
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(100) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it("refuses a caller past a limited path's budget before the handler sees it", async () => {
    const { app, seen } = await appWith({
      rateLimits: [{ method: "POST", path: "/mcp/register", perMinute: 2 }],
    });
    const register = () => app.inject({ method: "POST", url: "/mcp/register?x=1" });

    expect((await register()).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(200);
    const refused = await register();

    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.json()).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded — retry after the indicated delay",
      },
    });
    expect(seen).toHaveLength(2);
    expect((await app.inject({ method: "POST", url: "/mcp/token" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/mcp/register" })).statusCode).toBe(200);
  });
});
