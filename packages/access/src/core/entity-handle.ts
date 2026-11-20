import type { z } from "zod";

/**
 * How the application's lists are bounded.
 *
 * - `scope` is what a caller is granted on, bounded by business structure
 *   (team, workspace, or permission group), so the set one caller can reach is small.
 * - `catalog` is bounded by equipment or configuration, not daily business
 *   (product types, country codes, or configuration templates).
 *   Its lists may still ask SpiceDB for every visible id; a nightly job audits
 *   each catalog table's size, so the declaration is checked against data.
 * - `record` grows with business activity (documents or messages).
 *   Its lists are filtered through the scopes its roles point at
 *   (`requiresScoped` + `scopeBindings`); asking SpiceDB for every visible
 *   record id is refused.
 *
 * Rule of thumb: if a busy customer could create a thousand of them in a
 * year, it is a `record`.
 */
export type EntityKind = "scope" | "catalog" | "record";

/**
 * Thin identity token for an authorization entity: the persisted wire name,
 * the branded id schema, and optionally its kind. Minted on the domain's
 * access leaf.
 */
export type EntityHandle<WireName extends string = string> = {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly kind?: EntityKind;
};

/**
 * Mint an entity handle. The wire name is the one lawful quoted string for
 * this entity; call sites never repeat it.
 */
export function entityHandle<WireName extends string>(spec: {
  readonly wireName: WireName;
  readonly idSchema: z.ZodType<string>;
  readonly kind?: EntityKind;
}): EntityHandle<WireName> {
  const handle = {
    wireName: spec.wireName,
    idSchema: spec.idSchema,
  };
  if (spec.kind === undefined) {
    return handle;
  }
  return { ...handle, kind: spec.kind };
}
