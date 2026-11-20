// Request-local headers choose only the requested context. The authenticated
// identity stays server-owned, and duplicate headers fail closed before policy.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { bodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { buildOpenApiDocument } from "../openapi/build-document.js";
import {
  fromHeader,
  requireSession,
  withAuthorizationContext,
} from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { routeGroup } from "../route/route-group.js";
import { type AccessPorts, enforceAccess } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

const identity = { type: "user", id: "real-user" };
const access = withAuthorizationContext(
  requireSession(),
  fromHeader("X-Test-Context"),
);
const apps: Awaited<ReturnType<typeof createHttpApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

function fixture() {
  const resolved: { subject: unknown; company: unknown }[] = [];
  const ports: AccessPorts = {
    subjects: { resolve: () => Promise.resolve(identity) },
    authorization: { check: () => Promise.resolve(false) },
    authorizationContexts: {
      execute: (subject, company) => {
        resolved.push({ subject, company });
        return Promise.resolve(
          company === "a" || company === "b"
            ? {
                subject: { type: "test/actor", id: `${company}/${subject.id}` },
              }
            : null,
        );
      },
    },
  };
  return { ports, resolved };
}

function routes() {
  return routeGroup("HeaderContext", [
    getRoute({
      path: "/header-context",
      summary: "Read header-selected identity",
      access,
      response: z.object({ actor: z.string(), auditUser: z.string() }),
      handler: ({ subject, authenticatedSubject }) => ({
        actor: subject.id,
        auditUser: authenticatedSubject.id,
      }),
    }),
    getRoute({
      path: "/identity",
      summary: "Keep identity context",
      access: requireSession(),
      response: z.object({ actor: z.string() }),
      handler: ({ subject }) => ({ actor: subject.id }),
    }),
  ]);
}

describe("header context", () => {
  it("normalizes declaration names and independently resolves A/B for one identity", async () => {
    expect(fromHeader("X-Test-Context")).toEqual({
      kind: "header",
      name: "x-test-context",
    });
    const { ports, resolved } = fixture();
    for (const company of ["a", "b"]) {
      await expect(
        enforceAccess(
          access,
          {
            headers: { "x-test-context": company, "x-user": "forged-admin" },
            params: {},
            body: { authenticatedUserId: "forged-admin" },
          },
          ports,
        ),
      ).resolves.toEqual({
        outcome: "allow",
        subject: { type: "test/actor", id: `${company}/${identity.id}` },
        authenticatedSubject: identity,
        authorizationContext: company,
        accessKind: "session",
      });
    }
    expect(resolved).toEqual([
      { subject: identity, company: "a" },
      { subject: identity, company: "b" },
    ]);
  });

  it.each([
    { value: undefined },
    { value: "" },
    { value: " " },
    { value: ["a"] },
    { value: ["a", "b"] },
    { value: "a, b" },
  ])(
    "denies absent or repeated header $value before resolving",
    async ({ value }) => {
      const { ports, resolved } = fixture();
      await expect(
        enforceAccess(
          access,
          { headers: { "x-test-context": value }, params: {} },
          ports,
        ),
      ).resolves.toEqual({
        outcome: "not-found",
        subject: null,
        authenticatedSubject: identity,
      });
      expect(resolved).toEqual([]);
    },
  );

  it("denies repeated raw occurrences even if a server exposes only one value", async () => {
    const { ports, resolved } = fixture();
    await expect(
      enforceAccess(
        access,
        {
          headers: { "x-test-context": "a" },
          params: {},
          raw: { rawHeaders: ["X-Test-Context", "a", "x-test-context", "b"] },
        },
        ports,
      ),
    ).resolves.toEqual({
      outcome: "not-found",
      subject: null,
      authenticatedSubject: identity,
    });
    expect(resolved).toEqual([]);
  });

  it("uses actual HTTP headers without changing identity routes", async () => {
    const { ports } = fixture();
    const app = await createHttpApp({
      nodeEnv: "test",
      trustedOrigins: [],
      logger: false,
    });
    apps.push(app);
    registerRoutes(app, { ...ports, routes: routes() });
    for (const company of ["a", "b"]) {
      const response = await app.inject({
        method: "GET",
        url: "/header-context",
        headers: { "X-Test-Context": company },
      });
      expect(response.statusCode).toBe(200);
      expect(bodyOf(response)).toEqual({
        data: { actor: `${company}/${identity.id}`, auditUser: identity.id },
      });
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/header-context",
          headers: { "X-Test-Context": ["a", "b"] },
        })
      ).statusCode,
    ).toBe(404);
    const identityResponse = await app.inject({
      method: "GET",
      url: "/identity",
      headers: { "X-Test-Context": "b" },
    });
    expect(bodyOf(identityResponse)).toEqual({ data: { actor: identity.id } });
  });

  it("documents the context header as required only on the opted-in route", () => {
    const document = buildOpenApiDocument(routes(), {
      title: "Header proof",
      description: "Fixture",
      version: "1",
      pathPrefix: "/api",
      tags: [],
    });
    expect(document).toMatchObject({
      paths: {
        "/api/header-context": {
          get: {
            parameters: [
              {
                in: "header",
                name: "x-test-context",
                required: true,
                schema: { type: "string", minLength: 1 },
              },
            ],
          },
        },
        "/api/identity": { get: { parameters: [] } },
      },
    });
  });
});
