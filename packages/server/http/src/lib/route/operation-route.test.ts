/**
 * What: all seven HTTP route verb helpers accept matching standalone operation
 * contracts, infer handler inputs/outputs from them, and refuse mismatches.
 * Why: domains should declare wire contracts once and mount them on routes
 * without repeating paths, params, query, body, response, meta, or status.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import type { ScopeAnswer, SubjectRef } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import {
  deleteOperation,
  getOperation,
  listOperation,
  paginationMetaSchema,
  paginationQuerySchema,
  patchOperation,
  postNoContentOperation,
  postOperation,
  putOperation,
} from "@dads-framework/core/contract";

import { bodyOf } from "../../testing/index.js";
import { createHttpApp } from "../create-http-app.js";
import { HttpWiringError } from "../http-errors.js";
import { registerRoutes } from "../request-pipeline/register-routes.js";
import { publicAccess, requireSession, requiresScoped, requiresVisible } from "./access.js";
import { deleteRoute } from "./delete-route.js";
import { getRoute } from "./get-route.js";
import { listRoute } from "./list-route.js";
import { patchRoute, putRoute } from "./patch-route.js";
import { postNoContentRoute } from "./post-no-content-route.js";
import { postRoute } from "./post-route.js";
import type { RawRouteInput, RouteBlueprint, RouteLogger } from "./route-definition.js";
import { routeGroup } from "./route-group.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });
const idParams = z.strictObject({ id: z.string().min(1) });
const titleBody = z.strictObject({ title: z.string().min(1) });
const reasonBody = z.strictObject({ reason: z.string().min(1) });
const countedMeta = paginationMetaSchema.extend({
  pinned: z.number().int().min(0),
});

const getNoteOp = getOperation({
  path: "/notes/:id",
  params: idParams,
  query: z.strictObject({ verbose: z.coerce.boolean().optional() }),
  response: noteSchema,
  meta: z.object({ revision: z.number().int() }),
});

const getSummaryOp = getOperation({
  path: "/notes/summary",
  response: z.object({ total: z.number().int() }),
});

const listNotesOp = listOperation({
  path: "/notes",
  query: paginationQuerySchema.extend({ search: z.string().optional() }),
  item: noteSchema,
  meta: countedMeta,
});

const createNoteOp = postOperation({
  path: "/notes",
  body: titleBody,
  response: noteSchema,
});

const telemetryOp = postOperation({
  path: "/telemetry",
  body: z.strictObject({ event: z.string().min(1) }),
  response: z.object({ accepted: z.boolean() }),
  status: 200,
});

const enqueueOp = postOperation({
  path: "/notes/:id/export",
  params: idParams,
  query: z.strictObject({ format: z.enum(["csv", "json"]).optional() }),
  response: z.object({ jobId: z.string() }),
  meta: z.object({ queuedAt: z.string() }),
  status: 202,
});

const patchNoteOp = patchOperation({
  path: "/notes/:id",
  params: idParams,
  body: titleBody,
  response: noteSchema,
});

const putNoteOp = putOperation({
  path: "/notes/:id",
  params: idParams,
  body: titleBody,
  response: noteSchema,
});

const deleteNoteOp = deleteOperation({
  path: "/notes/:id",
  params: idParams,
  body: reasonBody,
});

const heartbeatOp = postNoContentOperation({
  path: "/devices/:id/heartbeat",
  params: idParams,
  body: z.strictObject({ ok: z.boolean() }),
});

const noopLog: RouteLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const userSubject: SubjectRef = { type: "user", id: "user-1" };

function rawInput(overrides: Partial<RawRouteInput> = {}): RawRouteInput {
  return {
    params: undefined,
    query: undefined,
    body: undefined,
    subject: userSubject,
    requestId: "req-1",
    locale: "en",
    log: noopLog,
    ...overrides,
  };
}

let apps: Awaited<ReturnType<typeof createHttpApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function mountRoutes(routes: readonly RouteBlueprint[]) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  registerRoutes(app, {
    routes: routeGroup("Notes", routes),
    subjects: { resolve: () => Promise.resolve(userSubject) },
    authorization: new FakeAuthorization({}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe("operation-backed routes", () => {
  it("executes getRoute with params, query, response, and meta", async () => {
    const route = getRoute({
      operation: getNoteOp,
      summary: "Get one note",
      access: requireSession(),
      handler: ({ params, query, subject }) => {
        expectTypeOf(params).toEqualTypeOf<{ id: string }>();
        expectTypeOf(query).toEqualTypeOf<{ verbose?: boolean | undefined }>();
        expectTypeOf(subject).toEqualTypeOf<SubjectRef>();
        return {
          data: { id: params.id, title: query.verbose ? "Verbose" : "Brief" },
          meta: { revision: 3 },
        };
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/notes/:id");
    expect(route.status).toBe(200);
    await expect(route.execute(rawInput({ params: { id: "n1" }, query: { verbose: "true" } }))).resolves.toEqual({
      data: { id: "n1", title: "Verbose" },
      meta: { revision: 3 },
    });
  });

  it("preserves GetRouteAccess and scope context on parameterless getOperation", async () => {
    const viewSummary = permissionToken("notes/note", "view");
    const route = getRoute({
      operation: getSummaryOp,
      summary: "Note summary",
      access: requiresScoped(viewSummary),
      handler: ({ scope }) => {
        expectTypeOf(scope).toEqualTypeOf<ScopeAnswer>();
        return { total: 4 };
      },
    });

    const scopeAnswer: ScopeAnswer = {
      resourceType: "notes/note",
      permission: "view",
      plan: { kind: "tag", role: "public" },
      subject: userSubject,
      idsByQuestion: new Map(),
    };
    await expect(route.execute(rawInput({ scope: scopeAnswer }))).resolves.toEqual({ data: { total: 4 } });
  });

  it("executes listRoute with pagination, custom meta, and visibility context", async () => {
    const viewNote = permissionToken("notes/note", "view");
    const route = listRoute({
      operation: listNotesOp,
      summary: "List notes",
      access: requiresVisible(viewNote),
      handler: ({ query, visibleIds }) => {
        expectTypeOf(visibleIds).toEqualTypeOf<readonly string[]>();
        return {
          items: visibleIds.map((id) => ({
            id,
            title: query.search ?? "Untitled",
          })),
          total: visibleIds.length,
          meta: { pinned: 1 },
        };
      },
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/notes");
    await expect(
      route.execute(
        rawInput({
          query: { page: "2", perPage: "10", search: "hello" },
          visibleIds: ["n1"],
        }),
      ),
    ).resolves.toEqual({
      data: [{ id: "n1", title: "hello" }],
      meta: { pinned: 1, total: 1, page: 2, perPage: 10 },
    });
  });

  it("executes postRoute preserving default 201, explicit 202 with meta, and telemetry policy", async () => {
    const created = postRoute({
      operation: createNoteOp,
      summary: "Create note",
      access: requireSession(),
      handler: ({ body }) => ({ id: "n-new", title: body.title }),
    });
    const accepted = postRoute({
      operation: enqueueOp,
      summary: "Export note",
      access: requireSession(),
      handler: ({ params, query }) => ({
        data: { jobId: `${params.id}-${query.format ?? "json"}` },
        meta: { queuedAt: "2026-11-23T00:00:00Z" },
      }),
    });
    const telemetry = postRoute({
      operation: telemetryOp,
      summary: "Ingest telemetry",
      access: publicAccess(),
      resourcePolicy: {
        kind: "resource-free",
        purpose: "append-only-telemetry",
      },
      handler: ({ subject }) => {
        expectTypeOf(subject).toEqualTypeOf<SubjectRef | null>();
        return { accepted: true };
      },
    });

    expect(created.status).toBe(201);
    expect(accepted.status).toBe(202);
    expect(telemetry.status).toBe(200);
    expect(telemetry.resourcePolicy).toEqual({
      kind: "resource-free",
      purpose: "append-only-telemetry",
    });

    await expect(created.execute(rawInput({ body: { title: "Draft" } }))).resolves.toEqual({
      data: { id: "n-new", title: "Draft" },
    });
    await expect(accepted.execute(rawInput({ params: { id: "n1" }, query: { format: "csv" } }))).resolves.toEqual({
      data: { jobId: "n1-csv" },
      meta: { queuedAt: "2026-11-23T00:00:00Z" },
    });
    await expect(telemetry.execute(rawInput({ subject: null, body: { event: "click" } }))).resolves.toEqual({
      data: { accepted: true },
    });
  });

  it("executes patchRoute, putRoute, deleteRoute, and postNoContentRoute over HTTP", async () => {
    const deletedReasons: string[] = [];
    const heartbeats: string[] = [];

    const app = await mountRoutes([
      patchRoute({
        operation: patchNoteOp,
        summary: "Patch note",
        access: requireSession(),
        handler: ({ params, body }) => ({ id: params.id, title: body.title }),
      }),
      putRoute({
        operation: putNoteOp,
        summary: "Replace note",
        access: requireSession(),
        handler: ({ params, body }) => ({ id: params.id, title: body.title }),
      }),
      deleteRoute({
        operation: deleteNoteOp,
        summary: "Delete note",
        access: requireSession(),
        handler: ({ params, body }) => {
          deletedReasons.push(`${params.id}:${body.reason}`);
        },
      }),
      postNoContentRoute({
        operation: heartbeatOp,
        summary: "Device heartbeat",
        access: requireSession(),
        handler: ({ params, body }) => {
          heartbeats.push(`${params.id}:${String(body.ok)}`);
        },
      }),
    ]);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/notes/n1",
      payload: { title: "Patched" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(bodyOf(patchRes)).toEqual({ data: { id: "n1", title: "Patched" } });

    const putRes = await app.inject({
      method: "PUT",
      url: "/notes/n1",
      payload: { title: "Replaced" },
    });
    expect(putRes.statusCode).toBe(200);
    expect(bodyOf(putRes)).toEqual({ data: { id: "n1", title: "Replaced" } });

    const delRes = await app.inject({
      method: "DELETE",
      url: "/notes/n1",
      payload: { reason: "obsolete" },
    });
    expect(delRes.statusCode).toBe(204);
    expect(delRes.body).toBe("");
    expect(deletedReasons).toEqual(["n1:obsolete"]);

    const hbRes = await app.inject({
      method: "POST",
      url: "/devices/d1/heartbeat",
      payload: { ok: true },
    });
    expect(hbRes.statusCode).toBe(204);
    expect(hbRes.body).toBe("");
    expect(heartbeats).toEqual(["d1:true"]);
  });

  it("throws HttpWiringError at runtime when a verb receives a mismatched operation kind", () => {
    const cases: readonly [string, (...args: never[]) => unknown, unknown][] = [
      ["getRoute", getRoute, createNoteOp],
      ["listRoute", listRoute, getNoteOp],
      ["postRoute", postRoute, getNoteOp],
      ["patchRoute", patchRoute, putNoteOp],
      ["putRoute", putRoute, patchNoteOp],
      ["deleteRoute", deleteRoute, heartbeatOp],
      ["postNoContentRoute", postNoContentRoute, deleteNoteOp],
      ["getRoute unknown", getRoute, { kind: "unknown", method: "GET" }],
    ];

    for (const [, verbFn, wrongOp] of cases) {
      expect(() => {
        Reflect.apply(verbFn, undefined, [
          {
            operation: wrongOp,
            summary: "Wrong op",
            access: requireSession(),
            handler: () => undefined,
          },
        ]);
      }).toThrow(HttpWiringError);
    }
  });
});
