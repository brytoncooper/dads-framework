export type SqliteValue = string | number | bigint | null;

export type SqliteRow = Readonly<Record<string, unknown>>;

export type SqliteRunResult = {
  readonly changes: number | bigint;
};

export type SqliteQuery = {
  readonly sql: string;
  readonly params: readonly SqliteValue[];
};

/** Read a SQLite integer/boolean decision column (`allowed`) safely. */
export function readDecisionFlag(row: SqliteRow | undefined): boolean {
  const value = row?.["allowed"];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  throw new Error("SQLite authorization returned an invalid decision");
}

/** Read a required string column from a SQLite result row. */
export function readStringColumn(
  row: SqliteRow | undefined,
  column: string,
): string {
  const value = row?.[column];
  if (typeof value !== "string") {
    throw new Error(`SQLite authorization returned an invalid ${column}`);
  }
  return value;
}

/** Read a SQLite integer boolean column (0/1 or boolean). */
export function readBooleanColumn(
  row: SqliteRow | undefined,
  column: string,
): boolean {
  const value = row?.[column];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  throw new Error(`SQLite authorization returned an invalid ${column}`);
}
