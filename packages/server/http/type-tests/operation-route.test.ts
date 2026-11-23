/**
 * Compile-time checks proving verb route helpers refuse mismatched operation
 * contract kinds and forbidden access/resource policies.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { permissionToken } from "@dads-framework/access";
import {
  getOperation,
  patchOperation,
  postNoContentOperation,
  postOperation,
  putOperation,
} from "@dads-framework/core/contract";

import {
  deleteRoute,
  fromParam,
  getRoute,
  patchRoute,
  postRoute,
  publicAccess,
  putRoute,
  requireSession,
  requires,
  requiresScoped,
} from "../src/index.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });
const idParams = z.strictObject({ id: z.string().min(1) });
const titleBody = z.strictObject({ title: z.string().min(1) });

const getNoteOp = getOperation({
  path: "/notes/:id",
  params: idParams,
  query: z.strictObject({ verbose: z.coerce.boolean().optional() }),
  response: noteSchema,
  meta: z.object({ revision: z.number().int() }),
});

const createNoteOp = postOperation({
  path: "/notes",
  body: titleBody,
  response: noteSchema,
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

const heartbeatOp = postNoContentOperation({
  path: "/heartbeat",
});

describe("operation route type invariants", () => {
  it("rejects mismatched operation kinds and forbidden policies at compile time", () => {
    const viewNote = permissionToken("notes/note", "view");
    const compileChecks = (): void => {
      getRoute({
        // @ts-expect-error getRoute refuses postOperation
        operation: createNoteOp,
        summary: "Wrong",
        access: requireSession(),
        handler: () => ({ id: "1", title: "x" }),
      });

      getRoute({
        operation: getNoteOp,
        summary: "Scoped GET with :id is forbidden",
        // @ts-expect-error parameterized GET cannot use requiresScoped
        access: requiresScoped(viewNote),
        handler: () => ({
          data: { id: "1", title: "x" },
          meta: { revision: 1 },
        }),
      });

      patchRoute({
        // @ts-expect-error patchRoute refuses putOperation
        operation: putNoteOp,
        summary: "Wrong",
        access: requireSession(),
        handler: () => ({ id: "1", title: "x" }),
      });

      putRoute({
        // @ts-expect-error putRoute refuses patchOperation
        operation: patchNoteOp,
        summary: "Wrong",
        access: requireSession(),
        handler: () => ({ id: "1", title: "x" }),
      });

      deleteRoute({
        // @ts-expect-error deleteRoute refuses postNoContentOperation
        operation: heartbeatOp,
        summary: "Wrong",
        access: requireSession(),
        handler: () => undefined,
      });

      postRoute({
        operation: createNoteOp,
        summary: "201 POST cannot use resource-free telemetry policy",
        access: publicAccess(),
        // @ts-expect-error status is 201, not 200
        resourcePolicy: {
          kind: "resource-free",
          purpose: "append-only-telemetry",
        },
        handler: () => ({ id: "1", title: "x" }),
      });

      getRoute({
        operation: getNoteOp,
        summary: "requires permission access works",
        access: requires(viewNote, fromParam("id")),
        handler: ({ params }) => ({
          data: { id: params.id, title: "ok" },
          meta: { revision: 1 },
        }),
      });
    };

    expect(typeof compileChecks).toBe("function");
  });
});
