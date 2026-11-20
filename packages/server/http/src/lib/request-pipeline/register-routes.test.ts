import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SubjectRef } from "@dads-framework/access/runtime";
import { conflict } from "@dads-framework/errors";
import {
  ACCESS_REFUSAL_HEADER,
  REQUEST_ID_HEADER,
} from "@dads-framework/contract";

import { bodyOf, errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { publicAccess, requireSession } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import type { PermissionChecker, SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

/**
 * Kit core behavior over a real Fastify instance via inject() — no sockets.
 * Every failure path asserts the FULL envelope, not just the status code
 * (docs/architecture/api-conventions.md#errors). Permission-check paths are
 * covered in access-and-defaults.test.ts; this file uses session/public
 * routes to focus on translation, envelopes, and error mapping.
 */

const subject: SubjectRef = { type: "user", id: "u1" };

const subjects: SubjectResolver = {
  resolve: (request) =>
    Promise.resolve(request.headers["x-anon"] === "1" ? null : subject),
};

const neverChecks: PermissionChecker = {
  check: () => Promise.resolve(false),
};

const thingSchema = z.object({ id: z.string(), name: z.string() });

const routes = routeGroup("Things", [
  getRoute({
    route: { method: "GET", template: "/things/:id" },
    summary: "Get a thing",
    access: requireSession(),
    params: z.object({ id: z.string() }),
    response: thingSchema,
    handler: ({ params }) => ({ id: params.id, name: "widget" }),
  }),
  postRoute({
    route: { method: "POST", template: "/things" },
    summary: "Create a thing",
    access: requireSession(),
    body: z.object({ name: z.string().min(1) }),
    response: thingSchema,
    handler: ({ body }) => ({ id: "t-new", name: body.name }),
  }),
  postRoute({
    route: { method: "POST", template: "/things/:id/claim" },
    summary: "Always conflicts",
    access: requireSession(),
    params: z.object({ id: z.string() }),
    response: thingSchema,
    handler: () => {
      throw conflict("THING_ALREADY_CLAIMED", "Thing is already claimed");
    },
  }),
  getRoute({
    route: { method: "GET", template: "/drifting" },
    summary: "Response drifts from schema",
    access: publicAccess(),
    response: z.object({ id: z.string().min(5) }),
    handler: () => ({ id: "1" }),
  }),
  getRoute({
    route: { method: "GET", template: "/language" },
    summary: "Echoes the language this request asked for",
    access: publicAccess(),
    response: z.object({ id: z.string(), name: z.string() }),
    handler: ({ locale }) => ({ id: locale, name: "language" }),
  }),
]);

let apps: { close: () => Promise<void> }[] = [];

async function buildApp(routeOverride?: typeof routes) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeOverride ?? routes,
    subjects,
    authorization: neverChecks,
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("registerRoutes", () => {
  it("serves a GET route with the { data } envelope and 200", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/things/t1" });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ data: { id: "t1", name: "widget" } });
  });

  it("defaults POST to 201", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/things",
      payload: { name: "new thing" },
    });
    expect(res.statusCode).toBe(201);
    expect(bodyOf(res)).toEqual({ data: { id: "t-new", name: "new thing" } });
  });

  it("maps request validation failures to a 400 envelope with field issues", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/things",
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    const error = errorBodyOf(res);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({ part: "body" });
    expect(Array.isArray(error.details?.["issues"])).toBe(true);
    expect(bodyOf(res)).not.toHaveProperty("data");
  });

  it("maps thrown DomainErrors through the kind→status table", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/things/t1/claim",
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res)).toEqual({
      error: {
        code: "THING_ALREADY_CLAIMED",
        message: "Thing is already claimed",
      },
    });
  });

  it("masks response drift as a 500 with no internal details", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/drifting" });
    expect(res.statusCode).toBe(500);
    const error = errorBodyOf(res);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("An unexpected error occurred");
    expect(res.body).not.toContain("drifted");
    expect(res.body).not.toContain("schema");
  });

  it("returns the error envelope for unknown routes", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(errorBodyOf(res).code).toBe("NOT_FOUND");
    expect(res.headers[ACCESS_REFUSAL_HEADER]).toBeUndefined();
  });

  it("envelopes malformed JSON as a 400 transport error", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/things",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(errorBodyOf(res).code).toBe("VALIDATION_FAILED");
    expect(res.headers.vary?.toLowerCase()).toContain("accept-language");
  });

  it("carries the inbound x-request-id into masked 500 bodies", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/drifting",
      headers: { [REQUEST_ID_HEADER]: "trace-me-123" },
    });
    expect(res.statusCode).toBe(500);
    expect(errorBodyOf(res).requestId).toBe("trace-me-123");
  });

  it("hands the handler the language the request asked for", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/language",
      headers: {
        origin: "https://app.example",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    expect(bodyOf(res)).toEqual({ data: { id: "en", name: "language" } });
    const varyFields = (res.headers.vary ?? "")
      .split(",")
      .map((field) => field.trim().toLowerCase());
    expect(varyFields).toContain("origin");
    expect(varyFields).toContain("accept-language");
    expect(
      varyFields.filter((field) => field === "accept-language"),
    ).toHaveLength(1);
    expect(res.headers["content-language"]).toBeUndefined();
  });

  it("hands the handler English when the request named no language", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/language" });
    expect(bodyOf(res)).toEqual({ data: { id: "en", name: "language" } });
  });

  it("masks completely unknown thrown values as 500", async () => {
    const app = await buildApp(
      routeGroup("Things", [
        getRoute({
          route: { method: "GET", template: "/explodes" },
          summary: "Throws a plain error",
          access: publicAccess(),
          response: thingSchema,
          handler: () => {
            throw new Error("secret internal stack detail");
          },
        }),
      ]),
    );
    const res = await app.inject({ method: "GET", url: "/explodes" });
    expect(res.statusCode).toBe(500);
    expect(errorBodyOf(res).code).toBe("INTERNAL_ERROR");
    expect(res.body).not.toContain("secret internal stack detail");
  });

  it("never double-wraps the envelope", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/things/t1" });
    expect(bodyOf(res)).toEqual({ data: { id: "t1", name: "widget" } });
  });
});
