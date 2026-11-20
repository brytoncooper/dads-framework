import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  access,
  accessModel,
  entityHandle,
  permissionToken,
} from "@dads-framework/access";
import {
  requires,
  requiresVisible,
} from "../route/route-guards.test-support.js";
import { FakeAuthorization } from "@dads-framework/access/testing";
import {
  ACCESS_REFUSAL_HEADER,
  ACCESS_REFUSAL_VALUE,
  paginationQuerySchema,
  REQUEST_ID_HEADER,
} from "@dads-framework/contract";

import { bodyOf, errorBodyOf } from "../../testing/index.js";
import { createHttpApp, type HttpAppOptions } from "../create-http-app.js";
import {
  fromBody,
  fromFixed,
  fromParam,
  fromQuery,
  publicAccess,
  requireSession,
} from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { listRoute } from "../route/list-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import type { SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

/**
 * Access enforcement parity with the old AuthorizationGuard (same pure
 * evaluateRouteAccess): denied permission checks are 404 — existence is
 * never leaked — anonymous is 401, misconfigured routes fail closed. Plus
 * the platform defaults: request-id correlation, body limits, the handler
 * deadline, and CORS.
 *
 * Node's requestTimeout/connectionTimeout guard against slow CLIENTS and
 * need real sockets — they are exercised by the load proof (Task 24b), not
 * inject().
 */

const orgSchema = z.object({ id: z.string() });

function subjectsFromHeader(): SubjectResolver {
  return {
    resolve: (request) => {
      const id = request.headers["x-test-user"];
      return Promise.resolve(
        typeof id === "string" && id.length > 0 ? { type: "user", id } : null,
      );
    },
  };
}

const routes = routeGroup("Organizations", [
  getRoute({
    route: { method: "GET", template: "/orgs/:id" },
    summary: "Get an organization",
    access: requires(
      permissionToken("organizations/organization", "view"),
      fromParam("id"),
    ),
    params: z.object({ id: z.string() }),
    response: orgSchema,
    handler: ({ params }) => ({ id: params.id }),
  }),
  getRoute({
    route: { method: "GET", template: "/whoami" },
    summary: "Echo the subject",
    access: requireSession(),
    response: z.object({ subjectId: z.string() }),
    handler: ({ subject }) => ({ subjectId: subject.id }),
  }),
  getRoute({
    route: { method: "GET", template: "/open" },
    summary: "Public echo",
    access: publicAccess(),
    response: z.object({ anonymous: z.boolean() }),
    handler: ({ subject }) => ({ anonymous: subject === null }),
  }),
  getRoute({
    route: { method: "GET", template: "/misconfigured" },
    summary: "fromParam names a param the path does not have",
    access: requires(
      permissionToken("organizations/organization", "view"),
      fromParam("id"),
    ),
    response: orgSchema,
    handler: () => ({ id: "unreachable" }),
  }),
]);

let apps: { close: () => Promise<void> }[] = [];

async function buildApp(
  appOptions?: Partial<HttpAppOptions>,
  registerOptions?: { handlerTimeoutMs?: number; extraRoutes?: typeof routes },
) {
  const authorization = new FakeAuthorization({
    "organizations/organization": { view: ["admin"] },
  });
  authorization.seed({
    resource: { type: "organizations/organization", id: "o1" },
    relation: "admin",
    subject: { type: "user", id: "u1" },
  });
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: ["https://app.example.test"],
    logger: false,
    ...appOptions,
  });
  registerRoutes(app, {
    routes: [...routes, ...(registerOptions?.extraRoutes ?? [])],
    subjects: subjectsFromHeader(),
    authorization,
    ...(registerOptions?.handlerTimeoutMs === undefined
      ? {}
      : { handlerTimeoutMs: registerOptions.handlerTimeoutMs }),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("access enforcement", () => {
  it("allows a subject holding the permission", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orgs/o1",
      headers: { "x-test-user": "u1" },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ data: { id: "o1" } });
  });

  it("answers 404 — not 403 — when the check fails (no existence leak)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orgs/o1",
      headers: { "x-test-user": "intruder" },
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res)).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource not found" },
    });
    // Marked as the edge's refusal, outside the body, so a client can tell it
    // from a record that is not there.
    expect(res.headers[ACCESS_REFUSAL_HEADER]).toBe(ACCESS_REFUSAL_VALUE);
  });

  it("answers 401 for anonymous callers on permission routes", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/orgs/o1" });
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res)).toEqual({
      error: { code: "NOT_AUTHENTICATED", message: "Authentication required" },
    });
  });

  it("answers 401 for anonymous callers on session routes", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/whoami" });
    expect(res.statusCode).toBe(401);
    expect(errorBodyOf(res).code).toBe("NOT_AUTHENTICATED");
  });

  it("hands session handlers their non-null subject", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { "x-test-user": "u42" },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ data: { subjectId: "u42" } });
  });

  it("serves public routes anonymously with a null subject", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/open" });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ data: { anonymous: true } });
  });

  it("fails closed (404) when fromParam names a param the path lacks", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/misconfigured",
      headers: { "x-test-user": "u1" },
    });
    expect(res.statusCode).toBe(404);
    expect(errorBodyOf(res).code).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("rate limiting (capability ladder)", () => {
  it("answers 429 with retry-after once the route budget is spent", async () => {
    const app = await buildApp(undefined, {
      extraRoutes: routeGroup(
        "Organizations",
        { rateLimit: { perMinute: 2 } },
        [
          getRoute({
            route: { method: "GET", template: "/limited" },
            summary: "Tight budget",
            access: publicAccess(),
            response: z.object({ ok: z.boolean() }),
            handler: () => ({ ok: true }),
          }),
        ],
      ),
    });
    expect(
      (await app.inject({ method: "GET", url: "/limited" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/limited" })).statusCode,
    ).toBe(200);
    const third = await app.inject({ method: "GET", url: "/limited" });
    expect(third.statusCode).toBe(429);
    expect(errorBodyOf(third).code).toBe("TOO_MANY_REQUESTS");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("platform defaults", () => {
  it("echoes an inbound x-request-id on success and error responses", async () => {
    const app = await buildApp();
    const ok = await app.inject({
      method: "GET",
      url: "/open",
      headers: { [REQUEST_ID_HEADER]: "corr-1" },
    });
    expect(ok.headers[REQUEST_ID_HEADER]).toBe("corr-1");
    const denied = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { [REQUEST_ID_HEADER]: "corr-2" },
    });
    expect(denied.headers[REQUEST_ID_HEADER]).toBe("corr-2");
  });

  it("generates a request id when none arrives", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/open" });
    expect(String(res.headers[REQUEST_ID_HEADER])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("kills oversized bodies at the edge with a 413 envelope", async () => {
    const app = await buildApp(
      { bodyLimitBytes: 64 },
      {
        extraRoutes: routeGroup("Organizations", [
          postRoute({
            route: { method: "POST", template: "/echo" },
            summary: "Echo a name",
            access: publicAccess(),
            body: z.object({ filler: z.string() }),
            response: z.object({ length: z.number() }),
            handler: ({ body }) => ({ length: body.filler.length }),
          }),
        ]),
      },
    );
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { filler: "x".repeat(500) },
    });
    expect(res.statusCode).toBe(413);
    expect(errorBodyOf(res).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("terminates a hung handler at the deadline with a 503 and keeps serving", async () => {
    const app = await buildApp(undefined, {
      handlerTimeoutMs: 100,
      extraRoutes: routeGroup("Organizations", [
        getRoute({
          route: { method: "GET", template: "/hangs" },
          summary: "Never resolves in time",
          access: publicAccess(),
          response: z.object({ ok: z.boolean() }),
          handler: async () => {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 1_500);
              timer.unref();
            });
            return { ok: true };
          },
        }),
      ]),
    });
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/hangs" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.statusCode).toBe(503);
    expect(errorBodyOf(res).code).toBe("HANDLER_TIMEOUT");

    const followUp = await app.inject({ method: "GET", url: "/open" });
    expect(followUp.statusCode).toBe(200);
  });

  it("allows trusted origins through CORS and withholds untrusted ones", async () => {
    const app = await buildApp();
    const trusted = await app.inject({
      method: "OPTIONS",
      url: "/open",
      headers: {
        origin: "https://app.example.test",
        "access-control-request-method": "GET",
      },
    });
    expect(trusted.headers["access-control-allow-origin"]).toBe(
      "https://app.example.test",
    );
    const untrusted = await app.inject({
      method: "OPTIONS",
      url: "/open",
      headers: {
        origin: "https://evil.example.test",
        "access-control-request-method": "GET",
      },
    });
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("the finished access vocabulary — fromBody, requireVisibility, onDenied", () => {
  const denials: unknown[] = [];

  const vocabularyRoutes = routeGroup("Tickets", [
    postRoute({
      route: { method: "POST", template: "/tickets" },
      summary: "Create into the organization named by the body",
      access: requires(
        permissionToken("organizations/organization", "manage"),
        fromBody("organizationId"),
      ),
      body: z.object({ organizationId: z.string(), name: z.string() }),
      response: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    }),
    listRoute({
      route: { method: "GET", template: "/tickets" },
      summary: "List visible tickets",
      access: requiresVisible(permissionToken("ticketing/ticket", "view")),
      query: paginationQuerySchema,
      item: z.object({ id: z.string() }),
      handler: ({ visibleIds }) => ({
        items: visibleIds.map((id) => ({ id })),
        total: visibleIds.length,
      }),
    }),
  ]);

  const vocabularyUser = entityHandle({
    wireName: "user",
    idSchema: z.string(),
  });
  const vocabularyTicket = access(
    entityHandle({
      wireName: "ticketing/ticket",
      idSchema: z.string(),
      kind: "catalog",
    }),
    {
      roles: { owner: vocabularyUser },
      permissions: (roles) => ({ view: [roles.owner] }),
    },
  );

  async function buildVocabularyApp() {
    denials.length = 0;
    const authorization = new FakeAuthorization({
      "organizations/organization": { manage: ["admin"] },
      "ticketing/ticket": { view: ["owner"] },
    });
    authorization.seed(
      {
        resource: { type: "organizations/organization", id: "o1" },
        relation: "admin",
        subject: { type: "user", id: "u1" },
      },
      {
        resource: { type: "ticketing/ticket", id: "t1" },
        relation: "owner",
        subject: { type: "user", id: "u1" },
      },
    );
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    registerRoutes(app, {
      routes: vocabularyRoutes,
      accessModel: accessModel([vocabularyTicket]),
      subjects: subjectsFromHeader(),
      authorization,
      lookups: authorization,
      onDenied: (denial) => {
        denials.push(denial);
      },
    });
    await app.ready();
    apps.push(app);
    return app;
  }

  it("fromBody: the session subject asks about the body-named resource", async () => {
    const app = await buildVocabularyApp();
    const allowed = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: { "x-test-user": "u1" },
      payload: { organizationId: "o1", name: "n" },
    });
    expect(allowed.statusCode).toBe(201);
    expect(denials).toEqual([]);

    // No relationship path → bare 404; the denial breadcrumb fires.
    const denied = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: { "x-test-user": "stranger" },
      payload: { organizationId: "o1", name: "n" },
    });
    expect(denied.statusCode).toBe(404);
    expect(errorBodyOf(denied).code).toBe("RESOURCE_NOT_FOUND");
    expect(denials).toEqual([
      {
        subjectType: "user",
        subjectId: "stranger",
        permission: "manage",
        resourceType: "organizations/organization",
        resourceId: "o1",
        url: "/tickets",
      },
    ]);
  });

  it("fromBody fails closed on a missing or non-string body field", async () => {
    const app = await buildVocabularyApp();
    const missing = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: { "x-test-user": "u1" },
      payload: { name: "no org named" },
    });
    expect(missing.statusCode).toBe(404);

    const nonString = await app.inject({
      method: "POST",
      url: "/tickets",
      headers: { "x-test-user": "u1" },
      payload: { organizationId: 42, name: "n" },
    });
    expect(nonString.statusCode).toBe(404);
  });

  it("fromQuery: the session subject asks about the query-named resource", async () => {
    const authorization = new FakeAuthorization({
      "organizations/facility": { manage: ["admin"] },
    });
    authorization.seed({
      resource: { type: "organizations/facility", id: "f1" },
      relation: "admin",
      subject: { type: "user", id: "u1" },
    });
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    registerRoutes(app, {
      routes: routeGroup("Composition", [
        postRoute({
          route: {
            method: "POST",
            template: "/document-workflows/commands",
          },
          summary: "Apply a command under the facility named by the query",
          access: requires(
            permissionToken("organizations/facility", "manage"),
            fromQuery("facilityId"),
          ),
          query: z.object({ facilityId: z.string() }),
          body: z.object({ kind: z.string() }),
          response: z.object({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ]),
      subjects: subjectsFromHeader(),
      authorization,
    });
    await app.ready();
    apps.push(app);

    const allowed = await app.inject({
      method: "POST",
      url: "/document-workflows/commands?facilityId=f1",
      headers: { "x-test-user": "u1" },
      payload: { kind: "createScreen" },
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: "/document-workflows/commands?facilityId=f1",
      headers: { "x-test-user": "stranger" },
      payload: { kind: "createScreen" },
    });
    expect(denied.statusCode).toBe(404);

    const missing = await app.inject({
      method: "POST",
      url: "/document-workflows/commands",
      headers: { "x-test-user": "u1" },
      payload: { kind: "createScreen" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("requireVisibility: 401 anonymous; empty set is an empty page, handler untouched", async () => {
    const app = await buildVocabularyApp();
    const anonymous = await app.inject({ method: "GET", url: "/tickets" });
    expect(anonymous.statusCode).toBe(401);

    // A subject with no relationships sees an empty page — never a 404,
    // never a widened query, and no denial breadcrumb (it IS an allow).
    const empty = await app.inject({
      method: "GET",
      url: "/tickets",
      headers: { "x-test-user": "stranger" },
    });
    expect(empty.statusCode).toBe(200);
    expect(bodyOf(empty)).toEqual({
      data: [],
      meta: { total: 0, page: 1, perPage: 25 },
    });
    expect(denials).toEqual([]);
  });

  it("requireVisibility hands the handler the subject's visible set", async () => {
    const app = await buildVocabularyApp();
    const listed = await app.inject({
      method: "GET",
      url: "/tickets",
      headers: { "x-test-user": "u1" },
    });
    expect(listed.statusCode).toBe(200);
    expect(bodyOf(listed)).toEqual({
      data: [{ id: "t1" }],
      meta: { total: 1, page: 1, perPage: 25 },
    });
  });

  it("a visibility route without a lookups port is a loud 500, not a quiet allow", async () => {
    const authorization = new FakeAuthorization({});
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    registerRoutes(app, {
      routes: vocabularyRoutes,
      accessModel: accessModel([vocabularyTicket]),
      subjects: subjectsFromHeader(),
      authorization,
      // no lookups port — wired wrong on purpose
    });
    await app.ready();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/tickets",
      headers: { "x-test-user": "u1" },
    });
    expect(response.statusCode).toBe(500);
  });

  it("fromFixed checks the singleton resource id (platform:command)", async () => {
    const authorization = new FakeAuthorization({
      platform: { execute_live_environment_actions: ["super_admin"] },
    });
    authorization.seed({
      resource: { type: "platform", id: "command" },
      relation: "super_admin",
      subject: { type: "user", id: "opal" },
    });
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    registerRoutes(app, {
      routes: routeGroup("Platform", [
        postRoute({
          route: { method: "POST", template: "/platform-echo" },
          summary: "Fixed-id platform gate",
          access: requires(
            permissionToken("platform", "execute_live_environment_actions"),
            fromFixed("command"),
          ),
          body: z.object({}),
          response: z.object({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ]),
      subjects: subjectsFromHeader(),
      authorization,
    });
    await app.ready();
    apps.push(app);

    const allowed = await app.inject({
      method: "POST",
      url: "/platform-echo",
      headers: { "x-test-user": "opal" },
      payload: {},
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await app.inject({
      method: "POST",
      url: "/platform-echo",
      headers: { "x-test-user": "stranger" },
      payload: {},
    });
    expect(denied.statusCode).toBe(404);
  });
});
