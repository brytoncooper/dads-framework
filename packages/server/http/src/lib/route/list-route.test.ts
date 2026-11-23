/**
 * What: a list route may declare its own meta schema, extending the
 * pagination meta, and its handler returns the extra fields.
 * Why: a list such as the staff Sites list carries counts the page needs in
 * the same answer (one request per refresh); the kit must still own the page
 * window and total, and must refuse extra meta that drifts from the schema.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeAuthorization } from "@dads-framework/access/testing";
import {
  paginationMetaSchema,
  paginationQuerySchema,
} from "@dads-framework/core/contract";

import { bodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { registerRoutes } from "../request-pipeline/register-routes.js";
import { publicAccess } from "./access.js";
import { listRoute } from "./list-route.js";
import type { RouteBlueprint } from "./route-definition.js";
import { routeGroup } from "./route-group.js";

const countedMetaSchema = paginationMetaSchema.extend({
  counts: z.object({ red: z.int().min(0) }),
});

let apps: Awaited<ReturnType<typeof createHttpApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function appWith(route: RouteBlueprint) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Things", [route]),
    subjects: { resolve: () => Promise.resolve(null) },
    authorization: new FakeAuthorization({}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe("listRoute meta", () => {
  it("sends the handler's extra meta beside the page window and total", async () => {
    const app = await appWith(
      listRoute({
        route: { method: "GET", template: "/things" },
        summary: "List things with counts",
        access: publicAccess(),
        query: paginationQuerySchema,
        item: z.object({ id: z.string() }),
        meta: countedMetaSchema,
        handler: () => ({
          items: [{ id: "a" }],
          total: 7,
          meta: { counts: { red: 3 } },
        }),
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/things?page=2&perPage=1",
    });

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({
      data: [{ id: "a" }],
      meta: { counts: { red: 3 }, total: 7, page: 2, perPage: 1 },
    });
  });

  it("refuses extra meta that does not match the declared schema", async () => {
    const app = await appWith(
      listRoute({
        route: { method: "GET", template: "/things" },
        summary: "List things with counts",
        access: publicAccess(),
        query: paginationQuerySchema,
        item: z.object({ id: z.string() }),
        meta: countedMetaSchema,
        handler: () => ({
          items: [],
          total: 0,
          meta: { counts: { red: -1 } },
        }),
      }),
    );

    const response = await app.inject({ method: "GET", url: "/things" });

    expect(response.statusCode).toBe(500);
  });
});
