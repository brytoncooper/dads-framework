import { z } from "zod";

/**
 * What a column PowerSync streams to the phones holds beyond its SQLite type
 * (text, integer or real), so code generated for the phones can type it: a
 * named id, a timestamp, a 0/1 boolean or an exact decimal.
 */
export type SyncedColumnKind =
  | { readonly kind: "id"; readonly idName: string }
  | { readonly kind: "timestamp" }
  | { readonly kind: "boolean" }
  | { readonly kind: "decimal" };

/*
 * Keyed by schema definition, not schema: `.meta()` clones a schema but keeps
 * its definition, so a column declared as `someIdSchema.meta({...})` still
 * reads as that id.
 */
const kindsByDefinition = new WeakMap<object, SyncedColumnKind>();

export function rememberSyncedColumnKind<TSchema extends z.core.$ZodType>(
  schema: TSchema,
  kind: SyncedColumnKind,
): TSchema {
  kindsByDefinition.set(schema._zod.def, kind);
  return schema;
}

/** The kind a column schema was declared with, looking through `.nullable()` and `.optional()`. */
export function syncedColumnKindOf(schema: z.core.$ZodType): SyncedColumnKind | undefined {
  const kind = kindsByDefinition.get(schema._zod.def);
  if (kind !== undefined) return kind;
  if (schema instanceof z.core.$ZodNullable || schema instanceof z.core.$ZodOptional) {
    return syncedColumnKindOf(schema._zod.def.innerType);
  }
  return undefined;
}

/** A Postgres timestamp with time zone as the phone's SQLite stores it: text. */
export function syncedTimestampSchema(description = "Postgres timestamp with time zone as text") {
  return rememberSyncedColumnKind(z.string().meta({ description }), {
    kind: "timestamp",
  });
}

/** A Postgres boolean as the phone's SQLite stores it: 1 for true, 0 for false. */
export function syncedBooleanSchema(description: string) {
  return rememberSyncedColumnKind(z.number().int().min(0).max(1).meta({ description }), { kind: "boolean" });
}

/** A Postgres numeric as the phone's SQLite stores it: text, exactly as stored. */
export function syncedDecimalSchema(description = "Postgres numeric as text, exactly as stored") {
  return rememberSyncedColumnKind(z.string().meta({ description }), {
    kind: "decimal",
  });
}
