/** Stable code for callers translating a serialization conflict at their boundary. */
export const POSTGRES_CONFLICT = "POSTGRES_CONFLICT";

/** PostgreSQL aborted the attempt. Retrying requires a fresh complete transaction. */
export class PostgresSerializationConflict extends Error {
  readonly code = POSTGRES_CONFLICT;
  readonly retryable = true;

  constructor(cause: unknown) {
    super("Postgres serialization conflict; retry the complete transaction.", {
      cause,
    });
    this.name = "PostgresSerializationConflict";
  }
}

/** Also applies at an outer transaction boundary that owns the final COMMIT. */
export function readPostgresSerializationConflict(error: unknown): PostgresSerializationConflict | undefined {
  if (error instanceof PostgresSerializationConflict) return error;
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if ("code" in current && current.code === "40001") {
      return new PostgresSerializationConflict(error);
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
