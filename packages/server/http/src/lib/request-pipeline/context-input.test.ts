/** Input-only context capture must not resolve an actor, claim business authorization, or replace audit identity. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpApp } from "../create-http-app.js";
import {
  fromHeader,
  requireSession,
  withAuthorizationContext,
  withAuthorizationContextInput,
} from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

describe("input-only authorization context", () => {
  it("rejects mixing resolved and input-only authority in either declaration order", () => {
    const source = fromHeader("x-test-context");
    expect(() => withAuthorizationContextInput(withAuthorizationContext(requireSession(), source), source)).toThrow(
      "cannot be combined",
    );
    expect(() => withAuthorizationContext(withAuthorizationContextInput(requireSession(), source), source)).toThrow(
      "cannot be combined",
    );
  });
  it("passes only declared input while preserving identity and leaving policy to the operation", async () => {
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    let resolutions = 0;
    registerRoutes(app, {
      routes: routeGroup("Context input", [
        getRoute({
          path: "/context-input",
          summary: "Runtime authority input",
          access: withAuthorizationContextInput(requireSession(), fromHeader("x-test-context")),
          response: z.object({
            input: z.string().nullable(),
            actor: z.string(),
            audit: z.string(),
          }),
          handler: (context) => ({
            input: context.untrustedAuthorizationContext ?? null,
            actor: context.subject.id,
            audit: context.authenticatedSubject.id,
          }),
        }),
      ]),
      subjects: {
        resolve: () => Promise.resolve({ type: "user", id: "real-user" }),
      },
      authorization: {
        check: () => Promise.reject(new Error("No static permission declared")),
      },
      authorizationContexts: {
        execute: () => {
          resolutions += 1;
          return Promise.resolve(null);
        },
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/context-input",
        headers: { "x-test-context": "company:a" },
      });
      expect(response.json()).toMatchObject({
        data: { input: "company:a", actor: "real-user", audit: "real-user" },
      });
      const missing = await app.inject({
        method: "GET",
        url: "/context-input",
      });
      expect(missing.json()).toMatchObject({ data: { input: null } });
      const duplicate = await app.inject({
        method: "GET",
        url: "/context-input",
        headers: { "x-test-context": ["company:a", "company:b"] },
      });
      expect(duplicate.statusCode).toBe(404);
      expect(resolutions).toBe(0);
    } finally {
      await app.close();
    }
  });
});
