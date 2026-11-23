/**
 * What: startHttpHost wires Fastify app creation, protocol mounts, typed routes,
 * health probes, telemetry hooks, and startup rollback in one host call.
 * Why: application entrypoints share one deterministic HTTP host lifecycle
 * without repeating Fastify registration and error-cleanup boilerplate.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { HttpWiringError } from "../http-errors.js";
import { getRoute } from "../route/get-route.js";
import { publicAccess } from "../route/access.js";
import { routeGroup } from "../route/route-group.js";
import { startHttpHost } from "./start-http-host.js";

const helloRoute = getRoute({
  path: "/hello",
  summary: "Return a public greeting",
  access: publicAccess(),
  response: z.object({ greeting: z.string() }),
  handler: () => ({ greeting: "hi" }),
});

const silentPorts = {
  subjects: { resolve: () => Promise.resolve(null) },
  authorization: { check: () => Promise.resolve(false) },
};

describe("startHttpHost", () => {
  it("mounts API routes under /api by default, exposes health probes, and forwards protocol mounts", async () => {
    const onClose = vi.fn();
    const annotateRequest = vi.fn();
    const app = await startHttpHost({
      baseUrl: "https://app.example.test",
      nodeEnv: "test",
      logger: false,
      routes: routeGroup("Greeting", [helloRoute]),
      ...silentPorts,
      health: {
        pingDatabase: () => Promise.resolve(),
        pingCriticalServices: () => Promise.resolve(),
      },
      telemetry: {
        currentTraceId: () => "trace-123",
        annotateRequest,
      },
      mounts: [
        {
          prefix: "/api/auth",
          handler: (request) =>
            Promise.resolve(
              new Response(JSON.stringify({ path: new URL(request.url).pathname }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
        },
        {
          prefix: "/api/custom",
          handler: {
            handler: () => Promise.resolve(new Response("mounted", { status: 201 })),
          },
          options: { methods: ["POST"], servePrefixRoot: true },
        },
      ],
      onClose,
    });

    try {
      const greeting = await app.inject({ method: "GET", url: "/api/hello" });
      expect(greeting.statusCode).toBe(200);
      expect(JSON.parse(greeting.body)).toEqual({ data: { greeting: "hi" } });
      expect(annotateRequest).toHaveBeenCalled();

      const live = await app.inject({ method: "GET", url: "/api/health" });
      expect(live.statusCode).toBe(200);
      expect(JSON.parse(live.body)).toEqual({ data: { status: "ok" } });

      const ready = await app.inject({ method: "GET", url: "/api/ready" });
      expect(ready.statusCode).toBe(200);
      expect(JSON.parse(ready.body)).toEqual({ data: { status: "ready" } });

      const authRes = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(authRes.statusCode).toBe(200);
      expect(JSON.parse(authRes.body)).toEqual({ path: "/api/auth/session" });

      const customRes = await app.inject({ method: "POST", url: "/api/custom" });
      expect(customRes.statusCode).toBe(201);
      expect(customRes.body).toBe("mounted");
    } finally {
      await app.close();
    }

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports 503 on /ready when a readiness check fails and honors custom apiPrefix", async () => {
    const app = await startHttpHost({
      baseUrl: "https://app.example.test",
      nodeEnv: "test",
      logger: false,
      apiPrefix: "/v2",
      routes: routeGroup("Greeting", [helloRoute]),
      ...silentPorts,
      health: {
        pingDatabase: () => Promise.reject(new Error("db offline")),
        pingCriticalServices: () => Promise.resolve(),
      },
    });

    try {
      const live = await app.inject({ method: "GET", url: "/v2/health" });
      expect(live.statusCode).toBe(200);

      const ready = await app.inject({ method: "GET", url: "/v2/ready" });
      expect(ready.statusCode).toBe(503);

      const greeting = await app.inject({ method: "GET", url: "/v2/hello" });
      expect(greeting.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("closes the Fastify instance and runs onClose when route registration fails", async () => {
    const onClose = vi.fn();
    const badRoute = getRoute({
      path: "/broken",
      summary: "Route with missing machine credential resolver",
      access: publicAccess(),
      capabilities: { machineCredential: "missing-resolver" },
      response: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    await expect(
      startHttpHost({
        baseUrl: "https://app.example.test",
        nodeEnv: "test",
        logger: false,
        routes: routeGroup("Broken", [badRoute]),
        ...silentPorts,
        onClose,
      }),
    ).rejects.toThrow(HttpWiringError);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
