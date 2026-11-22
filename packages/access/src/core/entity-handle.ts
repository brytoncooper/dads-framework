import type { z } from "zod";

/**
 * Thin identity token for an authorization entity: the persisted wire name
 * and its id schema. Created internally by `actor()` and `resource()`.
 */
export type EntityHandle<WireName extends string = string> = {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
};

/**
 * Internal helper to mint an entity handle for an actor or resource.
 */
export function entityHandle<WireName extends string>(spec: {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
}): EntityHandle<WireName> {
  return {
    wireName: spec.wireName,
    idSchema: spec.idSchema,
  };
}
