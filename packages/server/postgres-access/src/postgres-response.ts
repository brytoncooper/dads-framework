import type { PostgresRow } from "./postgres-types.js";

export function readDecisionFlag(row: PostgresRow | undefined): boolean {
  const value = row?.["allowed"];
  if (typeof value !== "boolean")
    throw new Error("Postgres authorization returned an invalid decision");
  return value;
}

export function readTupleColumn(row: PostgresRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string")
    throw new Error(`Postgres authorization returned invalid ${column}`);
  return value;
}

export function readBooleanColumn(row: PostgresRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean")
    throw new Error(`Postgres authorization returned invalid ${column}`);
  return value;
}
