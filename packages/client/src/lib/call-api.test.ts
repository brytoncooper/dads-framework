/**
 * What: callApi and createApiClient dispatch all seven standalone operation
 * contract kinds with client-side validation and exact inferred types.
 * Why: callers should share one operation contract between server and client
 * without hand-wiring verbs, routes, or envelope parsing at every call site.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

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

import type { ApiPage, ApiPageWithMeta } from "./api-verbs.js";
import { callApi, createApiClient, type ApiDataWithMeta } from "./call-api.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });
const idParams = z.strictObject({ id: z.string().min(1) });
const titleBody = z.strictObject({ title: z.string().min(1) });
const countedMetaSchema = paginationMetaSchema.extend({
  pinned: z.number().int().min(0),
});

const statusOp = getOperation({
  path: "/status",
  response: z.object({ ok: z.boolean() }),
});

const getNoteOp = getOperation({
  path: "/notes/:id",
  params: idParams,
  query: z.strictObject({ verbose: z.boolean().optional() }),
  response: noteSchema,
});

const getNoteWithMetaOp = getOperation({
  path: "/notes/:id/detail",
  params: idParams,
  response: noteSchema,
  meta: z.object({ revision: z.number().int() }),
});

const listNotesOp = listOperation({
  path: "/notes",
  query: paginationQuerySchema,
  item: noteSchema,
});

const listFilteredNotesOp = listOperation({
  path: "/tenants/:tenantId/notes",
  params: z.strictObject({ tenantId: z.string().min(1) }),
  query: paginationQuerySchema.extend({ status: z.enum(["open", "closed"]) }),
  item: noteSchema,
  meta: countedMetaSchema,
});

const createNoteOp = postOperation({
  path: "/notes",
  body: titleBody,
  response: noteSchema,
});

const triggerSyncOp = postOperation({
  path: "/sync",
  response: z.object({ started: z.boolean() }),
  status: 202,
});

const exportNoteOp = postOperation({
  path: "/notes/:id/export",
  params: idParams,
  query: z.strictObject({ format: z.enum(["csv", "json"]) }),
  body: z.strictObject({ includeDeleted: z.boolean() }),
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
  body: z.strictObject({ reason: z.string().min(1) }),
});

const clearSessionOp = deleteOperation({
  path: "/session",
});

const heartbeatOp = postNoContentOperation({
  path: "/devices/:id/heartbeat",
  params: idParams,
  body: z.strictObject({ ok: z.boolean() }),
});

const pingOp = postNoContentOperation({
  path: "/ping",
});

type FetchCall = { url: string; init: RequestInit };
const calls: FetchCall[] = [];

function respondWith(status: number, body: unknown): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

function respondWithNoContent(): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
}

function lastCall(): FetchCall {
  const call = calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  return call;
}

function headerOf(name: string): string | undefined {
  const headers = lastCall().init.headers;
  if (headers === undefined || headers instanceof Headers) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callApi", () => {
  it("supports parameterless GET without an input argument and forwards signal/headers", async () => {
    respondWith(200, { data: { ok: true } });
    const status = await callApi(statusOp);
    expect(status).toEqual({ ok: true });
    expect(lastCall().url).toBe("/api/status");
    expect(lastCall().init.method).toBe("GET");
    expectTypeOf(status).toEqualTypeOf<{ ok: boolean }>();

    const controller = new AbortController();
    await callApi(statusOp, {
      signal: controller.signal,
      headers: { "X-Custom-Trace": "abc" },
    });
    expect(lastCall().init.signal).toBe(controller.signal);
    expect(headerOf("X-Custom-Trace")).toBe("abc");
  });

  it("URL-encodes :params and serializes optional query on GET", async () => {
    respondWith(200, { data: { id: "a/b", title: "Encoded" } });
    const note = await callApi(getNoteOp, {
      params: { id: "a/b" },
      query: { verbose: true },
    });

    expect(note).toEqual({ id: "a/b", title: "Encoded" });
    expect(lastCall().url).toBe("/api/notes/a%2Fb?verbose=true");
  });

  it("parses both data and meta on GET operations with meta", async () => {
    respondWith(200, {
      data: { id: "n1", title: "Hello" },
      meta: { revision: 4 },
    });
    const result = await callApi(getNoteWithMetaOp, { params: { id: "n1" } });

    expect(result).toEqual({
      data: { id: "n1", title: "Hello" },
      meta: { revision: 4 },
    });
    expectTypeOf(result).toEqualTypeOf<ApiDataWithMeta<{ id: string; title: string }, { revision: number }>>();

    respondWith(200, {
      data: { id: "n1", title: "Hello" },
      meta: { revision: "bad" },
    });
    await expect(callApi(getNoteWithMetaOp, { params: { id: "n1" } })).rejects.toThrow();
  });

  it("calls listOperation with default pagination and with custom meta", async () => {
    respondWith(200, {
      data: [{ id: "n1", title: "First" }],
      meta: { total: 1, page: 1, perPage: 25 },
    });
    const page = await callApi(listNotesOp);
    expect(page).toEqual({
      items: [{ id: "n1", title: "First" }],
      meta: { total: 1, page: 1, perPage: 25 },
    });
    expect(lastCall().url).toBe("/api/notes?page=1&perPage=25");
    expectTypeOf(page).toEqualTypeOf<ApiPage<{ id: string; title: string }>>();

    respondWith(200, {
      data: [{ id: "n2", title: "Pinned" }],
      meta: { total: 3, page: 2, perPage: 10, pinned: 1 },
    });
    const filtered = await callApi(listFilteredNotesOp, {
      params: { tenantId: "org/1" },
      query: { page: 2, perPage: 10, status: "open" },
    });
    expect(filtered).toEqual({
      items: [{ id: "n2", title: "Pinned" }],
      meta: { total: 3, page: 2, perPage: 10, pinned: 1 },
    });
    expect(lastCall().url).toBe("/api/tenants/org%2F1/notes?page=2&perPage=10&status=open");
    expectTypeOf(filtered).toEqualTypeOf<
      ApiPageWithMeta<{ id: string; title: string }, { total: number; page: number; perPage: number; pinned: number }>
    >();
  });

  it("calls postOperation with body, parameterless, and with meta", async () => {
    respondWith(201, { data: { id: "n3", title: "Created" } });
    const created = await callApi(createNoteOp, {
      body: { title: "Created" },
    });
    expect(created).toEqual({ id: "n3", title: "Created" });
    expect(lastCall().init.method).toBe("POST");
    expect(lastCall().init.body).toBe(JSON.stringify({ title: "Created" }));

    respondWith(202, { data: { started: true } });
    const started = await callApi(triggerSyncOp);
    expect(started).toEqual({ started: true });
    expect(lastCall().url).toBe("/api/sync");

    respondWith(202, {
      data: { jobId: "j1" },
      meta: { queuedAt: "2026-11-23T00:00:00Z" },
    });
    const exported = await callApi(exportNoteOp, {
      params: { id: "n3" },
      query: { format: "csv" },
      body: { includeDeleted: false },
    });
    expect(exported).toEqual({
      data: { jobId: "j1" },
      meta: { queuedAt: "2026-11-23T00:00:00Z" },
    });
    expect(lastCall().url).toBe("/api/notes/n3/export?format=csv");
    expect(lastCall().init.body).toBe(JSON.stringify({ includeDeleted: false }));
    expectTypeOf(exported).toEqualTypeOf<ApiDataWithMeta<{ jobId: string }, { queuedAt: string }>>();
  });

  it("calls patchOperation and putOperation", async () => {
    respondWith(200, { data: { id: "n1", title: "Patched" } });
    const patched = await callApi(patchNoteOp, {
      params: { id: "n1" },
      body: { title: "Patched" },
    });
    expect(patched).toEqual({ id: "n1", title: "Patched" });
    expect(lastCall().init.method).toBe("PATCH");
    expect(lastCall().url).toBe("/api/notes/n1");

    respondWith(200, { data: { id: "n1", title: "Replaced" } });
    const replaced = await callApi(putNoteOp, {
      params: { id: "n1" },
      body: { title: "Replaced" },
    });
    expect(replaced).toEqual({ id: "n1", title: "Replaced" });
    expect(lastCall().init.method).toBe("PUT");
  });

  it("calls deleteOperation and postNoContentOperation expecting 204", async () => {
    respondWithNoContent();
    const delPromise = callApi(deleteNoteOp, {
      params: { id: "n1" },
      body: { reason: "obsolete" },
    });
    expectTypeOf(delPromise).toEqualTypeOf<Promise<void>>();
    await expect(delPromise).resolves.toBeUndefined();
    expect(lastCall().init.method).toBe("DELETE");
    expect(lastCall().url).toBe("/api/notes/n1");
    expect(lastCall().init.body).toBe(JSON.stringify({ reason: "obsolete" }));

    await callApi(clearSessionOp);
    expect(lastCall().init.method).toBe("DELETE");
    expect(lastCall().url).toBe("/api/session");

    const hbPromise = callApi(heartbeatOp, {
      params: { id: "d1" },
      body: { ok: true },
    });
    expectTypeOf(hbPromise).toEqualTypeOf<Promise<void>>();
    await expect(hbPromise).resolves.toBeUndefined();
    expect(lastCall().init.method).toBe("POST");
    expect(lastCall().url).toBe("/api/devices/d1/heartbeat");

    await callApi(pingOp);
    expect(lastCall().init.method).toBe("POST");
    expect(lastCall().url).toBe("/api/ping");
  });

  it("fails client-side Zod validation before calling fetch", async () => {
    respondWith(200, { data: { id: "n1", title: "Never reached" } });

    await expect(callApi(getNoteOp, { params: { id: "" } })).rejects.toThrow();
    await expect(callApi(listNotesOp, { query: { page: 0 } })).rejects.toThrow();
    await expect(callApi(createNoteOp, { body: { title: "" } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("createApiClient", () => {
  it("composes a frozen typed client from any subset of operations", async () => {
    const notesClient = createApiClient({
      status: statusOp,
      list: listNotesOp,
      get: getNoteOp,
      create: createNoteOp,
      remove: deleteNoteOp,
    });

    expect(Object.isFrozen(notesClient)).toBe(true);

    respondWith(200, { data: { ok: true } });
    await expect(notesClient.status()).resolves.toEqual({ ok: true });

    respondWith(200, { data: { id: "n1", title: "Read" } });
    await expect(notesClient.get({ params: { id: "n1" } })).resolves.toEqual({
      id: "n1",
      title: "Read",
    });

    respondWithNoContent();
    await expect(
      notesClient.remove({
        params: { id: "n1" },
        body: { reason: "cleanup" },
      }),
    ).resolves.toBeUndefined();
  });
});
