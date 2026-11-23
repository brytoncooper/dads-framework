import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import { requires } from "../route/route-guards.test-support.js";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { apiResponseSchema } from "@dads-framework/core/contract";

import { errorBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { buildOpenApiDocument } from "../openapi/build-document.js";
import { fromParam, publicAccess } from "../route/access.js";
import { defineRawRoute } from "../route/define-raw-route.js";
import { routeGroup } from "../route/route-group.js";
import type { SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

/**
 * The escape hatch, proven working (plan Task 7): SSE and streamed
 * downloads through defineRawRoute, with the SAME access enforcement and
 * error envelope as typed routes. Multipart is documented as "add
 * @fastify/multipart inside the kit when the first consumer arrives" — a
 * stop-and-ask, not a pre-installed dependency.
 */

const subjects: SubjectResolver = {
  resolve: (request) => {
    const id = request.headers["x-test-user"];
    return Promise.resolve(
      typeof id === "string" && id.length > 0 ? { type: "user", id } : null,
    );
  },
};

const sseRoute = defineRawRoute({
  method: "GET",
  path: "/events",
  summary: "Server-sent events",
  access: publicAccess(),
  openapi: {
    responses: {
      "200": { description: "text/event-stream of workflow events" },
    },
  },
  handler: ({ reply }) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const n of [1, 2, 3]) {
      reply.raw.write(`data: event-${n}\n\n`);
    }
    reply.raw.end();
    return Promise.resolve();
  },
});

const downloadRoute = defineRawRoute({
  method: "GET",
  path: "/exports/:id",
  summary: "Streamed export download",
  access: requires(permissionToken("things/thing", "view"), fromParam("id")),
  openapi: {
    responses: { "200": { description: "CSV stream" } },
  },
  handler: async ({ reply }) => {
    const stream = Readable.from(["row-1\n", "row-2\n", "row-3\n"]);
    await reply
      .header("content-type", "text/csv")
      .header("content-disposition", "attachment")
      .header("vary", "X-Export-Format")
      .send(stream);
  },
});

const explodingRoute = defineRawRoute({
  method: "GET",
  path: "/explodes-early",
  summary: "Throws before streaming",
  access: publicAccess(),
  openapi: { responses: { "500": { description: "never documented" } } },
  handler: () => {
    throw new Error("secret pre-stream failure");
  },
});

/** A raw route that answers JSON refs a component nothing else registers. */
const mintedTokenRoute = defineRawRoute({
  method: "POST",
  path: "/minted-tokens",
  summary: "Hand-enveloped JSON from a raw route",
  access: publicAccess(),
  openapi: {
    responses: {
      "200": {
        description: "Minted token",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PostMintedTokensResponse" },
          },
        },
      },
    },
  },
  openapiComponents: {
    PostMintedTokensResponse: apiResponseSchema(
      z.object({ token: z.string().meta({ description: "Minted token" }) }),
    ),
  },
  handler: async ({ reply }) => {
    await reply.status(200).send({ data: { token: "minted" } });
  },
});

const wildcardVaryRoute = defineRawRoute({
  method: "GET",
  path: "/wildcard-vary",
  summary: "Response already varies by every request field",
  access: publicAccess(),
  openapi: { responses: { "200": { description: "wildcard response" } } },
  handler: async ({ reply }) => {
    await reply.header("vary", "*").send("ok");
  },
});

let apps: { close: () => Promise<void> }[] = [];

async function buildApp() {
  const authorization = new FakeAuthorization({
    "things/thing": { view: ["owner"] },
  });
  authorization.seed({
    resource: { type: "things/thing", id: "t1" },
    relation: "owner",
    subject: { type: "user", id: "u1" },
  });
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Streams", [
      sseRoute,
      downloadRoute,
      explodingRoute,
      wildcardVaryRoute,
    ]),
    subjects,
    authorization,
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("defineRawRoute", () => {
  it("streams server-sent events end to end", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers.vary?.toLowerCase()).toContain("accept-language");
    expect(res.body).toBe(
      "data: event-1\n\ndata: event-2\n\ndata: event-3\n\n",
    );
  });

  it("streams a download with backpressure-safe send(stream)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/exports/t1",
      headers: {
        origin: "https://app.example",
        "x-test-user": "u1",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const varyFields = (res.headers.vary ?? "")
      .split(",")
      .map((field) => field.trim().toLowerCase());
    expect(varyFields).toContain("origin");
    expect(varyFields).toContain("x-export-format");
    expect(varyFields).toContain("accept-language");
    expect(
      varyFields.filter((field) => field === "accept-language"),
    ).toHaveLength(1);
    expect(res.body).toBe("row-1\nrow-2\nrow-3\n");
  });

  it("enforces permission checks identically — denied is a 404 envelope", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/exports/t1",
      headers: { "x-test-user": "intruder" },
    });
    expect(res.statusCode).toBe(404);
    expect(errorBodyOf(res).code).toBe("RESOURCE_NOT_FOUND");
    expect(res.headers.vary?.toLowerCase()).toContain("accept-language");
  });

  it("keeps a wildcard Vary header as the complete cache contract", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/wildcard-vary" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.vary).toBe("*");
  });

  it("rejects anonymous callers on guarded raw routes with 401", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/exports/t1" });
    expect(res.statusCode).toBe(401);
    expect(errorBodyOf(res).code).toBe("NOT_AUTHENTICATED");
  });

  it("routes pre-stream throws through the masked error envelope", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/explodes-early" });
    expect(res.statusCode).toBe(500);
    expect(errorBodyOf(res).code).toBe("INTERNAL_ERROR");
    expect(res.body).not.toContain("secret pre-stream failure");
  });

  it("appears in the OpenAPI document marked x-raw-route", () => {
    const doc = buildOpenApiDocument(routeGroup("Streams", [sseRoute]), {
      title: "t",
      description: "d",
      version: "1",
      tags: [{ name: "Streams", description: "streams" }],
      pathPrefix: "/api",
    });
    const parsed = z
      .object({
        paths: z.object({
          "/api/events": z.object({
            get: z.looseObject({
              "x-raw-route": z.literal(true),
              operationId: z.string(),
              summary: z.string(),
            }),
          }),
        }),
      })
      .parse(doc);
    expect(parsed.paths["/api/events"].get["x-raw-route"]).toBe(true);
  });

  it("registers a raw route's declared components so its $ref resolves", () => {
    const doc = buildOpenApiDocument(
      routeGroup("Streams", [mintedTokenRoute]),
      {
        title: "t",
        description: "d",
        version: "1",
        tags: [{ name: "Streams", description: "streams" }],
        pathPrefix: "/api",
      },
    );
    const parsed = z
      .object({
        components: z.object({
          schemas: z.record(z.string(), z.looseObject({})),
        }),
      })
      .parse(doc);
    expect(parsed.components.schemas["PostMintedTokensResponse"]).toBeDefined();
  });
});
