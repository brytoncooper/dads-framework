import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AuditActor,
  currentAuditActor,
} from "@dads-framework/core/audit-actor";
import type { SubjectRef } from "@dads-framework/access/runtime";
import { REQUEST_ID_HEADER } from "@dads-framework/core/contract";

import { createHttpApp } from "../create-http-app.js";
import { publicAccess, requireSession } from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { routeGroup } from "../route/route-group.js";
import type { AuditActorForSubject } from "./carry-audit-actor.js";
import type { PermissionChecker, SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

/**
 * The HTTP seam of the actor context. What matters is not that the
 * context exists somewhere but that it reaches the places that WRITE: the
 * route handler, and the protocol mounts registered straight onto the app —
 * `/api/auth` writes `session` and `user` rows on a request that has no
 * subject at all, and an unattributed write is refused by the database.
 */

const subject: SubjectRef = { type: "user", id: "u1" };

const subjects: SubjectResolver = {
  resolve: (request) =>
    Promise.resolve(request.headers["x-anon"] === "1" ? null : subject),
};

/** A session a staff member signed in as `u1` under; the subject stays `u1`. */

const neverChecks: PermissionChecker = { check: () => Promise.resolve(false) };

/** Structurally what the composition root injects; the real mapping is its own. */
const mapSubjectToActor: AuditActorForSubject = ({
  authenticatedSubject,
  requestId,
}) => {
  return authenticatedSubject === null
    ? { kind: "anonymous", id: "", requestId }
    : { kind: "user", id: authenticatedSubject.id, requestId };
};

const actorSchema = z.object({
  kind: z.string(),
  id: z.string(),
  requestId: z.string(),
});

/** What the handler saw, flattened so the assertion reads as one object. */
function seenActor(): z.infer<typeof actorSchema> {
  const actor = currentAuditActor();
  if (actor === undefined) {
    return { kind: "MISSING", id: "MISSING", requestId: "MISSING" };
  }
  return { kind: actor.kind, id: actor.id, requestId: actor.requestId };
}

const routes = routeGroup("Actors", [
  getRoute({
    route: { method: "GET", template: "/public-actor" },
    summary: "Reports the actor a public request carries",
    access: publicAccess(),
    response: actorSchema,
    handler: seenActor,
  }),
  getRoute({
    route: { method: "GET", template: "/session-actor" },
    summary: "Reports the actor a signed-in request carries",
    access: requireSession(),
    response: actorSchema,
    handler: seenActor,
  }),
]);

let apps: { close: () => Promise<void> }[] = [];

async function buildApp(options: {
  readonly auditActorForSubject?: AuditActorForSubject;
  readonly subjects?: SubjectResolver;
  readonly recordAtResponse?: (actor: ReturnType<typeof seenActor>) => void;
}) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  const record = options.recordAtResponse;
  if (record !== undefined) {
    app.addHook("onResponse", (_request, _reply, done) => {
      record(seenActor());
      done();
    });
  }
  // A protocol mount: registered straight onto the app, never through
  // registerRoutes — the shape /api/auth and /scim/v2 take.
  app.get("/mounted", () => seenActor());
  registerRoutes(app, {
    routes,
    subjects: options.subjects ?? subjects,
    authorization: neverChecks,
    ...(options.auditActorForSubject === undefined
      ? {}
      : { auditActorForSubject: options.auditActorForSubject }),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe("the audit actor a request carries", () => {
  it("is anonymous, with the request id, on a public route", async () => {
    const app = await buildApp({ auditActorForSubject: mapSubjectToActor });
    const response = await app.inject({
      method: "GET",
      url: "/public-actor",
      headers: { [REQUEST_ID_HEADER]: "req-public" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { kind: "anonymous", id: "", requestId: "req-public" },
    });
  });

  it("is the resolved user on a session route", async () => {
    const app = await buildApp({ auditActorForSubject: mapSubjectToActor });
    const response = await app.inject({
      method: "GET",
      url: "/session-actor",
      headers: { [REQUEST_ID_HEADER]: "req-session" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { kind: "user", id: "u1", requestId: "req-session" },
    });
  });

  it("reaches a protocol mount, which never sees access enforcement", async () => {
    const app = await buildApp({ auditActorForSubject: mapSubjectToActor });
    const response = await app.inject({
      method: "GET",
      url: "/mounted",
      headers: { [REQUEST_ID_HEADER]: "req-mounted" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: "anonymous",
      id: "",
      requestId: "req-mounted",
    });
  });

  it("stays anonymous when no mapper is wired, rather than vanishing", async () => {
    const app = await buildApp({});
    const response = await app.inject({
      method: "GET",
      url: "/session-actor",
      headers: { [REQUEST_ID_HEADER]: "req-unwired" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { kind: "anonymous", id: "", requestId: "req-unwired" },
    });
  });

  it("does not leak one request's actor into the next", async () => {
    const app = await buildApp({ auditActorForSubject: mapSubjectToActor });
    await app.inject({
      method: "GET",
      url: "/session-actor",
      headers: { [REQUEST_ID_HEADER]: "req-first" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/mounted",
      headers: { [REQUEST_ID_HEADER]: "req-second" },
    });
    expect(second.json()).toEqual({
      kind: "anonymous",
      id: "",
      requestId: "req-second",
    });
  });

  it("is still in force at onResponse, where the request row is written", async () => {
    const atResponse: ReturnType<typeof seenActor>[] = [];
    const app = await buildApp({
      auditActorForSubject: mapSubjectToActor,
      recordAtResponse: (actor) => atResponse.push(actor),
    });
    await app.inject({
      method: "GET",
      url: "/public-actor",
      headers: { [REQUEST_ID_HEADER]: "req-response" },
    });
    expect(atResponse).toEqual([
      { kind: "anonymous", id: "", requestId: "req-response" },
    ]);
  });

  it("is gone outside a request", () => {
    const outside: AuditActor | undefined = currentAuditActor();
    expect(outside).toBeUndefined();
  });
});
