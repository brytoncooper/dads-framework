/**
 * What: proxy hop count, not trust-all XFF, so rate limits cannot be rotated;
 * socket bounds that never cut off a handler still inside its deadline.
 * Why: trustProxy true takes the leftmost client-supplied address as request.ip;
 * a 10s idle-socket cap once dropped every slower answer as a load-balancer 502.
 */
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

function portOf(address: AddressInfo | string | null): number {
  if (address === null || typeof address === "string") throw new Error("the app is not listening on a TCP port");
  return address.port;
}
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "./create-http-app.js";

const apps: FastifyInstance[] = [];

const SPOOFED_CLIENT = "8.8.8.8";
const VIEWER = "203.0.113.10";
const CLOUDFRONT = "198.51.100.1";
const ALB = "10.0.0.1";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithHops(trustedProxyHops: number): Promise<FastifyInstance> {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    trustedProxyHops,
  });
  apps.push(app);
  app.get("/client", (request) => ({
    ip: request.ip,
    protocol: request.protocol,
  }));
  await app.ready();
  return app;
}

describe("createHttpApp", () => {
  it("treats X-Forwarded-Proto as the request protocol", async () => {
    const app = await appWithHops(2);
    const response = await app.inject({
      method: "GET",
      url: "/client",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(response.json()).toMatchObject({ protocol: "https" });
  });

  it("with two hops, request.ip is the viewer, not a spoofed leftmost XFF", async () => {
    const app = await appWithHops(2);
    const response = await app.inject({
      method: "GET",
      url: "/client",
      remoteAddress: ALB,
      headers: {
        "x-forwarded-for": `${SPOOFED_CLIENT}, ${VIEWER}, ${CLOUDFRONT}`,
      },
    });
    expect(response.json()).toMatchObject({ ip: VIEWER });
  });

  it("with zero hops, request.ip stays the socket even when XFF is spoofed", async () => {
    const app = await appWithHops(0);
    const response = await app.inject({
      method: "GET",
      url: "/client",
      remoteAddress: ALB,
      headers: {
        "x-forwarded-for": `${SPOOFED_CLIENT}, ${VIEWER}, ${CLOUDFRONT}`,
      },
    });
    expect(response.json()).toMatchObject({ ip: ALB });
  });
});

describe("createHttpApp socket bounds", () => {
  it("answers a handler that stays quiet longer than the headers timeout", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
      headersTimeoutMs: 200,
    });
    apps.push(app);
    app.get("/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { done: true };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = portOf(app.server.address());

    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port, path: "/slow" }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on("error", reject)
        .end();
    });

    expect(status).toBe(200);
  });

  it("keeps an idle socket open past the handler deadline and the keep-alive window", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    apps.push(app);
    await app.ready();

    expect(app.server.timeout).toBeGreaterThan(app.server.keepAliveTimeout);
    expect(app.server.keepAliveTimeout).toBeGreaterThan(30_000);
    expect(app.server.headersTimeout).toBe(10_000);
  });
});

describe("createHttpApp logStream", () => {
  function capturingStream(): { stream: Writable; lines: string[] } {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    return { stream, lines };
  }

  it("sends redacted log lines to the given stream", async () => {
    const { stream, lines } = capturingStream();
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logStream: stream,
    });
    apps.push(app);
    // Fastify's request serializer never writes headers, so the redact paths
    // would have nothing to act on. A child logger with an identity `req`
    // serializer lets the probe put a header object where the paths look,
    // which is the only way to see whether redaction runs before the stream.
    app.get("/ping", (request) => {
      request.log
        .child({}, { serializers: { req: (value: unknown) => value } })
        .info({ req: { headers: { authorization: "Bearer secret-token" } } });
      return { ok: true };
    });
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/ping?token=verification-test-token",
    });

    const output = lines.join("");
    expect(output).toContain("[Redacted]");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("verification-test-token");
  });

  it("starts in development with the default logging destination", async () => {
    const app = await createHttpApp({
      nodeEnv: "development",
      trustedOrigins: [],
    });
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  });

  it("builds in development with a logStream (no transport conflict)", async () => {
    const { stream } = capturingStream();
    const app = await createHttpApp({
      nodeEnv: "development",
      trustedOrigins: [],
      logStream: stream,
    });
    apps.push(app);

    await expect(app.ready()).resolves.toBeDefined();
  });

  it("keeps today's behavior without a logStream", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    apps.push(app);
    app.get("/ping", () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/ping" });

    expect(response.statusCode).toBe(200);
  });
});
