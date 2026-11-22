import type { PostgresQueryResult } from "./postgres-types.js";

const DRIZZLE_ENTITY_KIND = Symbol.for("drizzle:entityKind");

/** Structural Drizzle SQL wrapper shape without importing `drizzle-orm`. */
export type DrizzleQueryLike = {
  getSQL(): unknown;
};

/** Minimal structural Drizzle execute boundary (`PgTransaction` and `NodePgDatabase` satisfy this). */
export type DrizzleExecuteLike = {
  execute(query: DrizzleQueryLike | string): PromiseLike<PostgresQueryResult>;
};

/** Minimal structural Drizzle transaction options boundary. */
export type DrizzleTransactionConfigLike = {
  readonly isolationLevel?:
    "read uncommitted" | "read committed" | "repeatable read" | "serializable";
};

/** Minimal structural Drizzle database boundary (`NodePgDatabase` satisfies this). */
export type DrizzleDatabaseLike<
  Tx extends DrizzleExecuteLike = DrizzleExecuteLike,
> = {
  transaction<Result>(
    work: (tx: Tx) => Promise<Result>,
    config?: DrizzleTransactionConfigLike,
  ): Promise<Result>;
};

/**
 * Detect a Drizzle `PgTransaction` instance via Drizzle's well-known
 * `Symbol.for("drizzle:entityKind")` metadata without loading `drizzle-orm`.
 */
export function isDrizzlePgTransaction(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  let proto: object | null = Reflect.getPrototypeOf(value);
  while (proto !== null) {
    const ctorDescriptor = Object.getOwnPropertyDescriptor(
      proto,
      "constructor",
    );
    const ctor: unknown = ctorDescriptor?.value;
    if (typeof ctor === "function") {
      const kindDescriptor = Object.getOwnPropertyDescriptor(
        ctor,
        DRIZZLE_ENTITY_KIND,
      );
      if (kindDescriptor?.value === "PgTransaction") return true;
    }
    proto = Reflect.getPrototypeOf(proto);
  }
  return false;
}
