/**
 * What: an app agrees to receive raw bytes only for the body types it names
 * (`byteBodyContentTypes`), and a raw route can raise its own body limit
 * (`bodyLimitBytes`); without either, nothing changes.
 * Why: the site's file route stores a part's bytes exactly as sent.
 * The cloud app names no byte type, so `application/octet-stream` to any of
 * its routes still answers 415, and its 1 MiB default limit holds.
 */
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { createHttpApp } from "../create-http-app.js";
import { publicAccess } from "../route/access.js";
import { defineRawRoute } from "../route/define-raw-route.js";
import { routeGroup } from "../route/route-group.js";
import { contentTypeSentWithBytes } from "./raw-route-byte-body.js";
import { registerRoutes } from "./register-routes.js";

const OCTET_STREAM = "application/octet-stream";

/** Answers how many bytes it received, and whether they arrived as a Buffer. */
function byteRoutes(bodyLimitBytes?: number) {
  return routeGroup("Bytes", [
    defineRawRoute({
      method: "PUT",
      path: "/bytes",
      summary: "Receive raw bytes",
      access: publicAccess(),
      ...(bodyLimitBytes === undefined ? {} : { bodyLimitBytes }),
      openapi: { responses: { "200": { description: "Byte count" } } },
      handler: async ({ request, reply }) => {
        const body: unknown = request.body;
        await reply.status(200).send({
          isBuffer: Buffer.isBuffer(body),
          bytes: Buffer.isBuffer(body) ? body.byteLength : null,
        });
      },
    }),
  ]);
}

async function appWith(options: {
  readonly byteBodyContentTypes?: readonly string[];
  readonly bodyLimitBytes?: number;
}) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    ...(options.byteBodyContentTypes === undefined
      ? {}
      : { byteBodyContentTypes: options.byteBodyContentTypes }),
  });
  registerRoutes(app, {
    subjects: { resolve: () => Promise.resolve(null) },
    authorization: { check: () => Promise.resolve(false) },
    routes: byteRoutes(options.bodyLimitBytes),
  });
  return app;
}

function put(byteCount: number): {
  readonly method: "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: Buffer;
} {
  return {
    method: "PUT",
    url: "/bytes",
    headers: { "content-type": OCTET_STREAM },
    payload: Buffer.alloc(byteCount, 1),
  };
}

describe("raw bytes and a raw route's own body limit", () => {
  it("answers 415 for octet-stream when the app names no byte body type, as the cloud app does", async () => {
    const app = await appWith({});
    try {
      expect((await app.inject(put(10))).statusCode).toBe(415);
    } finally {
      await app.close();
    }
  });

  it("keeps the app's 1 MiB default limit for a raw route that declares none", async () => {
    const app = await appWith({ byteBodyContentTypes: [OCTET_STREAM] });
    try {
      expect((await app.inject(put(1_048_576))).statusCode).toBe(200);
      expect((await app.inject(put(1_048_577))).statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("hands an opted-in body to the route as the exact bytes, under the route's own limit", async () => {
    const limit = 2 * 1_048_576;
    const app = await appWith({
      byteBodyContentTypes: [OCTET_STREAM],
      bodyLimitBytes: limit,
    });
    try {
      const received = await app.inject(put(limit));
      expect(received.statusCode).toBe(200);
      expect(received.json()).toEqual({ isBuffer: true, bytes: limit });
      expect((await app.inject(put(limit + 1))).statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});

/** One route that reads every body as bytes, and one that does not, side by side. */
async function appWithByteBodyRoute() {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    byteBodyContentTypes: [OCTET_STREAM],
  });
  const answer = (request: FastifyRequest) => {
    const body: unknown = request.body;
    return {
      isBuffer: Buffer.isBuffer(body),
      text: Buffer.isBuffer(body) ? body.toString("utf8") : null,
      sentType: contentTypeSentWithBytes(request) ?? null,
    };
  };
  const route = (path: string, bodyAsBytes: boolean) =>
    defineRawRoute({
      method: "PUT",
      path,
      summary: "Receive a body",
      access: publicAccess(),
      ...(bodyAsBytes ? { bodyAsBytes } : {}),
      openapi: { responses: { "200": { description: "What arrived" } } },
      handler: async ({ request, reply }) => {
        await reply.status(200).send(answer(request));
      },
    });
  registerRoutes(app, {
    subjects: { resolve: () => Promise.resolve(null) },
    authorization: { check: () => Promise.resolve(false) },
    routes: routeGroup("Bodies", [
      route("/as-bytes", true),
      route("/as-sent", false),
    ]),
  });
  return app;
}

describe("a raw route that reads its body as bytes whatever the type", () => {
  it.each([
    ["application/json", '{ "a": 1 }'],
    ["text/plain", "plain text"],
    ["image/jpeg", "jpeg bytes"],
    ["text/csv", "a,b"],
  ])(
    "hands a %s body over as the exact bytes and keeps the sent type",
    async (type, text) => {
      const app = await appWithByteBodyRoute();
      try {
        const response = await app.inject({
          method: "PUT",
          url: "/as-bytes",
          headers: { "content-type": type },
          payload: text,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          isBuffer: true,
          text,
          sentType: type,
        });
      } finally {
        await app.close();
      }
    },
  );

  it("hands over a body with no type as bytes, with no sent type", async () => {
    const app = await appWithByteBodyRoute();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/as-bytes",
        payload: Buffer.from("untyped"),
      });
      expect(response.json()).toEqual({
        isBuffer: true,
        text: "untyped",
        sentType: null,
      });
    } finally {
      await app.close();
    }
  });

  it("leaves every other route's JSON parsing alone", async () => {
    const app = await appWithByteBodyRoute();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/as-sent",
        headers: { "content-type": "application/json" },
        payload: '{"a":1}',
      });
      expect(response.json()).toEqual({
        isBuffer: false,
        text: null,
        sentType: "application/json",
      });
    } finally {
      await app.close();
    }
  });
});
