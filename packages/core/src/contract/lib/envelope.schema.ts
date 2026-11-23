import { z } from "zod";

/**
 * Success envelope around a resource schema (api-conventions.md).
 * Contract libs build responses from these helpers so the envelope cannot drift.
 */
export function apiResponseSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    data: dataSchema.meta({ description: "The requested resource" }),
    meta: z.record(z.string(), z.unknown()).optional().meta({
      description:
        "Response metadata only (totals, cursors, warnings) — never business data",
    }),
  });
}

export type ApiResponse<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

/** Failure envelope. Clients branch on `error.code`, never on `message`. */
// response-shape: strip undeclared implementation fields from the failure envelope.
export const apiErrorSchema = z.object({
  // response-shape: only documented diagnostic fields belong in the error body.
  error: z.object({
    code: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .meta({
        description:
          "Stable SCREAMING_SNAKE error identifier — clients branch on this, never on message",
      }),
    message: z.string().meta({
      description: "Human-readable explanation; wording may change freely",
    }),
    details: z.record(z.string(), z.unknown()).optional().meta({
      description:
        "Optional structured context, e.g. per-field validation issues",
    }),
    requestId: z.string().optional().meta({
      description: "Correlation id echoed for support/debugging (500s)",
    }),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
