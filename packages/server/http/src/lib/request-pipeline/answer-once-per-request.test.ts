/**
 * What: every route runs inside one answer-once scope per request — a
 * question the request repeats reaches the authorization vendor once, a write
 * inside the request forgets the answers, and separate requests share nothing.
 * Why: an answer kept across a write would hand out authority the request
 * just revoked; an answer kept across requests would answer one caller with
 * a decision made before another caller's revocation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AnswerOnceAuthorization,
  Authorization,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";

import { createHttpApp } from "../create-http-app.js";
import { publicAccess } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { postRoute } from "../route/post-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

class CountingAuthorization extends Authorization {
  checks = 0;
  override check(): Promise<boolean> {
    this.checks += 1;
    return Promise.resolve(true);
  }
  override lookupResources(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  override writeRelationships(): Promise<string> {
    return Promise.resolve("written");
  }
  override deleteRelationships(): Promise<string> {
    return Promise.resolve("deleted");
  }
  override relationshipExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  override listDirectSubjects(): Promise<readonly SubjectRef[]> {
    return Promise.resolve([]);
  }
}

const question = {
  subject: { type: "user", id: "reader" },
  permission: "view",
  resource: { type: "test/document", id: "document" },
};
const answered = z.object({ allowed: z.boolean() });

const apps: { close: () => Promise<void> }[] = [];

async function buildApp() {
  const vendor = new CountingAuthorization();
  const authorization = new AnswerOnceAuthorization(vendor);
  const routes = routeGroup("Answer once", [
    getRoute({
      route: { method: "GET", template: "/twice" },
      summary: "Asks the same question twice",
      access: publicAccess(),
      response: answered,
      handler: async () => {
        await authorization.check(question);
        return { allowed: await authorization.check(question) };
      },
    }),
    postRoute({
      route: { method: "POST", template: "/around-a-write" },
      summary: "Asks, writes, and asks again",
      access: publicAccess(),
      body: z.object({}),
      response: answered,
      handler: async () => {
        await authorization.check(question);
        await authorization.deleteRelationships({
          resourceType: question.resource.type,
          resourceId: question.resource.id,
        });
        return { allowed: await authorization.check(question) };
      },
    }),
  ]);
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
  return { app, vendor };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("one answer-once scope per request", () => {
  it("reaches the vendor once for a question one request repeats", async () => {
    const { app, vendor } = await buildApp();
    const response = await app.inject({ method: "GET", url: "/twice" });
    expect(response.statusCode).toBe(200);
    expect(vendor.checks).toBe(1);
  });

  it("asks again in the next request", async () => {
    const { app, vendor } = await buildApp();
    await app.inject({ method: "GET", url: "/twice" });
    await app.inject({ method: "GET", url: "/twice" });
    expect(vendor.checks).toBe(2);
  });

  it("forgets the request's answers after a write inside it", async () => {
    const { app, vendor } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/around-a-write",
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(vendor.checks).toBe(2);
  });
});
