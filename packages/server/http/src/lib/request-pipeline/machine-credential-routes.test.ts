import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";

import { bodyOf, errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { HttpWiringError } from "../http-errors.js";
import { publicAccess, requireSession } from "../route/access.js";
import { defineRawRoute } from "../route/define-raw-route.js";
import { getRoute } from "../route/get-route.js";
import { type HttpRoute, routeGroup } from "../route/route-group.js";
import type { PermissionChecker, SubjectResolver } from "./enforce-access.js";
import { registerRoutes, type RegisterRoutesOptions } from "./register-routes.js";

/**
 * The `machineCredential` capability: a route that names one resolves its
 * caller only through that named resolver, and every other route never
 * consults machine resolvers.
 */

const sessionUser: SubjectRef = { type: "user", id: "u1" };
const connection: SubjectRef = { type: "integrations/connection", id: "c1" };

const sessionCookieResolver: SubjectResolver = {
  resolve: (request) => Promise.resolve(request.headers["cookie"] === "session=valid" ? sessionUser : null),
};

type CountingResolver = SubjectResolver & { readonly calls: () => number };

function machineResolver(): CountingResolver {
  let calls = 0;
  return {
    resolve: (request) => {
      calls += 1;
      return Promise.resolve(request.headers["authorization"] === "Bearer machine-secret" ? connection : null);
    },
    calls: () => calls,
  };
}

const neverChecks: PermissionChecker = {
  check: () => Promise.resolve(false),
};

const callerSchema = z.object({ type: z.string(), id: z.string() });

const machineRoute = getRoute({
  route: { method: "GET", template: "/inbound" },
  summary: "Machine-only caller",
  access: requireSession(),
  capabilities: { machineCredential: "integration-connection" },
  response: callerSchema,
  handler: ({ subject }) => ({ type: subject.type, id: subject.id }),
});

const sessionRoute = getRoute({
  route: { method: "GET", template: "/me" },
  summary: "Session caller",
  access: requireSession(),
  response: callerSchema,
  handler: ({ subject }) => ({ type: subject.type, id: subject.id }),
});

const rawMachineRoute = defineRawRoute({
  method: "POST",
  path: "/inbound-raw",
  summary: "Raw machine-only caller",
  access: requireSession(),
  capabilities: { machineCredential: "integration-connection" },
  openapi: { responses: { "200": { description: "caller id" } } },
  handler: async ({ reply, subject }) => {
    await reply.status(200).send(subject?.id ?? "none");
  },
});

let apps: { close: () => Promise<void> }[] = [];

async function buildApp(routes: readonly HttpRoute[], overrides: Partial<RegisterRoutesOptions> = {}) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  apps.push(app);
  registerRoutes(app, {
    routes,
    subjects: sessionCookieResolver,
    authorization: neverChecks,
    ...overrides,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("machineCredential capability", () => {
  it("resolves the caller only through the named machine resolver", async () => {
    const machine = machineResolver();
    const app = await buildApp(routeGroup("Inbound", [machineRoute]), {
      machineCredentials: { "integration-connection": machine },
    });

    const res = await app.inject({
      method: "GET",
      url: "/inbound",
      headers: { authorization: "Bearer machine-secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      data: { type: "integrations/connection", id: "c1" },
    });
  });

  it("ignores a valid session cookie: 401 when the machine resolver answers null", async () => {
    const machine = machineResolver();
    const app = await buildApp(routeGroup("Inbound", [machineRoute]), {
      machineCredentials: { "integration-connection": machine },
    });

    const res = await app.inject({
      method: "GET",
      url: "/inbound",
      headers: { cookie: "session=valid" },
    });

    expect(res.statusCode).toBe(401);
    expect(errorBodyOf(res).code).toBe("NOT_AUTHENTICATED");
    expect(machine.calls()).toBe(1);
  });

  it("never consults the machine resolver for a plain route", async () => {
    const machine = machineResolver();
    const app = await buildApp(routeGroup("Mixed", [sessionRoute, machineRoute]), {
      machineCredentials: { "integration-connection": machine },
    });

    const withSession = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: "session=valid" },
    });
    const withMachineSecret = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer machine-secret" },
    });

    expect(withSession.statusCode).toBe(200);
    expect(bodyOf(withSession)).toEqual({ data: { type: "user", id: "u1" } });
    expect(withMachineSecret.statusCode).toBe(401);
    expect(machine.calls()).toBe(0);
  });

  it("applies when declared on the group", async () => {
    const machine = machineResolver();
    const app = await buildApp(routeGroup("Inbound", { machineCredential: "integration-connection" }, [sessionRoute]), {
      machineCredentials: { "integration-connection": machine },
    });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: "session=valid" },
    });

    expect(res.statusCode).toBe(401);
    expect(machine.calls()).toBe(1);
  });

  it("works on a raw route", async () => {
    const machine = machineResolver();
    const app = await buildApp(routeGroup("Inbound", [rawMachineRoute]), {
      machineCredentials: { "integration-connection": machine },
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/inbound-raw",
      headers: { authorization: "Bearer machine-secret" },
    });
    const sessionOnly = await app.inject({
      method: "POST",
      url: "/inbound-raw",
      headers: { cookie: "session=valid" },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe("c1");
    expect(sessionOnly.statusCode).toBe(401);
  });

  it("throws at registration when the named resolver is missing", async () => {
    await expect(
      buildApp(routeGroup("Inbound", [machineRoute]), {
        machineCredentials: { other: machineResolver() },
      }),
    ).rejects.toThrow(HttpWiringError);
  });

  it("throws at registration on a public route", async () => {
    const publicMachineRoute = getRoute({
      route: { method: "GET", template: "/open" },
      summary: "Public machine route",
      access: publicAccess(),
      capabilities: { machineCredential: "integration-connection" },
      response: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    await expect(
      buildApp(routeGroup("Inbound", [publicMachineRoute]), {
        machineCredentials: { "integration-connection": machineResolver() },
      }),
    ).rejects.toThrow(/public route/);
  });

  it("throws at registration when the app rung supplies it", async () => {
    await expect(
      buildApp(routeGroup("Plain", [sessionRoute]), {
        capabilities: { machineCredential: "integration-connection" },
        machineCredentials: { "integration-connection": machineResolver() },
      }),
    ).rejects.toThrow(HttpWiringError);
  });
});

describe("site capability at the app rung", () => {
  it("throws at registration when the app rung supplies a site label", async () => {
    await expect(
      buildApp(routeGroup("Plain", [sessionRoute]), {
        capabilities: { site: "served" },
      }),
    ).rejects.toThrow(
      "registerRoutes capabilities.site is not allowed — a route's site label is declared by the route or its group, never app-wide",
    );
  });

  it("throws at registration when the app rung supplies a cloud-only reason", async () => {
    await expect(
      buildApp(routeGroup("Plain", [sessionRoute]), {
        capabilities: {
          cloudOnly: { reason: "STAFF_TOOLS", why: "Staff only." },
        },
      }),
    ).rejects.toThrow(
      "registerRoutes capabilities.cloudOnly is not allowed — a cloud-only reason is declared with its site label, by the route or its group, never app-wide",
    );
  });

  it("registers a route whose group declares a site label", async () => {
    const app = await buildApp(routeGroup("Plain", { site: "served" }, [sessionRoute]));
    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: "session=valid" },
    });
    expect(response.statusCode).toBe(200);
  });
});
