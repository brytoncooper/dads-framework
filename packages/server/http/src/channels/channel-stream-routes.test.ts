import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { FakeAuthorization } from "@dads-framework/access/testing";
import { ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE } from "@dads-framework/core/contract";

import { createHttpApp } from "../lib/create-http-app.js";
import { HttpWiringError } from "../lib/http-errors.js";
import type { SubjectResolver } from "../lib/request-pipeline/enforce-access.js";
import { registerRoutes } from "../lib/request-pipeline/register-routes.js";
import { errorBodyOf, FakeChannelFanOut } from "../testing/index.js";
import type { ChannelEnvelope } from "./channel-fan-out.js";
import {
  createChannelStreamRoutes,
  type ChannelAccessCheck,
  type ChannelStreamRoutesOptions,
} from "./channel-stream-routes.js";

const subjects: SubjectResolver = {
  resolve: (request) => {
    const id = request.headers["x-test-user"];
    return Promise.resolve(typeof id === "string" && id.length > 0 ? { type: "user", id } : null);
  },
};

let openApps: { close: () => Promise<void> }[] = [];
let openRequests: http.ClientRequest[] = [];

afterEach(async () => {
  for (const request of openRequests) {
    request.destroy();
  }
  openRequests = [];
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
});

function makeEnvelope(channel: string, seq: number, payload: unknown): ChannelEnvelope {
  return {
    channel,
    seq,
    at: "2026-11-23T12:00:00.000Z",
    payload,
  };
}

async function bootChannelApp(
  options: Omit<ChannelStreamRoutesOptions, "channelFanOut"> & { fanOut?: FakeChannelFanOut },
) {
  const fanOut = options.fanOut ?? new FakeChannelFanOut();
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: createChannelStreamRoutes({
      channelFanOut: fanOut,
      canAccessScope: options.canAccessScope,
      allowedChannels: options.allowedChannels,
      ...(options.channelAccess === undefined ? {} : { channelAccess: options.channelAccess }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.scopeQueryParam === undefined ? {} : { scopeQueryParam: options.scopeQueryParam }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.recheckIntervalMs === undefined ? {} : { recheckIntervalMs: options.recheckIntervalMs }),
    }),
    subjects,
    authorization: new FakeAuthorization({}),
  });
  await app.ready();
  openApps.push(app);
  return { app, fanOut };
}

async function listen(app: Awaited<ReturnType<typeof createHttpApp>>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected bound TCP address");
  }
  return address.port;
}

function openStream(
  port: number,
  path: string,
  user: string,
): { request: http.ClientRequest; chunks: string[]; ended: () => boolean } {
  const chunks: string[] = [];
  let isEnded = false;
  const request = http.get({ host: "127.0.0.1", port, path, headers: { "x-test-user": user } }, (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => chunks.push(chunk));
    response.on("end", () => {
      isEnded = true;
    });
  });
  openRequests.push(request);
  return { request, chunks, ended: () => isEnded };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createChannelStreamRoutes", () => {
  it("streams published events for authorized scopes and subscribed channels only, ignoring unknown channels", async () => {
    const canAccessScope: ChannelAccessCheck = {
      check: ({ subject, scopeId }) => Promise.resolve(subject.id === "alice" && scopeId === "ws-1"),
    };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["orders.updated", "billing.updated"],
    });
    const port = await listen(app);

    const stream = openStream(port, "/channels/stream?scopeId=ws-1&channels=orders.updated,unknown.channel", "alice");
    await waitFor(() => stream.chunks.join("").includes(":ready\n\n"));

    const wanted = makeEnvelope("orders.updated", 1, { id: "ord-1" });
    const ignoredChannel = makeEnvelope("billing.updated", 2, { id: "inv-1" });
    const unknownChannel = makeEnvelope("unknown.channel", 3, { id: "x" });
    const otherScope = makeEnvelope("orders.updated", 4, { id: "ord-2" });

    fanOut.publish("ws-1", ignoredChannel);
    fanOut.publish("ws-1", unknownChannel);
    fanOut.publish("ws-2", otherScope);
    fanOut.publish("ws-1", wanted);

    await waitFor(() => stream.chunks.join("").includes('"ord-1"'));
    const body = stream.chunks.join("");

    expect(body).toContain(`data: ${JSON.stringify(wanted)}\n\n`);
    expect(body).not.toContain("inv-1");
    expect(body).not.toContain("unknown.channel");
    expect(body).not.toContain("ord-2");
    expect(fanOut.subscriberCount("ws-1")).toBe(1);
  });

  it("denies unauthenticated callers with 401 and invalid queries with 400", async () => {
    const canAccessScope: ChannelAccessCheck = { check: () => Promise.resolve(true) };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["orders.updated"],
    });

    const anon = await app.inject({ method: "GET", url: "/channels/stream?scopeId=ws-1" });
    expect(anon.statusCode).toBe(401);
    expect(errorBodyOf(anon).code).toBe("NOT_AUTHENTICATED");

    const missingScope = await app.inject({
      method: "GET",
      url: "/channels/stream",
      headers: { "x-test-user": "alice" },
    });
    expect(missingScope.statusCode).toBe(400);
    expect(errorBodyOf(missingScope).code).toBe("VALIDATION_FAILED");

    const extraParam = await app.inject({
      method: "GET",
      url: "/channels/stream?scopeId=ws-1&unexpected=1",
      headers: { "x-test-user": "alice" },
    });
    expect(extraParam.statusCode).toBe(400);
    expect(fanOut.subscriberCount()).toBe(0);
  });

  it("denies callers who fail canAccessScope with 404 without leaking existence", async () => {
    const canAccessScope: ChannelAccessCheck = {
      check: ({ subject, scopeId }) => Promise.resolve(subject.id === "alice" && scopeId === "ws-1"),
    };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["orders.updated"],
    });

    const denied = await app.inject({
      method: "GET",
      url: "/channels/stream?scopeId=ws-1",
      headers: { "x-test-user": "mallory" },
    });

    expect(denied.statusCode).toBe(404);
    expect(denied.headers[ACCESS_REFUSAL_HEADER]).toBe(ACCESS_REFUSAL_VALUE);
    expect(errorBodyOf(denied).code).toBe("RESOURCE_NOT_FOUND");
    expect(fanOut.subscriberCount()).toBe(0);
  });

  it("blocks opening on per-channel denial and closes the stream when channel access is revoked mid-stream", async () => {
    let allowBilling = false;
    const canAccessScope: ChannelAccessCheck = { check: () => Promise.resolve(true) };
    const billingCheck: ChannelAccessCheck = {
      check: ({ subject, channel }) =>
        Promise.resolve(subject.id === "alice" && channel === "billing.updated" && allowBilling),
    };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["orders.updated", "billing.updated"],
      channelAccess: new Map([["billing.updated", billingCheck]]),
    });

    const blocked = await app.inject({
      method: "GET",
      url: "/channels/stream?scopeId=ws-1&channels=billing.updated",
      headers: { "x-test-user": "alice" },
    });
    expect(blocked.statusCode).toBe(404);
    expect(errorBodyOf(blocked).code).toBe("RESOURCE_NOT_FOUND");

    allowBilling = true;
    const port = await listen(app);
    const stream = openStream(port, "/channels/stream?scopeId=ws-1&channels=orders.updated,billing.updated", "alice");
    await waitFor(() => stream.chunks.join("").includes(":ready\n\n"));

    const firstBilling = makeEnvelope("billing.updated", 1, { invoice: "inv-before-revoke" });
    fanOut.publish("ws-1", firstBilling);
    await waitFor(() => stream.chunks.join("").includes("inv-before-revoke"));

    allowBilling = false;
    const revokedBilling = makeEnvelope("billing.updated", 2, { invoice: "inv-after-revoke" });
    const laterOrder = makeEnvelope("orders.updated", 3, { order: "ord-after-close" });
    fanOut.publish("ws-1", revokedBilling);
    fanOut.publish("ws-1", laterOrder);

    await waitFor(() => stream.ended() && fanOut.subscriberCount("ws-1") === 0);
    const body = stream.chunks.join("");
    expect(body).toContain("inv-before-revoke");
    expect(body).not.toContain("inv-after-revoke");
    expect(body).not.toContain("ord-after-close");
  });

  it("rechecks canAccessScope on delivery and closes the stream when scope access is revoked", async () => {
    let allowScope = true;
    const canAccessScope: ChannelAccessCheck = {
      check: ({ subject, scopeId }) => Promise.resolve(allowScope && subject.id === "alice" && scopeId === "ws-1"),
    };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["orders.updated"],
    });
    const port = await listen(app);

    const stream = openStream(port, "/channels/stream?scopeId=ws-1", "alice");
    await waitFor(() => stream.chunks.join("").includes(":ready\n\n"));

    fanOut.publish("ws-1", makeEnvelope("orders.updated", 1, { order: "ord-before-scope-revoke" }));
    await waitFor(() => stream.chunks.join("").includes("ord-before-scope-revoke"));

    allowScope = false;
    fanOut.publish("ws-1", makeEnvelope("orders.updated", 2, { order: "ord-after-scope-revoke" }));

    await waitFor(() => stream.ended() && fanOut.subscriberCount("ws-1") === 0);
    // Any further publishes after closure must never be delivered.
    allowScope = true;
    fanOut.publish("ws-1", makeEnvelope("orders.updated", 3, { order: "ord-after-regrant" }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const body = stream.chunks.join("");
    expect(body).toContain("ord-before-scope-revoke");
    expect(body).not.toContain("ord-after-scope-revoke");
    expect(body).not.toContain("ord-after-regrant");
    expect(fanOut.subscriberCount()).toBe(0);
  });

  it("closes an idle stream automatically when periodic recheck observes grant expiry", async () => {
    let allowScope = true;
    let allowBilling = true;
    const { app, fanOut } = await bootChannelApp({
      canAccessScope: { check: () => Promise.resolve(allowScope) },
      allowedChannels: ["billing.updated"],
      channelAccess: new Map([["billing.updated", { check: () => Promise.resolve(allowBilling) }]]),
      recheckIntervalMs: 25,
    });
    const port = await listen(app);

    const scopeStream = openStream(port, "/channels/stream?scopeId=ws-1", "alice");
    await waitFor(() => scopeStream.chunks.join("").includes(":ready\n\n"));
    expect(fanOut.subscriberCount("ws-1")).toBe(1);

    allowScope = false;
    await waitFor(() => scopeStream.ended() && fanOut.subscriberCount("ws-1") === 0);

    allowScope = true;
    const channelStream = openStream(port, "/channels/stream?scopeId=ws-1", "alice");
    await waitFor(() => channelStream.chunks.join("").includes(":ready\n\n"));
    expect(fanOut.subscriberCount("ws-1")).toBe(1);

    allowBilling = false;
    await waitFor(() => channelStream.ended() && fanOut.subscriberCount("ws-1") === 0);
  });

  it("rejects non-positive recheckIntervalMs at route creation", () => {
    expect(() =>
      createChannelStreamRoutes({
        channelFanOut: new FakeChannelFanOut(),
        canAccessScope: { check: () => Promise.resolve(true) },
        allowedChannels: ["orders.updated"],
        recheckIntervalMs: 0,
      }),
    ).toThrow(HttpWiringError);
  });

  it("cleans up the subscription when the client disconnects and supports custom scopeQueryParam", async () => {
    const canAccessScope: ChannelAccessCheck = {
      check: ({ scopeId }) => Promise.resolve(scopeId === "proj-42"),
    };
    const { app, fanOut } = await bootChannelApp({
      canAccessScope,
      allowedChannels: ["projects.updated"],
      path: "/events/stream",
      scopeQueryParam: "projectId",
    });
    const port = await listen(app);

    const stream = openStream(port, "/events/stream?projectId=proj-42", "alice");
    await waitFor(() => stream.chunks.join("").includes(":ready\n\n"));
    expect(fanOut.subscriberCount("proj-42")).toBe(1);

    stream.request.destroy();
    await waitFor(() => fanOut.subscriberCount("proj-42") === 0);
    expect(fanOut.subscriberCount()).toBe(0);
  });
});
