/**
 * Describe the foreign key a write violated, for tests that prove a reference
 * is database-enforced rather than merely intended.
 *
 * Two things make the obvious assertion wrong, and both fail misleadingly.
 *
 * `rejects.toThrow(/foreign key/i)` does not work: drizzle catches the driver
 * error and rethrows its own, whose message is only `Failed query: insert into
 * …`. The assertion then fails against a database that refused the write
 * exactly as it should have, and the reader concludes the constraint is
 * missing. So the driver's error is unwrapped from the `cause` chain and
 * matched on SQLSTATE `23503` (`foreign_key_violation`) — a code, not prose.
 *
 * Asserting the constraint NAME does not work either, and this one is a trap
 * worth naming: Postgres identifiers are capped at 63 characters, and drizzle's
 * generated name for, say, `order_facility_authorizations.order_id` against
 * `orders` runs well past it. Postgres truncates it SILENTLY, so the
 * stored name ends mid-word and a test asserting the full name fails with two
 * strings that look identical in the diff.
 *
 * So the tables are reported instead — which child table refused the row, and
 * which parent it could not find. That is the relationship the test is actually
 * about, it survives truncation, and it reads as the rule rather than as a
 * string. The truncated `constraint` comes along for anyone who needs to find
 * the constraint in `pg_constraint`.
 */
const FOREIGN_KEY_VIOLATION = "23503";

/** Postgres phrasing: `Key (facility_id)=(…) is not present in table "x".` */
const PARENT_TABLE = /is not present in table "([^"]+)"/;

export type ForeignKeyRefusal = {
  /** The table the refused row was being written to. */
  readonly childTable: string;
  /** The table the referenced key was missing from. */
  readonly parentTable: string;
  /** As Postgres stores it — truncated to 63 characters when longer. */
  readonly constraint: string;
};

/**
 * Awaits a write expected to be refused and describes the refusal. Throws if
 * the write succeeded, or failed for any reason other than a foreign key.
 */
export async function violatedForeignKey(
  write: PromiseLike<unknown>,
): Promise<ForeignKeyRefusal> {
  try {
    await write;
  } catch (error) {
    const refusal = foreignKeyRefusalIn(error);
    if (refusal !== undefined) return refusal;
    throw error;
  }
  throw new Error(
    "expected the write to be refused by a foreign key, but it was accepted",
  );
}

/** Walks the `cause` chain — drizzle wraps the driver error one level down. */
function foreignKeyRefusalIn(error: unknown): ForeignKeyRefusal | undefined {
  let current = error;
  while (current !== null && current !== undefined) {
    const refusal = readRefusal(current);
    if (refusal !== undefined) return refusal;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function readRefusal(value: unknown): ForeignKeyRefusal | undefined {
  if (readStringField(value, "code") !== FOREIGN_KEY_VIOLATION)
    return undefined;

  const childTable = readStringField(value, "table");
  const constraint = readStringField(value, "constraint");
  const parentTable = PARENT_TABLE.exec(readStringField(value, "detail") ?? "");
  if (
    childTable === undefined ||
    constraint === undefined ||
    parentTable?.[1] === undefined
  ) {
    return undefined;
  }
  return { childTable, parentTable: parentTable[1], constraint };
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!(field in value)) return undefined;
  const found: unknown = Reflect.get(value, field);
  return typeof found === "string" ? found : undefined;
}
