import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import type { ScopeAnswer } from "@dads-framework/access/runtime";
import { paginationQuerySchema } from "@dads-framework/core/contract";

import { requires, requiresScoped, requiresVisible } from "../src/lib/route/route-guards.test-support.js";
import { HttpWiringError, RequestValidationError, ResponseDriftError } from "../src/lib/http-errors.js";
import { fromParam, requireSession } from "../src/lib/route/access.js";
import { getRoute } from "../src/lib/route/get-route.js";
import { listRoute } from "../src/lib/route/list-route.js";
import { postRoute } from "../src/lib/route/post-route.js";
import { rawInput, subject, thingSchema } from "./verb-fixture.js";

describe("listRoute — the collection verb", () => {
  const listQuery = paginationQuerySchema;

  const things = listRoute({
    route: { method: "GET", template: "/things" },
    summary: "List things",
    access: requireSession(),
    query: listQuery,
    item: thingSchema,
    handler: ({ query }) => {
      expectTypeOf(query.page).toEqualTypeOf<number>();
      return { items: [{ id: "1", name: "n" }], total: 1 };
    },
  });

  it("assembles { data, meta } from { items, total } — no page echo in handlers", async () => {
    const result = await things.execute(rawInput({ query: { page: "2", perPage: "10" } }));
    expect(result).toEqual({
      data: [{ id: "1", name: "n" }],
      meta: { total: 1, page: 2, perPage: 10 },
    });
  });

  it("exposes the array + pagination meta schemas for OpenAPI", () => {
    expect(things.schemas.meta).toBeDefined();
    expect(things.schemas.query).toBe(listQuery);
  });

  it("treats a non-{ items, total } return as a wiring bug", async () => {
    const broken = listRoute({
      route: { method: "GET", template: "/things" },
      summary: "List things",
      access: requireSession(),
      query: listQuery,
      item: thingSchema,
      // @ts-expect-error — list handlers return { items, total }
      handler: () => [{ id: "1", name: "n" }],
    });
    await expect(broken.execute(rawInput({ query: { page: "1", perPage: "10" } }))).rejects.toThrow(
      /must return \{ items, total \}/,
    );
  });

  it("meta drift is a loud failure (total must be a count)", async () => {
    const drifting = listRoute({
      route: { method: "GET", template: "/things" },
      summary: "List things",
      access: requireSession(),
      query: listQuery,
      item: thingSchema,
      handler: () => ({ items: [], total: -1 }),
    });
    await expect(drifting.execute(rawInput({ query: { page: "1", perPage: "10" } }))).rejects.toThrow(
      ResponseDriftError,
    );
  });

  it("requireVisibility types visibleIds into the handler and short-circuits empty sets", async () => {
    const handlerCalls: string[][] = [];
    const visible = listRoute({
      route: { method: "GET", template: "/things" },
      summary: "List visible things",
      access: requiresVisible(permissionToken("things/thing", "view")),
      query: listQuery,
      item: thingSchema,
      handler: ({ visibleIds }) => {
        // The typed overload: present, readonly, non-optional.
        expectTypeOf(visibleIds).toEqualTypeOf<readonly string[]>();
        handlerCalls.push([...visibleIds]);
        return { items: [{ id: "1", name: "n" }], total: 1 };
      },
    });

    // Empty set: the kit answers with the empty page; the handler NEVER runs.
    const empty = await visible.execute(rawInput({ query: { page: "3", perPage: "10" }, visibleIds: [] }));
    expect(empty).toEqual({
      data: [],
      meta: { total: 0, page: 3, perPage: 10 },
    });
    expect(handlerCalls).toEqual([]);

    // Non-empty set flows through to the handler.
    const some = await visible.execute(rawInput({ query: { page: "1", perPage: "10" }, visibleIds: ["a"] }));
    expect(some.meta).toEqual({ total: 1, page: 1, perPage: 10 });
    expect(handlerCalls).toEqual([["a"]]);
  });

  it("requireVisibility is a compile error on single-resource verbs", () => {
    const wrongGet = getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "GET-one cannot take visibility",
      // @ts-expect-error — a set question makes no sense on GET-one
      access: requiresVisible(permissionToken("things/thing", "view")),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    const wrongPost = postRoute({
      route: { method: "POST", template: "/things" },
      summary: "POST cannot take visibility",
      // @ts-expect-error — POST cannot take visibility either
      access: requiresVisible(permissionToken("things/thing", "view")),
      body: z.object({ name: z.string() }),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(wrongGet).toBeDefined();
    expect(wrongPost).toBeDefined();
  });

  it("requiresScoped types the scope answer into the handler and never short-circuits", async () => {
    const scoped = listRoute({
      route: { method: "GET", template: "/things" },
      summary: "List scoped things",
      access: requiresScoped(permissionToken("things/thing", "view")),
      query: listQuery,
      item: thingSchema,
      handler: ({ scope }) => {
        expectTypeOf(scope).toEqualTypeOf<ScopeAnswer>();
        return { items: [{ id: "1", name: scope.resourceType }], total: 1 };
      },
    });
    const emptyAnswer: ScopeAnswer = {
      resourceType: "things/thing",
      permission: "view",
      plan: { kind: "tag", role: "public" },
      subject,
      idsByQuestion: new Map(),
    };

    // Empty answers still reach the handler: the SQL decides.
    const page = await scoped.execute(rawInput({ query: { page: "1", perPage: "10" }, scope: emptyAnswer }));
    expect(page.data).toEqual([{ id: "1", name: "things/thing" }]);

    // No answer at all is a wiring fault, never an unscoped list.
    await expect(scoped.execute(rawInput({ query: { page: "1", perPage: "10" } }))).rejects.toThrow(HttpWiringError);

    const wrongGet = getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "GET-one cannot be scoped",
      // @ts-expect-error — a scope is a set question too
      access: requiresScoped(permissionToken("things/thing", "view")),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(wrongGet).toBeDefined();
  });

  it("scopes a parameterless GET that answers about a set, never unscoped", async () => {
    const counted = getRoute({
      route: { method: "GET", template: "/things/counts" },
      summary: "Count scoped things",
      access: requiresScoped(permissionToken("things/thing", "view")),
      response: thingSchema,
      handler: ({ scope }) => {
        expectTypeOf(scope).toEqualTypeOf<ScopeAnswer>();
        return { id: "counts", name: scope.resourceType };
      },
    });
    const emptyAnswer: ScopeAnswer = {
      resourceType: "things/thing",
      permission: "view",
      plan: { kind: "tag", role: "public" },
      subject,
      idsByQuestion: new Map(),
    };

    expect((await counted.execute(rawInput({ scope: emptyAnswer }))).data).toEqual({
      id: "counts",
      name: "things/thing",
    });
    await expect(counted.execute(rawInput({}))).rejects.toThrow(HttpWiringError);
  });
});

describe("verb route runtime behavior of execute", () => {
  const route = postRoute({
    route: { method: "POST", template: "/things/:id" },
    summary: "Rename a thing",
    access: requires(permissionToken("things/thing", "edit"), fromParam("id")),
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string().min(1) }),
    response: thingSchema,
    handler: ({ params, body }) => ({ id: params.id, name: body.name }),
  });

  it("parses inputs and returns schema-parsed data", async () => {
    const result = await route.execute(rawInput({ params: { id: "t1" }, body: { name: "renamed" } }));
    expect(result).toEqual({ data: { id: "t1", name: "renamed" } });
  });

  it("throws RequestValidationError with the failing part on bad input", async () => {
    await expect(route.execute(rawInput({ params: { id: "t1" }, body: { name: "" } }))).rejects.toThrow(
      RequestValidationError,
    );
    await expect(route.execute(rawInput({ params: {}, body: { name: "x" } }))).rejects.toMatchObject({
      part: "params",
    });
  });

  it("throws ResponseDriftError when the handler output drifts", async () => {
    // Type-correct handler output that still fails the runtime refinement —
    // exactly the drift class @ZodResponse used to catch at the boundary.
    const drifting = getRoute({
      route: { method: "GET", template: "/broken" },
      summary: "Always drifts",
      access: requireSession(),
      response: z.object({ id: z.string().min(5) }),
      handler: () => ({ id: "1" }),
    });
    await expect(drifting.execute(rawInput({}))).rejects.toThrow(ResponseDriftError);
  });

  it("refuses to run a guarded route without a subject (kit invariant)", async () => {
    await expect(route.execute(rawInput({ params: { id: "t1" }, body: { name: "x" }, subject: null }))).rejects.toThrow(
      HttpWiringError,
    );
  });

  it("defaults status to 201 for POST and 200 otherwise, overridable", () => {
    expect(route.status).toBe(201);
    const read = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "Get the thing",
      access: requireSession(),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(read.status).toBe(200);
  });

  it("lets a POST answer 202 when it only accepts work it runs later", () => {
    const accepted = postRoute({
      route: { method: "POST", template: "/things/:id/jobs" },
      summary: "Queue work on the thing",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      status: 202,
      handler: ({ params }) => ({ id: params.id, name: "queued" }),
    });
    expect(accepted.status).toBe(202);
  });

  it("strips response fields not in the schema (no accidental leaks)", async () => {
    // Widening through a variable (no cast): the literal's extra field is
    // legal because excess-property checks apply only to direct literals.
    const rowFromDb = { id: "1", name: "n", secret: "do-not-ship" };
    const leaky = getRoute({
      route: { method: "GET", template: "/leaky" },
      summary: "Handler returns extra fields",
      access: requireSession(),
      response: thingSchema,
      handler: () => rowFromDb,
    });
    const result = await leaky.execute(rawInput({}));
    expect(result).toEqual({ data: { id: "1", name: "n" } });
    expect(result.data).not.toHaveProperty("secret");
  });
});
