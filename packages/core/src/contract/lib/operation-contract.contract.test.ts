/**
 * What: standalone per-operation contracts bind URLs, validate path params, and
 * enforce verb-specific shape invariants at compile time and runtime.
 * Why: sharing one operation contract across server routes and clients requires
 * the contract itself to reject drift before a request is ever sent.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  bindOperationPath,
  deleteOperation,
  getOperation,
  listOperation,
  patchOperation,
  postNoContentOperation,
  postOperation,
  putOperation,
} from "./operation-contract.js";
import type { AnyOperationContract } from "./operation-contract-types.js";
import { paginationMetaSchema, paginationQuerySchema } from "./pagination.schema.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });
const noteBodySchema = z.strictObject({ title: z.string().min(1) });
const noteParamsSchema = z.strictObject({
  tenantId: z.string().min(1),
  noteId: z.string().min(1),
});

describe("bindOperationPath", () => {
  it("keeps static mount-relative paths intact", () => {
    expect(bindOperationPath("/notes")).toBe("/notes");
  });

  it("interpolates and URL-encodes path parameters", () => {
    expect(
      bindOperationPath("/tenants/:tenantId/notes/:noteId", {
        tenantId: "acme/west",
        noteId: "note #1",
      }),
    ).toBe("/tenants/acme%2Fwest/notes/note%20%231");
  });

  it("rejects missing or empty parameter values", () => {
    expect(() => bindOperationPath("/notes/:id")).toThrow(/Missing required path parameter "id"/);
    expect(() => bindOperationPath("/notes/:id", { id: "" })).toThrow(/Missing required path parameter "id"/);
  });

  it("rejects paths that are not single-slash mount-relative", () => {
    expect(() => bindOperationPath("notes")).toThrow(/mount-relative/);
    expect(() => bindOperationPath("//notes")).toThrow(/mount-relative/);
  });
});

describe("operation constructors", () => {
  it("builds frozen getOperation contracts and binds validated params", () => {
    const getNote = getOperation({
      path: "/tenants/:tenantId/notes/:noteId",
      params: noteParamsSchema,
      query: z.strictObject({ includeArchived: z.boolean().optional() }),
      response: noteSchema,
      meta: z.object({ revision: z.number() }),
    });

    expect(Object.isFrozen(getNote)).toBe(true);
    expect(getNote.kind).toBe("get");
    expect(getNote.method).toBe("GET");
    expect(getNote.template).toBe("/tenants/:tenantId/notes/:noteId");
    expect(getNote.path({ tenantId: "t/1", noteId: "n 2" })).toBe("/tenants/t%2F1/notes/n%202");
    expect(getNote.bind({ tenantId: "t1", noteId: "n2" })).toEqual({
      method: "GET",
      template: "/tenants/:tenantId/notes/:noteId",
      path: "/tenants/t1/notes/n2",
    });
    expect(() => getNote.bind({ tenantId: "", noteId: "n2" })).toThrow();
    expectTypeOf(getNote).toExtend<AnyOperationContract>();
  });

  it("binds parameterless operations without arguments", () => {
    const getStatus = getOperation({
      path: "/status",
      response: z.object({ ok: z.boolean() }),
    });

    expect(getStatus.path()).toBe("/status");
    expect(getStatus.bind()).toEqual({
      method: "GET",
      template: "/status",
      path: "/status",
    });
  });

  it("builds listOperation with required paginated query and optional meta", () => {
    const countedMeta = paginationMetaSchema.extend({
      unread: z.number().int().min(0),
    });
    const listNotes = listOperation({
      path: "/tenants/:tenantId/notes",
      params: z.strictObject({ tenantId: z.string().min(1) }),
      query: paginationQuerySchema.extend({ search: z.string().optional() }),
      item: noteSchema,
      meta: countedMeta,
    });

    expect(Object.isFrozen(listNotes)).toBe(true);
    expect(listNotes.kind).toBe("list");
    expect(listNotes.method).toBe("GET");
    expect(listNotes.item).toBe(noteSchema);
    expect(listNotes.meta).toBe(countedMeta);
    expect(listNotes.bind({ tenantId: "t1" }).path).toBe("/tenants/t1/notes");
    expectTypeOf(listNotes).toExtend<AnyOperationContract>();
  });

  it("builds postOperation defaulting to 201 and preserving explicit 200/202", () => {
    const createNote = postOperation({
      path: "/notes",
      body: noteBodySchema,
      response: noteSchema,
    });
    const runReport = postOperation({
      path: "/notes/report",
      response: z.object({ count: z.number() }),
      status: 200,
    });
    const enqueueSync = postOperation({
      path: "/notes/sync",
      response: z.object({ jobId: z.string() }),
      status: 202,
    });

    expect(createNote.kind).toBe("post");
    expect(createNote.method).toBe("POST");
    expect(createNote.status).toBe(201);
    expect(runReport.status).toBe(200);
    expect(enqueueSync.status).toBe(202);
    expectTypeOf(createNote).toExtend<AnyOperationContract>();
    expectTypeOf(runReport).toExtend<AnyOperationContract>();
  });

  it("builds patchOperation and putOperation with required bodies", () => {
    const patchNote = patchOperation({
      path: "/notes/:id",
      params: z.strictObject({ id: z.string().min(1) }),
      body: noteBodySchema,
      response: noteSchema,
    });
    const putNote = putOperation({
      path: "/notes/:id",
      params: z.strictObject({ id: z.string().min(1) }),
      body: noteBodySchema,
      response: noteSchema,
    });

    expect(patchNote.kind).toBe("patch");
    expect(patchNote.method).toBe("PATCH");
    expect(patchNote.bind({ id: "a/b" }).path).toBe("/notes/a%2Fb");

    expect(putNote.kind).toBe("put");
    expect(putNote.method).toBe("PUT");
    expect(putNote.bind({ id: "a/b" }).path).toBe("/notes/a%2Fb");
    expectTypeOf(patchNote).toExtend<AnyOperationContract>();
    expectTypeOf(putNote).toExtend<AnyOperationContract>();
  });

  it("builds deleteOperation and postNoContentOperation without response schemas", () => {
    const deleteNote = deleteOperation({
      path: "/notes/:id",
      params: z.strictObject({ id: z.string().min(1) }),
      body: z.strictObject({ reason: z.string().min(1) }),
    });
    const heartbeat = postNoContentOperation({
      path: "/heartbeat",
    });

    expect(deleteNote.kind).toBe("delete");
    expect(deleteNote.method).toBe("DELETE");
    expect("response" in deleteNote).toBe(false);
    expect(deleteNote.bind({ id: "n1" }).path).toBe("/notes/n1");

    expect(heartbeat.kind).toBe("post-no-content");
    expect(heartbeat.method).toBe("POST");
    expect("response" in heartbeat).toBe(false);
    expect(heartbeat.bind()).toEqual({
      method: "POST",
      template: "/heartbeat",
      path: "/heartbeat",
    });
    expectTypeOf(deleteNote).toExtend<AnyOperationContract>();
    expectTypeOf(heartbeat).toExtend<AnyOperationContract>();
  });

  it("rejects malformed paths and missing params schemas at runtime", () => {
    expect(() => {
      Reflect.apply(getOperation, undefined, [{ path: "notes", response: noteSchema }]);
    }).toThrow(/mount-relative/);
    expect(() => {
      Reflect.apply(getOperation, undefined, [{ path: "/notes/:id", response: noteSchema }]);
    }).toThrow(/requires a params schema/);
  });
});
