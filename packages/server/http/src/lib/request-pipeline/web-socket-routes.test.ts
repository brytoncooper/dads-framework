import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { notFound } from "@dads-framework/errors";

import { createHttpApp } from "../create-http-app.js";
import { requireSession } from "../route/access.js";
import { routeGroup } from "../route/route-group.js";
import { webSocketRoute } from "../route/web-socket-route.js";
import type { SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

const subjects: SubjectResolver = {
  resolve: (request) => {
    const id = request.headers["x-test-user"];
    return Promise.resolve(
      typeof id === "string" && id.length > 0 ? { type: "user", id } : null,
    );
  },
};

const echoRoute = webSocketRoute({
  path: "/echo",
  summary: "Echoes text frames to an allowed caller",
  access: requireSession(),
  openapi: { responses: { "101": { description: "WebSocket" } } },
  handler: ({ subject, accept }) => {
    if (subject?.id === "refused") {
      throw notFound("NOT_FOUND", "Not found");
    }
    accept((connection) => {
      connection.send(`hello ${subject?.id ?? "nobody"}`);
      connection.onMessage((text) => {
        connection.send(`echo ${text}`);
      });
    });
    return Promise.resolve();
  },
});

let apps: FastifyInstance[] = [];

async function listening(): Promise<string> {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Channels", [echoRoute]),
    subjects,
    authorization: new FakeAuthorization({}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `ws://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

function open(
  url: string,
  headers: Record<string, string>,
): Promise<{ socket: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const messages: string[] = [];
    socket.on("message", (data: Buffer) => messages.push(data.toString()));
    socket.once("open", () => {
      resolve({ socket, messages });
    });
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`status ${String(response.statusCode)}`));
    });
    socket.once("error", reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("webSocketRoute", () => {
  it("upgrades an allowed caller and carries text both ways", async () => {
    const base = await listening();
    const { socket, messages } = await open(`${base}/echo`, {
      "x-test-user": "u1",
    });
    socket.send("ping");
    await until(() => messages.length === 2);
    expect(messages).toEqual(["hello u1", "echo ping"]);
    socket.close();
  });

  it("answers an anonymous upgrade 401 through the access wall, with no socket", async () => {
    const base = await listening();
    await expect(open(`${base}/echo`, {})).rejects.toThrow("status 401");
  });

  it("answers an upgrade to an unknown path 404", async () => {
    const base = await listening();
    await expect(
      open(`${base}/nowhere`, { "x-test-user": "u1" }),
    ).rejects.toThrow("status 404");
  });

  it("answers a handler's refusal before any socket opens", async () => {
    const base = await listening();
    await expect(
      open(`${base}/echo`, { "x-test-user": "refused" }),
    ).rejects.toThrow("status 404");
  });

  it("answers a plain GET 426", async () => {
    const base = await listening();
    const response = await fetch(`${base.replace("ws:", "http:")}/echo`, {
      headers: { "x-test-user": "u1" },
    });
    expect(response.status).toBe(426);
  });

  it("drops a socket that sends a bad frame, and keeps serving others", async () => {
    const base = await listening();
    const { socket } = await open(`${base}/echo`, { "x-test-user": "u1" });
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => {
        resolve(code);
      });
    });
    // Over the 64 KiB a client may send: the server's socket errors.
    socket.send("x".repeat(70 * 1024));
    expect(await closed).not.toBe(1000);

    const next = await open(`${base}/echo`, { "x-test-user": "u2" });
    next.socket.send("still here");
    await until(() => next.messages.length === 2);
    expect(next.messages).toEqual(["hello u2", "echo still here"]);
    next.socket.close();
  });

  it("closes open sockets with 1001 when the app closes", async () => {
    const base = await listening();
    const { socket } = await open(`${base}/echo`, { "x-test-user": "u1" });
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => {
        resolve(code);
      });
    });
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
    expect(await closed).toBe(1001);
  });
});
