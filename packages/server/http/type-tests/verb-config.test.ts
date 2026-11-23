import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import type { SubjectRef } from "@dads-framework/access/runtime";
import { defineRoute } from "@dads-framework/core/contract";

import {
  type DeleteRouteHandlerContext,
  type GetRouteHandlerContext,
  type GetRouteHandlerResult,
  type ListRouteHandlerContext,
  type ListRouteHandlerResult,
  type MutateRouteHandlerContext,
  type MutateRouteHandlerResult,
  type NamedRouteHandler,
  type PostRouteHandlerContext,
  type PostRouteHandlerResult,
} from "../src/index.js";
import { HttpWiringError } from "../src/lib/http-errors.js";
import { fromParam, publicAccess, requireSession } from "../src/lib/route/access.js";
import { deleteRoute } from "../src/lib/route/delete-route.js";
import { getRoute } from "../src/lib/route/get-route.js";
import { patchRoute } from "../src/lib/route/patch-route.js";
import { postNoContentRoute } from "../src/lib/route/post-no-content-route.js";
import { postRoute } from "../src/lib/route/post-route.js";

import { requires } from "../src/lib/route/route-guards.test-support.js";
import { rawInput, thingSchema } from "./verb-fixture.js";

const thingRoutes = {
  detail: defineRoute("GET", "/things/:id", (id: string) => `/things/${encodeURIComponent(id)}`),
};

describe("verb-specific compile walls", () => {
  it("accepts named handler functions through the generated handler-property seam", () => {
    type GetThingContext = GetRouteHandlerContext<{ readonly id: string }, undefined, SubjectRef>;
    type GetThingResult = GetRouteHandlerResult<typeof thingSchema>;

    const getThing: NamedRouteHandler<GetThingContext, Promise<GetThingResult>> = function getThing(context) {
      return Promise.resolve({ id: context.params.id, name: "thing" });
    };

    expectTypeOf(getThing).toExtend<NamedRouteHandler<GetThingContext, Promise<GetThingResult>>>();
  });

  it("accepts a literal path as the transitional route-card source", () => {
    const get = getRoute({
      path: "/things/:id",
      summary: "Get a thing",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: ({ params }) => ({ id: params.id, name: "n" }),
    });

    expect(get.method).toBe("GET");
    expect(get.path).toBe("/things/:id");
    expect(get.descriptor).toEqual({ method: "GET", template: "/things/:id" });
  });

  it("requires exactly one route source and refuses malformed runtime input", () => {
    expect(() =>
      getRoute({
        route: thingRoutes.detail,
        // @ts-expect-error — route cards use one source, never route plus path
        path: "/things/:id",
        summary: "A route has one path source",
        access: requireSession(),
        params: z.object({ id: z.string() }),
        response: thingSchema,
        handler: ({ params }) => ({ id: params.id, name: "n" }),
      }),
    ).toThrow(HttpWiringError);

    expect(() =>
      // @ts-expect-error — route cards need either a legacy route or literal path
      getRoute({
        summary: "A route needs a path source",
        access: requireSession(),
        response: thingSchema,
        handler: () => ({ id: "1", name: "n" }),
      }),
    ).toThrow(HttpWiringError);
  });

  it("requires a literal mount-relative route-card path", () => {
    const pathFromRuntime = ["/things"].join("");
    const dynamic = getRoute({
      // @ts-expect-error — path declarations are literal, mount-relative route cards
      path: pathFromRuntime,
      summary: "A dynamic path hides the route card",
      access: requireSession(),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(dynamic).toBeDefined();

    expect(() =>
      getRoute({
        // @ts-expect-error — only mount-relative paths belong in a route card
        path: "things",
        summary: "A relative path is not an API route",
        access: requireSession(),
        response: thingSchema,
        handler: () => ({ id: "1", name: "n" }),
      }),
    ).toThrow(HttpWiringError);
  });

  it("derives the registered method and template from the descriptor", () => {
    const get = getRoute({
      route: thingRoutes.detail,
      summary: "Get a thing",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: ({ params }) => ({ id: params.id, name: "n" }),
    });

    expect(get.method).toBe("GET");
    expect(get.path).toBe("/things/:id");
  });

  it("refuses a descriptor whose method disagrees with the helper", () => {
    expect(() =>
      getRoute({
        // @ts-expect-error — a PATCH descriptor cannot be registered as GET
        route: { method: "PATCH", template: "/things" },
        summary: "A mismatched verb is a bug",
        access: requireSession(),
        response: thingSchema,
        handler: () => ({ id: "1", name: "n" }),
      }),
    ).toThrow(HttpWiringError);
  });

  it("a GET cannot declare a body", () => {
    const bodied = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "GET with a body is a bug",
      access: requireSession(),
      response: thingSchema,
      // @ts-expect-error — GET configs have no body key
      body: z.object({ nope: z.string() }),
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(bodied).toBeDefined();
  });

  it("a PATCH requires a body", () => {
    // @ts-expect-error — body is required on mutations
    const bodyless = patchRoute({
      route: { method: "PATCH", template: "/things/:id" },
      summary: "PATCH without body is a bug",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(bodyless).toBeDefined();
  });

  it("a GET cannot return an array — collections are listRoute", () => {
    const arrayGet = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "A sneaky unpaginated collection",
      access: requireSession(),
      // @ts-expect-error — array responses are collections; use listRoute
      response: z.array(thingSchema),
      handler: () => [],
    });
    expect(arrayGet).toBeDefined();
  });

  it("a DELETE has no response schema and returns nothing", () => {
    const del = deleteRoute({
      route: { method: "DELETE", template: "/things/:id" },
      summary: "Delete a thing",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      handler: () => undefined,
    });
    expect(del.status).toBe(204);
  });

  it("a no-content POST has no response schema, answers 204 and passes its body", async () => {
    const bodySchema = z.object({ count: z.number() });
    let seen: unknown;
    const post = postNoContentRoute({
      route: { method: "POST", template: "/reports" },
      summary: "Report a count",
      access: requireSession(),
      body: bodySchema,
      handler: ({ body }) => {
        seen = body;
      },
    });
    expect(post.method).toBe("POST");
    expect(post.status).toBe(204);
    expect(post.schemas.response).toBeUndefined();
    const result = await post.execute(rawInput({ body: { count: 3 } }));
    expect(result).toEqual({ data: undefined });
    expect(seen).toEqual({ count: 3 });
  });

  it("a DELETE may declare a request body and pass it to the handler", async () => {
    const bodySchema = z.object({
      userId: z.string(),
      relation: z.enum(["admin", "member"]),
    });
    let seen: unknown;
    const del = deleteRoute({
      route: { method: "DELETE", template: "/things/:id/grants" },
      summary: "Revoke a grant",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      body: bodySchema,
      handler: ({ body }) => {
        seen = body;
      },
    });
    expect(del.schemas.body).toBe(bodySchema);
    await del.execute(
      rawInput({
        params: { id: "t1" },
        body: { userId: "u1", relation: "member" },
      }),
    );
    expect(seen).toEqual({ userId: "u1", relation: "member" });
  });
});

describe("named route-handler aliases", () => {
  it("lets paired handler modules state their contexts and results", () => {
    type GetThingContext = GetRouteHandlerContext<{ id: string }, undefined, SubjectRef>;
    type GetThingResult = GetRouteHandlerResult<typeof thingSchema>;
    function getThing(context: GetThingContext): GetThingResult {
      return { id: context.params.id, name: context.subject.id };
    }

    type ListThingsContext = ListRouteHandlerContext<undefined, { page: number; perPage: number }, SubjectRef>;
    type ListThingsResult = ListRouteHandlerResult<typeof thingSchema>;
    function listThings(context: ListThingsContext): ListThingsResult {
      return {
        items: [{ id: String(context.query.page), name: context.subject.id }],
        total: context.query.perPage,
      };
    }

    type CreateThingContext = PostRouteHandlerContext<undefined, undefined, { name: string }, SubjectRef>;
    type CreateThingResult = PostRouteHandlerResult<typeof thingSchema>;
    function createThing(context: CreateThingContext): CreateThingResult {
      return { id: context.subject.id, name: context.body.name };
    }

    type RenameThingContext = MutateRouteHandlerContext<{ id: string }, { name: string }, SubjectRef>;
    type RenameThingResult = MutateRouteHandlerResult<typeof thingSchema>;
    function renameThing(context: RenameThingContext): RenameThingResult {
      return { id: context.params.id, name: context.body.name };
    }

    type DeleteThingContext = DeleteRouteHandlerContext<{ id: string }, undefined, SubjectRef>;
    function deleteThing(context: DeleteThingContext): void {
      expect(context.subject.id).toBe("u1");
    }

    expectTypeOf(getThing).toExtend<(context: GetThingContext) => GetThingResult>();
    expectTypeOf(listThings).toExtend<(context: ListThingsContext) => ListThingsResult>();
    expectTypeOf(createThing).toExtend<(context: CreateThingContext) => CreateThingResult>();
    expectTypeOf(renameThing).toExtend<(context: RenameThingContext) => RenameThingResult>();
    expectTypeOf(deleteThing).toExtend<(context: DeleteThingContext) => void>();
  });
});

describe("route compile-time guarantees", () => {
  it("requires the access field — omission does not compile", () => {
    // @ts-expect-error — access is required; a route cannot exist unguarded
    const unguarded = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "Get the thing",
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(unguarded).toBeDefined();
  });

  it("requires a params schema covering every path param", () => {
    const covered = getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "Get a thing",
      access: requires(permissionToken("things/thing", "view"), fromParam("id")),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: ({ params }) => {
        expectTypeOf(params).toEqualTypeOf<{ id: string }>();
        return { id: params.id, name: "n" };
      },
    });
    expect(covered.path).toBe("/things/:id");

    const mismatched = getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "Get a thing",
      access: requireSession(),
      // @ts-expect-error — schema key does not cover the :id path param
      params: z.object({ wrong: z.string() }),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(mismatched).toBeDefined();

    // @ts-expect-error — a path with :id demands a params schema
    const missing = getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "Get a thing",
      access: requireSession(),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
    });
    expect(missing).toBeDefined();
  });

  it("checks the handler return against the response schema", () => {
    const drifted = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "List things",
      access: requireSession(),
      response: thingSchema,
      // @ts-expect-error — handler return does not satisfy the response schema
      handler: () => ({ nope: true }),
    });
    expect(drifted).toBeDefined();
  });

  it("gives protected routes a non-null subject and public routes a nullable one", () => {
    getRoute({
      route: { method: "GET", template: "/things/:id" },
      summary: "Get a thing",
      access: requireSession(),
      params: z.object({ id: z.string() }),
      response: thingSchema,
      handler: ({ subject: s, params }) => {
        expectTypeOf(s).toEqualTypeOf<SubjectRef>();
        return { id: params.id, name: "n" };
      },
    });

    getRoute({
      route: { method: "GET", template: "/health" },
      summary: "Liveness",
      access: publicAccess(),
      response: z.object({ ok: z.boolean() }),
      handler: ({ subject: s }) => {
        expectTypeOf(s).toEqualTypeOf<SubjectRef | null>();
        return { ok: true };
      },
    });
  });

  it("exposes business subject and audit identity without leaking Fastify types", () => {
    postRoute({
      route: { method: "POST", template: "/things" },
      summary: "Create a thing",
      access: requireSession(),
      body: z.object({ name: z.string() }),
      response: thingSchema,
      handler: (ctx) => {
        expectTypeOf<keyof typeof ctx>().toEqualTypeOf<
          | "params"
          | "query"
          | "body"
          | "subject"
          | "authenticatedSubject"
          | "untrustedAuthorizationContext"
          | "authorizationContext"
          | "sessionReauthenticatedAt"
          | "requestId"
          | "locale"
          | "log"
          | "visibleIds"
          | "scope"
          | "featureState"
        >();
        expectTypeOf(ctx.body).toEqualTypeOf<{ name: string }>();
        expectTypeOf(ctx.authenticatedSubject).toEqualTypeOf<SubjectRef>();
        expectTypeOf(ctx.params).toEqualTypeOf<undefined>();
        return { id: "1", name: ctx.body.name };
      },
    });
  });

  it("rejects unknown config keys", () => {
    const stray = getRoute({
      route: { method: "GET", template: "/things" },
      summary: "Get the thing",
      access: requireSession(),
      response: thingSchema,
      handler: () => ({ id: "1", name: "n" }),
      // @ts-expect-error — no silent extra config; the surface is closed
      middleware: [],
    });
    expect(stray).toBeDefined();
  });
});
