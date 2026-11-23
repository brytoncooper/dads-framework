import type { z } from "zod";

/**
 * Thin identity token for an authorization entity: the persisted wire name
 * and its id schema. Created internally by `actor()` and `resource()`.
 */
export type EntityHandle<WireName extends string = string, Id extends string = string> = {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<Id>;
};

/**
 * Internal helper to mint an entity handle for an actor or resource.
 */
export function entityHandle<WireName extends string, Id extends string = string>(spec: {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<Id>;
}): EntityHandle<WireName, Id> {
  return {
    wireName: spec.wireName,
    idSchema: spec.idSchema,
  };
}
