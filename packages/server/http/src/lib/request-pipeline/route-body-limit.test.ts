// Proves upload routes can declare a bounded payload size without widening neighboring routes.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpApp } from "../create-http-app.js";
import { publicAccess } from "../route/access.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

describe("route-specific request body limits", () => {
  it("accepts the declared upload size and preserves both upper bounds", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
      bodyLimitBytes: 64,
    });
    const body = z.object({ value: z.string() });
    registerRoutes(app, {
      subjects: { resolve: () => Promise.resolve(null) },
      authorization: { check: () => Promise.resolve(false) },
      routes: routeGroup("Uploads", [
        postRoute({
          path: "/upload",
          summary: "Bounded upload",
          access: publicAccess(),
          bodyLimitBytes: 256,
          body,
          response: body,
          handler: ({ body }) => body,
        }),
        postRoute({
          path: "/ordinary",
          summary: "Ordinary mutation",
          access: publicAccess(),
          body,
          response: body,
          handler: ({ body }) => body,
        }),
      ]),
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/upload",
            payload: { value: "x".repeat(100) },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/ordinary",
            payload: { value: "x".repeat(100) },
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/upload",
            payload: { value: "x".repeat(300) },
          })
        ).statusCode,
      ).toBe(413);
    } finally {
      await app.close();
    }
  });
});
