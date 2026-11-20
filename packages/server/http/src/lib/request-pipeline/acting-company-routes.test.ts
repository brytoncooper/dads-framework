// End-to-end HTTP-kit proof that handlers retain audit identity and changing
// companies cannot evade the authenticated user's rate budget.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { bodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import {
  withAuthorizationContext,
  fromQuery,
  requireSession,
} from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

const identity = { type: "user", id: "person" };
const apps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

async function buildCompanyApp(
  perMinute: number,
  actorFor: (organizationId: string) => string = (organizationId) =>
    `${organizationId}/person`,
) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("CompanyContext", [
      getRoute({
        route: { method: "GET", template: "/company-actor" },
        summary: "Inspect the resolved business actor and audit identity",
        access: withAuthorizationContext(
          requireSession(),
          fromQuery("actingOrganizationId"),
        ),
        capabilities: { rateLimit: { perMinute } },
        query: z.object({ actingOrganizationId: z.enum(["a", "b"]) }),
        response: z.object({
          businessActor: z.string(),
          auditUser: z.string(),
          context: z.string().nullable(),
        }),
        handler: ({ subject, authenticatedSubject, authorizationContext }) => ({
          businessActor: subject.id,
          auditUser: authenticatedSubject.id,
          context: authorizationContext ?? null,
        }),
      }),
    ]),
    subjects: { resolve: () => Promise.resolve(identity) },
    authorization: { check: () => Promise.resolve(false) },
    authorizationContexts: {
      execute: (_subject, organizationId) =>
        Promise.resolve(
          organizationId === "a" || organizationId === "b"
            ? {
                subject: {
                  type: "test/company_actor",
                  id: actorFor(organizationId),
                },
              }
            : null,
        ),
    },
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe("acting-company route execution", () => {
  it("passes the scoped subject and original identity separately to the handler", async () => {
    const app = await buildCompanyApp(10);
    const response = await app.inject({
      method: "GET",
      url: "/company-actor?actingOrganizationId=a",
    });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({
      data: { businessActor: "a/person", auditUser: "person", context: "a" },
    });
  });

  it("names the context a subject was resolved for when one subject answers several", async () => {
    const app = await buildCompanyApp(10, () => "person");
    const contexts = await Promise.all(
      ["a", "b"].map(async (organizationId) =>
        bodyOf(
          await app.inject({
            method: "GET",
            url: `/company-actor?actingOrganizationId=${organizationId}`,
          }),
        ),
      ),
    );
    expect(contexts).toEqual([
      { data: { businessActor: "person", auditUser: "person", context: "a" } },
      { data: { businessActor: "person", auditUser: "person", context: "b" } },
    ]);
  });

  it("shares one user's rate limit across its company actors", async () => {
    const app = await buildCompanyApp(1);
    await app.inject({
      method: "GET",
      url: "/company-actor?actingOrganizationId=a",
    });
    const second = await app.inject({
      method: "GET",
      url: "/company-actor?actingOrganizationId=b",
    });
    expect(second.statusCode).toBe(429);
  });
});
