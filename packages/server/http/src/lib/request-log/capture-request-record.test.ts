/**
 * WHAT: the `onResponse` capture over a real Fastify instance — which
 * responses earn a row, what the row says about access, and that a broken
 * sink cannot reach the client.
 *
 * WHY over a real app rather than a fake request: the three facts this hook
 * depends on are Fastify's, not ours — that `onResponse` runs for a 404 with
 * no route, that `routeOptions.url` is the prefixed pattern, and that the
 * resolved audit actor is NOT still in scope by the time the hook runs. A
 * hand-built request object would agree with whatever we assumed.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import { requires } from "../route/route-guards.test-support.js";
import { anonymousActor, type AuditActor } from "@dads-framework/audit-actor";
import type { SubjectRef } from "@dads-framework/access/runtime";
import { FakeDiagnosticsReporter } from "@dads-framework/runtime/diagnostics/testing";
import { noteAuthorizationWarning } from "@dads-framework/runtime/request-work";

import { createHttpApp } from "../create-http-app.js";
import type {
  PermissionChecker,
  SubjectResolver,
} from "../request-pipeline/enforce-access.js";
import { registerRoutes } from "../request-pipeline/register-routes.js";
import { fromParam, requireSession } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import { RequestLogSink } from "./request-log-sink.js";
import type { RequestRecord } from "./request-record.js";

const CALLER: SubjectRef = { type: "user", id: "u1" };
const ORGANIZATION_ID = "org-1";

class CapturingSink extends RequestLogSink {
  readonly rows: RequestRecord[] = [];

  constructor(includeSuccessfulReads = false) {
    super(includeSuccessfulReads);
  }

  override record(row: RequestRecord): void {
    this.rows.push(row);
  }

  override flush(): Promise<void> {
    return Promise.resolve();
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}

class ExplodingSink extends RequestLogSink {
  override record(): void {
    throw new Error("sink is down");
  }

  override flush(): Promise<void> {
    return Promise.resolve();
  }

  override close(): Promise<void> {
    return Promise.resolve();
  }
}

const subjects: SubjectResolver = {
  resolve: (request) =>
    Promise.resolve(request.headers["x-anon"] === "1" ? null : CALLER),
  resolveWithMethod: (request) =>
    Promise.resolve(
      request.headers["x-anon"] === "1"
        ? null
        : { subject: CALLER, method: "session-cookie" },
    ),
};

const routes = routeGroup("Orders", [
  postRoute({
    route: { method: "POST", template: "/orgs/:id/orders" },
    summary: "Create an order",
    access: requires(
      permissionToken("organizations/organization", "orders_create"),
      fromParam("id"),
    ),
    params: z.object({ id: z.string() }),
    body: z.object({ number: z.string().min(1) }),
    response: z.object({ id: z.string() }),
    handler: () => ({ id: "order-1" }),
  }),
  getRoute({
    route: { method: "GET", template: "/orgs/:id" },
    summary: "Read an organization",
    access: requireSession(),
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string() }),
    handler: ({ params }) => ({ id: params.id }),
  }),
  getRoute({
    route: { method: "GET", template: "/orgs/:id/busy" },
    summary: "Read something whose lookup passed the warning mark",
    access: requireSession(),
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string() }),
    handler: ({ params }) => {
      noteAuthorizationWarning({
        type: "AuthorizationLookupOverWarningMark",
        fingerprint: "authz.lookup-size:test/machine#view",
        detail: "lookupResources on test/machine#view returned 1200 ids",
      });
      return { id: params.id };
    },
  }),
]);

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(
  sink: RequestLogSink,
  authorization: PermissionChecker = grantsOrdersCreate,
  diagnostics?: FakeDiagnosticsReporter,
): Promise<FastifyInstance> {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    apiRelease: "sha256:test-release",
    requestLog: () => sink,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  registerRoutes(app, {
    routes,
    subjects,
    authorization,
    auditActorForSubject: ({ subject, requestId }): AuditActor =>
      subject === null
        ? anonymousActor(requestId)
        : { kind: "user", id: subject.id, requestId },
  });
  await app.ready();
  apps.push(app);
  return app;
}

/** Says yes to exactly one caller on exactly one organization. */
const grantsOrdersCreate: PermissionChecker = {
  check: (query) =>
    Promise.resolve(
      query.subject.id === CALLER.id &&
        query.permission === "orders_create" &&
        query.resource.id === ORGANIZATION_ID,
    ),
};

const grantsNothing: PermissionChecker = {
  check: () => Promise.resolve(false),
};

describe("captureRequestRecord", () => {
  it("records an allowed mutation with the resolved actor, permission and credential", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    const response = await app.inject({
      method: "POST",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      payload: { number: "SO-1" },
      headers: { "user-agent": "vitest" },
    });

    expect(response.statusCode).toBe(201);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      method: "POST",
      routeId: "/orgs/:id/orders",
      path: "/orgs/:id/orders",
      status: 201,
      decision: "allow",
      actorKind: "user",
      actorId: "u1",
      authMethod: "session-cookie",
      accessKind: "permission",
      permission: "orders_create",
      resourceType: "organizations/organization",
      resourceId: ORGANIZATION_ID,
      apiRelease: "sha256:test-release",
      userAgent: "vitest",
    });
  });

  it("records a denial as denied, naming the permission the route declared", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink, grantsNothing);

    const response = await app.inject({
      method: "POST",
      url: "/orgs/other-org/orders",
      payload: { number: "SO-1" },
    });

    expect(response.statusCode).toBe(404);
    expect(sink.rows[0]).toMatchObject({
      status: 404,
      decision: "denied",
      accessKind: "permission",
      permission: "orders_create",
      resourceType: "organizations/organization",
    });
  });

  it("names the signed-in caller a denial refused, while the wire stays a bare 404", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink, grantsNothing);

    const response = await app.inject({
      method: "POST",
      url: "/orgs/other-org/orders",
      payload: { number: "SO-1" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource not found" },
    });
    expect(sink.rows[0]).toMatchObject({
      decision: "denied",
      actorKind: "user",
      actorId: CALLER.id,
    });
  });

  it("records an unauthenticated caller as unauthenticated", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    const response = await app.inject({
      method: "POST",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      payload: { number: "SO-1" },
      headers: { "x-anon": "1" },
    });

    expect(response.statusCode).toBe(401);
    expect(sink.rows[0]).toMatchObject({
      status: 401,
      decision: "unauthenticated",
      actorKind: "anonymous",
    });
  });

  it("records the envelope's error code for a validation failure", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    const response = await app.inject({
      method: "POST",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      payload: { number: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(sink.rows[0]).toMatchObject({
      status: 400,
      decision: "error",
      errorCode: "VALIDATION_FAILED",
    });
  });

  it("records a request that matched no route at all", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    const response = await app.inject({ method: "POST", url: "/nothing/here" });

    expect(response.statusCode).toBe(404);
    expect(sink.rows[0]).toMatchObject({
      routeId: null,
      path: "/nothing/here",
      decision: "not-found",
      errorCode: "NOT_FOUND",
      accessKind: null,
    });
  });

  it("skips a successful read unless the sink asked for reads", async () => {
    const quiet = new CapturingSink();
    const app = await appWith(quiet);
    await app.inject({ method: "GET", url: `/orgs/${ORGANIZATION_ID}` });
    expect(quiet.rows).toHaveLength(0);

    const loud = new CapturingSink(true);
    const reading = await appWith(loud);
    await reading.inject({ method: "GET", url: `/orgs/${ORGANIZATION_ID}` });
    expect(loud.rows).toHaveLength(1);
  });

  it("skips a CORS preflight, which asks a question rather than doing anything", async () => {
    const quiet = new CapturingSink();
    const app = await appWith(quiet);

    const preflight = await app.inject({
      method: "OPTIONS",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      headers: {
        origin: "https://example.test",
        "access-control-request-method": "POST",
      },
    });

    expect(preflight.statusCode).toBeLessThan(400);
    expect(quiet.rows).toHaveLength(0);
  });

  it("still records a read that failed", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    await app.inject({
      method: "GET",
      url: `/orgs/${ORGANIZATION_ID}`,
      headers: { "x-anon": "1" },
    });

    expect(sink.rows[0]).toMatchObject({ status: 401, method: "GET" });
  });

  it("never records the probe routes kept out of the log stream", async () => {
    const sink = new CapturingSink(true);
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
      requestLog: () => sink,
    });
    app.get("/api/health", () => ({ status: "ok" }));
    await app.ready();
    apps.push(app);

    await app.inject({ method: "GET", url: "/api/health" });

    expect(sink.rows).toHaveLength(0);
  });

  it("answers the request normally when the sink throws", async () => {
    const app = await appWith(new ExplodingSink());

    const response = await app.inject({
      method: "POST",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      payload: { number: "SO-1" },
    });

    expect(response.statusCode).toBe(201);
  });

  it("records a successful read that tripped an authorization guard, once an hour per route", async () => {
    const sink = new CapturingSink();
    const app = await appWith(sink);

    const first = await app.inject({ method: "GET", url: "/orgs/org-1/busy" });
    const second = await app.inject({ method: "GET", url: "/orgs/org-1/busy" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      method: "GET",
      routeId: "/orgs/:id/busy",
      status: 200,
      decision: "allow",
      exceptionType: "AuthorizationLookupOverWarningMark",
      exceptionFingerprint:
        "authz.lookup-size:test/machine#view@/orgs/:id/busy",
    });
  });

  it("reports a tripped guard as a warning, grouped the way its row is", async () => {
    const diagnostics = new FakeDiagnosticsReporter();
    const app = await appWith(
      new CapturingSink(),
      grantsOrdersCreate,
      diagnostics,
    );

    await app.inject({ method: "GET", url: "/orgs/org-1/busy" });

    expect(diagnostics.captured).toHaveLength(1);
    expect(diagnostics.captured[0]).toMatchObject({
      source: "request",
      severity: "warning",
      routeId: "/orgs/:id/busy",
      fingerprint: "authz.lookup-size:test/machine#view@/orgs/:id/busy",
    });
  });

  it("captures nothing when no sink is wired", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    registerRoutes(app, {
      routes,
      subjects,
      authorization: grantsOrdersCreate,
    });
    await app.ready();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/orgs/${ORGANIZATION_ID}/orders`,
      payload: { number: "SO-1" },
    });

    expect(response.statusCode).toBe(201);
  });
});
