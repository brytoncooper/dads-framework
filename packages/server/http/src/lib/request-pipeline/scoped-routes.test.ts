/**
 * What/why: a `requiresScoped` list compiles its scope plan when it registers
 * — so a list on a model whose bindings cannot carry the rule refuses to boot
 * — and per request asks each of the plan's scope questions once and hands
 * the handler the answers, empty ones included (the SQL decides, never an
 * empty-set short-circuit).
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  access,
  accessModel,
  entityHandle,
  scopeBindings,
  through,
  wildcard,
  type PermissionToken,
} from "@dads-framework/access";
import { requiresScoped } from "../route/route-guards.test-support.js";
import type { ResourceLookup } from "@dads-framework/access/runtime";
import { paginationQuerySchema } from "@dads-framework/contract";

import { listBodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { HttpWiringError } from "../http-errors.js";
import { defineRawRoute } from "../route/define-raw-route.js";
import { listRoute } from "../route/list-route.js";
import { routeGroup } from "../route/route-group.js";
import type { SubjectResolver } from "./enforce-access.js";
import { registerRoutes } from "./register-routes.js";

const idSchema = z.string();
const User = entityHandle({ wireName: "scopedhttp/user", idSchema });
const Team = entityHandle({
  wireName: "scopedhttp/team",
  idSchema,
  kind: "scope",
});
const Note = entityHandle({
  wireName: "scopedhttp/note",
  idSchema,
  kind: "record",
});
const Memo = entityHandle({
  wireName: "scopedhttp/memo",
  idSchema,
  kind: "record",
});

const team = access(Team, {
  roles: { member: User },
  permissions: (roles) => ({ view: [roles.member] }),
});

const note = access(Note, {
  roles: { team: Team, published: wildcard(User) },
  permissions: (roles) => ({
    view: [through(roles.team, team.permissions.view), roles.published],
  }),
});

// Bound nowhere: a list scoped by memo.view cannot be compiled.
const memo = access(Memo, {
  roles: { team: Team },
  permissions: (roles) => ({
    view: [through(roles.team, team.permissions.view)],
  }),
});

const noteBindings = scopeBindings(note, {
  team: { kind: "scope-column" },
  published: { kind: "tag" },
});

const model = accessModel([team, note, memo], [noteBindings]);

const subjects: SubjectResolver = {
  resolve: (request) => {
    const id = request.headers["x-test-user"];
    return Promise.resolve(
      typeof id === "string" && id.length > 0
        ? { type: User.wireName, id }
        : null,
    );
  },
};

const itemSchema = z.object({ question: z.string(), ids: z.array(z.string()) });

function scopedNotesRoute(token: PermissionToken) {
  return listRoute({
    route: { method: "GET", template: "/scoped" },
    summary: "List scoped records",
    access: requiresScoped(token),
    query: paginationQuerySchema,
    item: itemSchema,
    handler: ({ scope }) => {
      const items = [...scope.idsByQuestion].map(([question, ids]) => ({
        question,
        ids: [...ids],
      }));
      return { items, total: items.length };
    },
  });
}

const apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(
  routes: ReturnType<typeof routeGroup>,
  lookups: (query: ResourceLookup) => readonly string[],
) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  apps.push(app);
  registerRoutes(app, {
    routes,
    accessModel: model,
    subjects,
    authorization: { check: () => Promise.resolve(false) },
    lookups: {
      lookupResources: (query) => Promise.resolve(lookups(query)),
    },
  });
  await app.ready();
  return app;
}

describe("requiresScoped list routes", () => {
  it("hands the handler each scope question's answer, asked once, empty answers included", async () => {
    const asked: string[] = [];
    const app = await appWith(
      routeGroup("Notes", [scopedNotesRoute(note.permissions.view)]),
      (query) => {
        asked.push(
          `${query.subject.id} ${query.resourceType}#${query.permission}`,
        );
        return [];
      },
    );

    const response = await app.inject({
      method: "GET",
      url: "/scoped",
      headers: { "x-test-user": "u1" },
    });

    expect(response.statusCode).toBe(200);
    expect(listBodyOf(response, z.array(itemSchema), z.unknown()).data).toEqual(
      [{ question: "scopedhttp/team#view", ids: [] }],
    );
    expect(asked).toEqual(["u1 scopedhttp/team#view"]);
  });

  it("refuses an unauthenticated caller before asking anything", async () => {
    const asked: string[] = [];
    const app = await appWith(
      routeGroup("Notes", [scopedNotesRoute(note.permissions.view)]),
      (query) => {
        asked.push(query.permission);
        return [];
      },
    );

    const response = await app.inject({ method: "GET", url: "/scoped" });

    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it("refuses to register a list on a record whose bindings cannot carry the rule", async () => {
    await expect(
      appWith(
        routeGroup("Memos", [scopedNotesRoute(memo.permissions.view)]),
        () => [],
      ),
    ).rejects.toThrow(
      new HttpWiringError(
        "list route GET /scoped cannot be scoped: cannot compile a scope plan for scopedhttp/memo.view:\n  scopedhttp/memo.view: scopedhttp/memo is not a record with scope bindings",
      ),
    );
  });

  it("refuses a raw route that declares requiresScoped", async () => {
    const raw = defineRawRoute({
      method: "GET",
      path: "/raw-scoped",
      summary: "Raw routes cannot render a scope",
      access: requiresScoped(note.permissions.view),
      openapi: { responses: { "200": { description: "never registered" } } },
      handler: () => Promise.resolve(),
    });
    await expect(appWith(routeGroup("Raw", [raw]), () => [])).rejects.toThrow(
      "raw route GET /raw-scoped declares requiresScoped; only listRoute renders a scope",
    );
  });
});
