/**
 * What/why: a `requiresVisible` list asks SpiceDB for every visible id, which
 * is unbounded for records. Registration is fail-closed: a visibility route
 * refuses to register unless the compiled model explicitly lists the resource
 * in `allowLookupResourcesOn` and does not bind it in `scopeBindings`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  actor,
  compileAccess,
  resource,
  type PermissionToken,
} from "@dads-framework/access";
import { scopeBindings } from "@dads-framework/access/scopes";
import { requiresVisible } from "../route/route-guards.test-support.js";
import { paginationQuerySchema } from "@dads-framework/core/contract";

import { createHttpApp } from "../create-http-app.js";
import { HttpWiringError } from "../http-errors.js";
import { listRoute } from "../route/list-route.js";
import { routeGroup } from "../route/route-group.js";
import { registerRoutes } from "./register-routes.js";

const idSchema = z.string();
const User = actor("visiblehttp/user", { id: idSchema });

function viewable(wireName: string) {
  return resource(wireName, {
    id: idSchema,
    roles: { member: User },
    can: ({ member }) => ({ view: member }),
  });
}

const team = viewable("visiblehttp/team");
const machine = viewable("visiblehttp/machine");
const ticket = resource("visiblehttp/ticket", {
  id: idSchema,
  roles: { team, member: User },
  can: ({ team: parentTeam, member }) => ({ view: [parentTeam.view, member] }),
});
const unlisted = viewable("visiblehttp/unlisted");

const ticketScope = scopeBindings(ticket, {
  team: { kind: "scope-column" },
  member: { kind: "sparse-direct" },
});

const model = compileAccess([User, team, machine, ticket, unlisted], {
  bindings: [ticketScope],
  allowLookupResourcesOn: [team, machine],
});

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

describe("requiresVisible fail-closed registration", () => {
  it("refuses a scoped record and an unlisted resource, pointing at requiresScoped", async () => {
    await expect(register(ticket.permissions.view)).rejects.toThrow(
      new HttpWiringError(
        'GET /visible lists visiblehttp/ticket with requiresVisible, which is refused unless visiblehttp/ticket is in allowLookupResourcesOn (and not bound in scopeBindings); a record list must use requiresScoped and declare scope bindings (docs/architecture/authorization.md, "To move a record list onto a scope plan")',
      ),
    );
    await expect(register(unlisted.permissions.view)).rejects.toThrow(
      HttpWiringError,
    );
  });

  it("registers resources explicitly listed in allowLookupResourcesOn", async () => {
    await expect(register(team.permissions.view)).resolves.toBeUndefined();
    await expect(register(machine.permissions.view)).resolves.toBeUndefined();
  });

  it("refuses a resource that has scopeBindings even when also named in allowLookupResourcesOn", async () => {
    const boundAndAllowed = compileAccess([User, team, ticket], {
      bindings: [ticketScope],
      allowLookupResourcesOn: [team, ticket],
    });
    await expect(
      register(ticket.permissions.view, boundAndAllowed),
    ).rejects.toThrow(HttpWiringError);
  });

  it("refuses a route whose resource definition is missing from its model", async () => {
    await expect(
      register(
        ticket.permissions.view,
        compileAccess([User, team], { allowLookupResourcesOn: [team] }),
      ),
    ).rejects.toThrow(
      "uses requiresVisible for visiblehttp/ticket, which is missing from the access model",
    );
  });
});
