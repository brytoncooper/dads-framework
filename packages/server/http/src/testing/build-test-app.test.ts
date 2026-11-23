/**
 * What: the HTTP test harness mounts typed routes with production-like access.
 * Why: route tests must exercise the same registration and defaults as the API.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import { requires } from "../lib/route/route-guards.test-support.js";
import { FakeAuthorization } from "@dads-framework/access/testing";

import { fromParam, requireSession } from "../lib/route/access.js";
import { getRoute } from "../lib/route/get-route.js";
import { routeGroup } from "../lib/route/route-group.js";
import { buildTestApp, TEST_SUBJECT_HEADER, type TestApp } from "./build-test-app.js";
import { dataBodyOf, errorBodyOf } from "./parse-inject-response.js";

const echoSchema = z.object({ subjectId: z.string() });

const routes = routeGroup("Test", [
  getRoute({
    route: { method: "GET", template: "/whoami" },
    summary: "Echo the subject",
    access: requireSession(),
    response: echoSchema,
    handler: ({ subject }) => ({ subjectId: subject.id }),
  }),
  getRoute({
    route: { method: "GET", template: "/guarded/:id" },
    summary: "Permission-guarded",
    access: requires(permissionToken("things/thing", "view"), fromParam("id")),
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string() }),
    handler: ({ params }) => ({ id: params.id }),
  }),
]);

let apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("TEST_SUBJECT_HEADER", () => {
  it("names the harness's own fixture header, not any product's", () => {
    expect(TEST_SUBJECT_HEADER).toBe("x-test-subject");
  });
});

describe("buildTestApp", () => {
  it("exposes inject and close — and provably no listen", () => {
    expectTypeOf<keyof TestApp>().toEqualTypeOf<"inject" | "close">();
  });

  it("resolves the subject from the x-test-subject header by default", async () => {
    const app = await buildTestApp({ routes });
    apps.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/whoami",
      headers: { [TEST_SUBJECT_HEADER]: "u7" },
    });
    expect(dataBodyOf(res, echoSchema)).toEqual({ subjectId: "u7" });
  });

  it("is anonymous without the header", async () => {
    const app = await buildTestApp({ routes });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/whoami" });
    expect(res.statusCode).toBe(401);
  });

  it("hands the handler when the caller last signed in again, as the subject resolver read it, and nothing when it read none", async () => {
    const reauthenticatedAt = new Date("2026-11-16T09:00:00.000Z");
    const signedInAgainRoutes = routeGroup("Test", [
      getRoute({
        route: { method: "GET", template: "/signed-in-again-at" },
        summary: "Echo when the caller last signed in again",
        access: requireSession(),
        response: z.object({ reauthenticatedAt: z.string().nullable() }),
        handler: ({ sessionReauthenticatedAt }) => ({
          reauthenticatedAt: sessionReauthenticatedAt?.toISOString() ?? null,
        }),
      }),
    ]);
    const app = await buildTestApp({
      routes: signedInAgainRoutes,
      subjects: {
        resolve: () => Promise.resolve({ type: "user", id: "u1" }),
        resolveWithMethod: (request) =>
          Promise.resolve({
            subject: { type: "user", id: "u1" },
            method: "session-cookie",
            ...(request.headers["x-reauthenticated"] === "yes" ? { sessionReauthenticatedAt: reauthenticatedAt } : {}),
          }),
      },
    });
    apps.push(app);

    const said = await app.inject({
      method: "GET",
      url: "/signed-in-again-at",
      headers: { "x-reauthenticated": "yes" },
    });
    const unsaid = await app.inject({
      method: "GET",
      url: "/signed-in-again-at",
    });

    const reauthenticatedAtSchema = z.object({
      reauthenticatedAt: z.string().nullable(),
    });
    expect(dataBodyOf(said, reauthenticatedAtSchema)).toEqual({
      reauthenticatedAt: reauthenticatedAt.toISOString(),
    });
    expect(dataBodyOf(unsaid, reauthenticatedAtSchema)).toEqual({
      reauthenticatedAt: null,
    });
  });

  it("denies all permissions by default — seeding a fake opens them", async () => {
    const denying = await buildTestApp({ routes });
    apps.push(denying);
    const denied = await denying.inject({
      method: "GET",
      url: "/guarded/t1",
      headers: { [TEST_SUBJECT_HEADER]: "u1" },
    });
    expect(denied.statusCode).toBe(404);
    expect(errorBodyOf(denied).code).toBe("RESOURCE_NOT_FOUND");

    const authorization = new FakeAuthorization({
      "things/thing": { view: ["owner"] },
    });
    authorization.seed({
      resource: { type: "things/thing", id: "t1" },
      relation: "owner",
      subject: { type: "user", id: "u1" },
    });
    const allowing = await buildTestApp({ routes, authorization });
    apps.push(allowing);
    const allowed = await allowing.inject({
      method: "GET",
      url: "/guarded/t1",
      headers: { [TEST_SUBJECT_HEADER]: "u1" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
