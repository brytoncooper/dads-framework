/**
 * Compile-time invariants for standalone per-operation contracts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  deleteOperation,
  getOperation,
  listOperation,
  patchOperation,
  postNoContentOperation,
  putOperation,
} from "../operation-contract.js";

const noteSchema = z.object({ id: z.string(), title: z.string() });

describe("operation contract type invariants", () => {
  it("enforces verb invariants at compile time", () => {
    const compileChecks = (): void => {
      getOperation({
        path: "/notes",
        // @ts-expect-error collections use listOperation — arrays refused
        response: z.array(noteSchema),
      });

      listOperation({
        path: "/notes",
        item: noteSchema,
        // @ts-expect-error query must produce { page: number; perPage: number }
        query: z.strictObject({ search: z.string().optional() }),
      });

      patchOperation(
        // @ts-expect-error patchOperation requires body
        {
          path: "/notes",
          response: noteSchema,
        },
      );

      putOperation(
        // @ts-expect-error putOperation requires body
        {
          path: "/notes",
          response: noteSchema,
        },
      );

      deleteOperation({
        path: "/notes/:id",
        params: z.strictObject({ id: z.string() }),
        // @ts-expect-error deleteOperation has no response
        response: noteSchema,
      });

      postNoContentOperation({
        path: "/heartbeat",
        // @ts-expect-error postNoContentOperation has no response
        response: noteSchema,
      });

      // @ts-expect-error :id template requires matching params schema
      getOperation({
        path: "/notes/:id",
        response: noteSchema,
      });

      getOperation({
        path: "/notes/:id",
        // @ts-expect-error params schema must cover :id
        params: z.strictObject({ wrongKey: z.string() }),
        response: noteSchema,
      });

      getOperation({
        // @ts-expect-error path must start with "/"
        path: "notes",
        response: noteSchema,
      });
    };

    expect(typeof compileChecks).toBe("function");
  });
});
