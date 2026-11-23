import { z } from "zod";

/** The OpenAPI extension that lists an enum's known values without closing it. */
export const EXTENSIBLE_ENUM_KEY = "x-extensible-enum";

/**
 * A string the server sends only from `values`, documented as open-ended:
 * clients skip a value they do not know, so adding one never breaks a build
 * already installed. Its JSON Schema lists the values under
 * `x-extensible-enum` instead of `enum` (see `openExtensibleEnums`), so a
 * contract diff reads an added value as compatible.
 */
export function extensibleEnum<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
  description: string,
) {
  return z.enum(values).meta({ description, [EXTENSIBLE_ENUM_KEY]: [...values] });
}

/**
 * The `override` for `z.toJSONSchema` that leaves an extensible enum open:
 * Zod emits `enum` for every `z.enum`, and a closed `enum` beside
 * `x-extensible-enum` would still tell clients to reject a new value.
 */
export function openExtensibleEnums(context: { readonly jsonSchema: z.core.JSONSchema.BaseSchema }): void {
  if (EXTENSIBLE_ENUM_KEY in context.jsonSchema) {
    delete context.jsonSchema.enum;
  }
}
