/**
 * What/why: after a write the next list request must carry that SpiceDB
 * consistency token, or the list answers from a snapshot that predates the
 * create. The kit owns the cookie so every route gets it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AUTHORIZATION_CONSISTENCY_COOKIE,
  authorizationConsistencyTokenOnThisRequest,
  recordWrittenAuthorizationConsistency,
} from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";

import { bodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { publicAccess } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

const echo = z.object({ token: z.string().nullable() });

const routes = routeGroup("Consistency", [
  postRoute({
    route: { method: "POST", template: "/writes" },
    summary: "Records a write token",
    access: publicAccess(),
    body: z.object({ token: z.string() }),
    response: echo,
    handler: ({ body }) => {
      recordWrittenAuthorizationConsistency(body.token);
      return { token: body.token };
    },
  }),
  getRoute({
    route: { method: "GET", template: "/reads" },
    summary: "Echoes the request watermark",
    access: publicAccess(),
    response: echo,
    handler: () => ({
      token: authorizationConsistencyTokenOnThisRequest() ?? null,
    }),
  }),
]);

const apps: { close: () => Promise<void> }[] = [];

async function buildApp() {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes,
    subjects: { resolve: () => Promise.resolve(null) },
    authorization: new FakeAuthorization({}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authorization consistency cookie", () => {
  it("sets the write token on the response so the next request can read it back", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/writes",
      payload: { token: "written-at-3" },
    });

    expect(created.statusCode).toBe(201);
    const setCookie = created.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    expect(cookie).toContain(
      `${AUTHORIZATION_CONSISTENCY_COOKIE}=written-at-3`,
    );

    const listed = await app.inject({
      method: "GET",
      url: "/reads",
      headers: { cookie: `${AUTHORIZATION_CONSISTENCY_COOKIE}=written-at-3` },
    });

    expect(listed.statusCode).toBe(200);
    expect(bodyOf(listed)).toEqual({ data: { token: "written-at-3" } });
  });

  it("a request with no write and no cookie has no watermark", async () => {
    const app = await buildApp();
    const listed = await app.inject({ method: "GET", url: "/reads" });
    expect(listed.statusCode).toBe(200);
    expect(bodyOf(listed)).toEqual({ data: { token: null } });
  });
});
