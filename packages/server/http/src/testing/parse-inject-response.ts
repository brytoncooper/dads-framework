import { z } from "zod";

/**
 * Typed access to `app.inject()` responses. light-my-request's `json()`
 * returns `any`; these helpers parse the body once with Zod instead, so
 * tests get real types and the `no-unsafe-*` walls stay green
 * (docs/architecture/type-safety.md — parse at the boundary, tests
 * included).
 */

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.looseObject({}).optional(),
    requestId: z.string().optional(),
  }),
});

export type InjectedResponse = { readonly body: string };

function jsonOf(response: InjectedResponse): unknown {
  return JSON.parse(response.body);
}

/** Parses an error response into its typed `error` envelope. */
export function errorBodyOf(response: InjectedResponse): z.output<typeof errorEnvelopeSchema>["error"] {
  return errorEnvelopeSchema.parse(jsonOf(response)).error;
}

const dataEnvelopeSchema = z.object({ data: z.unknown() });
const listEnvelopeSchema = z.object({ data: z.unknown(), meta: z.unknown() });

/** Parses a success envelope's `data` against the route's schema. */
export function dataBodyOf<Schema extends z.ZodType>(response: InjectedResponse, schema: Schema): z.output<Schema> {
  return schema.parse(dataEnvelopeSchema.parse(jsonOf(response)).data);
}

/** Parses a `{ data, meta }` envelope against both route schemas. */
export function listBodyOf<DataSchema extends z.ZodType, MetaSchema extends z.ZodType>(
  response: InjectedResponse,
  data: DataSchema,
  meta: MetaSchema,
): { data: z.output<DataSchema>; meta: z.output<MetaSchema> } {
  const envelope = listEnvelopeSchema.parse(jsonOf(response));
  return { data: data.parse(envelope.data), meta: meta.parse(envelope.meta) };
}

/** The raw parsed body for whole-shape assertions (`toEqual`/`toMatchObject`). */
export function bodyOf(response: InjectedResponse): unknown {
  return jsonOf(response);
}
