/**
 * Compile-time invariants for callApi and createApiClient input requirements.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getOperation,
  listOperation,
  paginationMetaSchema,
  paginationQuerySchema,
  patchOperation,
} from "@dads-framework/core/contract";

import { callApi, createApiClient } from "../call-api.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });
const idParams = z.strictObject({ id: z.string().min(1) });
const titleBody = z.strictObject({ title: z.string().min(1) });

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

const listFilteredNotesOp = listOperation({
  path: "/tenants/:tenantId/notes",
  params: z.strictObject({ tenantId: z.string().min(1) }),
  query: paginationQuerySchema.extend({ status: z.enum(["open", "closed"]) }),
  item: noteSchema,
  meta: paginationMetaSchema.extend({ pinned: z.number().int().min(0) }),
});

const patchNoteOp = patchOperation({
  path: "/notes/:id",
  params: idParams,
  body: titleBody,
  response: noteSchema,
});

describe("callApi and createApiClient type invariants", () => {
  it("enforces required input fields at compile time", () => {
    const notesClient = createApiClient({
      get: getNoteOp,
      listFiltered: listFilteredNotesOp,
      patch: patchNoteOp,
      status: statusOp,
    });

    const compileChecks = async (): Promise<void> => {
      // @ts-expect-error getNoteOp requires params
      await callApi(getNoteOp);
      // @ts-expect-error getNoteOp requires params
      await notesClient.get();
      // @ts-expect-error listFilteredNotesOp requires params and status query
      await notesClient.listFiltered({ params: { tenantId: "t1" } });
      // @ts-expect-error patchNoteOp requires body
      await notesClient.patch({ params: { id: "n1" } });
      await notesClient.status();
    };

    expect(typeof compileChecks).toBe("function");
  });
});
