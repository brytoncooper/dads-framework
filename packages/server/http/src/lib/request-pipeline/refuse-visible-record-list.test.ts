/**
 * What/why: a `requiresVisible` list asks SpiceDB for every visible id, which
 * is bounded for a scope or catalog and unbounded for a record. A record
 * listed that way must refuse to register (so the API refuses to boot) unless
 * the product's boot check registered a dated exception for it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  access,
  accessModel,
  allowVisibleOnRecordUntil,
  entityHandle,
  type PermissionToken,
} from "@dads-framework/access";
import { requiresVisible } from "../route/route-guards.test-support.js";
import { paginationQuerySchema } from "@dads-framework/contract";

import { createHttpApp } from "../create-http-app.js";
import { HttpWiringError } from "../http-errors.js";
import { listRoute } from "../route/list-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

const idSchema = z.string();
const User = entityHandle({ wireName: "visiblehttp/user", idSchema });

function viewable(wireName: string, kind?: "scope" | "catalog" | "record") {
  const handle = entityHandle({
    wireName,
    idSchema,
    ...(kind === undefined ? {} : { kind }),
  });
  return access(handle, {
    roles: { member: User },
    permissions: (roles) => ({ view: [roles.member] }),
  });
}

const team = viewable("visiblehttp/team", "scope");
const machine = viewable("visiblehttp/machine", "catalog");
const ticket = viewable("visiblehttp/ticket", "record");
const legacy = viewable("visiblehttp/legacy");
const model = accessModel([team, machine, ticket, legacy]);

function visibleList(token: PermissionToken) {
  return listRoute({
    route: { method: "GET", template: "/visible" },
    summary: "List visible things",
    access: requiresVisible(token),
    query: paginationQuerySchema,
    item: z.string(),
    handler: ({ visibleIds }) => ({
      items: [...visibleIds],
      total: visibleIds.length,
    }),
  });
}

const apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function register(
  token: PermissionToken,
  modelForRoute = model,
): Promise<void> {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  apps.push(app);
  registerRoutes(app, {
    accessModel: modelForRoute,
    routes: routeGroup("Things", [visibleList(token)]),
    subjects: { resolve: () => Promise.resolve(null) },
    authorization: { check: () => Promise.resolve(false) },
    lookups: { lookupResources: () => Promise.resolve([]) },
  });
  await app.ready();
}

describe("requiresVisible on a record", () => {
  it("refuses to register, pointing at requiresScoped", async () => {
    await expect(register(ticket.permissions.view)).rejects.toThrow(
      new HttpWiringError(
        'GET /visible lists visiblehttp/ticket, a record, with requiresVisible; a record list must use requiresScoped and declare scope bindings (docs/architecture/authorization.md, "To move a record list onto a scope plan")',
      ),
    );
  });

  it("registers for a scope, a catalog, and an entity with no declared kind", async () => {
    await expect(register(team.permissions.view)).resolves.toBeUndefined();
    await expect(register(machine.permissions.view)).resolves.toBeUndefined();
    await expect(register(legacy.permissions.view)).resolves.toBeUndefined();
  });

  it("refuses a route whose record definition is missing from its model", async () => {
    await expect(
      register(ticket.permissions.view, accessModel([team])),
    ).rejects.toThrow(
      "uses requiresVisible for visiblehttp/ticket, which is missing from the access model",
    );
  });

  it("registers a record only through a dated exception", async () => {
    const exception = allowVisibleOnRecordUntil("2099-12-15", {
      resourceType: "visiblehttp/ticket",
      removedBy: "PR #813",
    });
    const modelWithException = accessModel([ticket], [], [exception]);
    await expect(
      register(ticket.permissions.view, modelWithException),
    ).resolves.toBeUndefined();
  });
});
