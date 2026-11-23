import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { FakeAuthorization } from "@dads-framework/access/testing";

import { errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import type { SubjectResolver } from "../request-pipeline/enforce-access.js";
import { registerRoutes } from "../request-pipeline/register-routes.js";
import { requireSession } from "./access.js";
import { routeGroup } from "./route-group.js";
import { sseRoute, type SseStream } from "./sse-route.js";

/**
 * The `sseRoute` kit primitive proven end to end (plan Task E1): it owns the SSE
 * framing (`data:`/`:comment` lines), the `:ready` flush, the keep-alive
 * heartbeat, and teardown-on-disconnect, while `access` gates it exactly like a
 * typed verb. A hijacked SSE response never "completes", so the streaming cases
 * listen on a real socket; the access refusal short-circuits before the stream,
 * so it uses `inject`.
 */

const subjects: SubjectResolver = {
  resolve: (request) => {
    const id = request.headers["x-test-user"];
    return Promise.resolve(typeof id === "string" && id.length > 0 ? { type: "user", id } : null);
  },
};

let openApps: { close: () => Promise<void> }[] = [];
let openRequests: http.ClientRequest[] = [];

type CapturedResponseHeaders = {
  vary?: string;
};

afterEach(async () => {
  for (const request of openRequests) {
    request.destroy();
  }
  openRequests = [];
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
});

/** Boot a one-route app whose stream captures its `SseStream` and counts teardowns. */
async function boot(heartbeatMs?: number): Promise<{
  app: Awaited<ReturnType<typeof createHttpApp>>;
  streams: SseStream[];
  cleanups: () => number;
}> {
  const streams: SseStream[] = [];
  let cleanupCount = 0;
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Test", [
      sseRoute({
        path: "/sse",
        summary: "test stream",
        access: requireSession(),
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        openapi: { responses: { "200": { description: "stream" } } },
        handler: ({ open }) => {
          open((stream) => {
            streams.push(stream);
            return () => {
              cleanupCount += 1;
            };
          });
          return Promise.resolve();
        },
      }),
    ]),
    subjects,
    authorization: new FakeAuthorization({}),
  });
  await app.ready();
  openApps.push(app);
  return { app, streams, cleanups: () => cleanupCount };
}

async function listen(app: Awaited<ReturnType<typeof createHttpApp>>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return address.port;
}

function openStream(port: number, user: string | null): { chunks: string[]; responseHeaders: CapturedResponseHeaders } {
  const headers: Record<string, string> = {};
  if (user !== null) headers["x-test-user"] = user;
  const chunks: string[] = [];
  const responseHeaders: CapturedResponseHeaders = {};
  const request = http.get({ host: "127.0.0.1", port, path: "/sse", headers }, (response) => {
    const vary = response.headers.vary;
    if (vary !== undefined) responseHeaders.vary = vary;
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => chunks.push(chunk));
  });
  openRequests.push(request);
  return { chunks, responseHeaders };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("sseRoute", () => {
  it("flushes `:ready` and frames `send()` as `data: <json>` on connect", async () => {
    const stack = await boot();
    const port = await listen(stack.app);
    const stream = openStream(port, "alice");

    await waitFor(() => stack.streams.length === 1);
    stack.streams[0]?.send({ n: 1 });
    await waitFor(() => stream.chunks.join("").includes("data:"));

    const body = stream.chunks.join("");
    expect(body).toContain(":ready\n\n");
    expect(body).toContain('data: {"n":1}\n\n');
    expect(stream.responseHeaders.vary?.toLowerCase()).toContain("accept-language");
  });

  it("emits a bare `:` heartbeat comment while the stream is open", async () => {
    const stack = await boot(20);
    const port = await listen(stack.app);
    const stream = openStream(port, "alice");

    // The bare comment `:\n\n` is distinct from the `:ready\n\n` flush.
    await waitFor(() => stream.chunks.join("").includes(":\n\n"));
    expect(stream.chunks.join("")).toContain(":\n\n");
  });

  it("runs the teardown when the client disconnects", async () => {
    const stack = await boot();
    const port = await listen(stack.app);
    openStream(port, "alice");

    await waitFor(() => stack.streams.length === 1);
    expect(stack.cleanups()).toBe(0);
    openRequests[0]?.destroy();
    await waitFor(() => stack.cleanups() === 1);
    expect(stack.cleanups()).toBe(1);
  });

  it("enforces `access` — an anonymous caller is 401, never a stream", async () => {
    const stack = await boot();
    const res = await stack.app.inject({ method: "GET", url: "/sse" });

    expect(res.statusCode).toBe(401);
    expect(errorBodyOf(res).code).toBe("NOT_AUTHENTICATED");
    expect(stack.streams).toHaveLength(0);
  });
});
