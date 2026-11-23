import { z } from "zod";
import { mintUuidV7 } from "./mint-uuid-v7.js";
import { rememberSyncedColumnKind } from "./synced-column-kinds.js";

/**
 * UUID v7 entity id, nominally typed by `brand`.
 *
 * The kit owns construction; the owning domain declares the id. Pass a
 * string literal — a `string`-typed variable collapses every id into one
 * brand. `.meta()` must come before `.brand()`: chaining `.meta()` after a
 * generic `.brand<TBrand>()` silently erases the brand.
 */
export function entityIdSchema<TBrand extends string>(brand: TBrand, description: string) {
  const schema = z.uuidv7().meta({ description }).brand<TBrand>(brand);
  rememberSyncedColumnKind(schema, { kind: "id", idName: brand });
  return schema;
}

/**
 * An id this repo does not mint. Better Auth account ids are v4 today and
 * may not be UUIDs at all through SSO, so a v7 schema would reject real
 * sessions at ingress. The brand still holds; only the format check is relaxed.
 */
export function opaqueIdSchema<TBrand extends string>(brand: TBrand, description: string) {
  const schema = z.string().min(1).meta({ description }).brand<TBrand>(brand);
  rememberSyncedColumnKind(schema, { kind: "id", idName: brand });
  return schema;
}

/**
 * Mint a branded id for an insert (`id: mintEntityId(machineIdSchema)`).
 * The parse produces the brand; a cast would not.
 */
export function mintEntityId<TSchema extends z.ZodType<string, string>>(schema: TSchema): z.output<TSchema> {
  return schema.parse(mintUuidV7());
}
