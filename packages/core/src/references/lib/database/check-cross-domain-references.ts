/**
 * The Postgres half of the checker: LEFT JOIN every registered reference to
 * the key it claims to point at, and report the values that match nothing.
 *
 * The engine knows no table names. Everything it runs comes from the registry,
 * so adding a domain is adding rows (detection wall).
 */
import { SAMPLE_LIMIT } from "../cross-domain-reference.js";
import type {
  CrossDomainReference,
  DanglingReferenceFinding,
  ReferenceFilter,
} from "../cross-domain-reference.js";

/** Executes the reconciliation query through an application-owned connection. */
export type CrossDomainReferenceQueryClient = {
  query(
    text: string,
    values: string[],
  ): Promise<{ readonly rows: readonly unknown[] }>;
};

/** One dangling value and how often it occurs, as the grouped query returns it. */
type DanglingValue = {
  readonly value: string;
  readonly occurrences: number;
};

const REFERENCING = "referencing";
const REFERENCED = "referenced";
const DISCRIMINATOR = "discriminator";
const ELEMENT = "element";

/** Postgres identifiers this repo writes: lower snake case, nothing exotic. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Every registered reference, checked against one database.
 *
 * References are checked for EXISTENCE. A row naming a soft-deleted
 * organization or facility is not dangling — ADR-0023 keeps referenced
 * registry rows archived rather than removed, and status/scope validation
 * belongs to the accepting mutation, not to reconciliation.
 */
export async function checkCrossDomainReferences(
  pool: CrossDomainReferenceQueryClient,
  references: readonly CrossDomainReference[],
): Promise<readonly DanglingReferenceFinding[]> {
  const findings: DanglingReferenceFinding[] = [];
  for (const reference of references) {
    const dangling = await findDanglingValues(pool, reference);
    if (dangling.length === 0) continue;
    findings.push({
      reference,
      rows: dangling.reduce((total, row) => total + row.occurrences, 0),
      distinctValues: dangling.length,
      sampleIds: dangling.slice(0, SAMPLE_LIMIT).map((row) => row.value),
    });
  }
  return findings;
}

/**
 * One reference's dangling values, worst count first.
 *
 * A failure here is never swallowed: a table or column the registry names but
 * the database does not have is itself a finding about the registry, and it
 * has to say which row went stale.
 */
async function findDanglingValues(
  pool: CrossDomainReferenceQueryClient,
  reference: CrossDomainReference,
): Promise<readonly DanglingValue[]> {
  const { text, values } = buildDanglingValueQuery(reference);
  let rows: readonly unknown[];
  try {
    ({ rows } = await pool.query(text, [...values]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `reference \`${reference.id}\` could not be checked — the registry names something this database does not have: ${detail}`,
      { cause: error },
    );
  }
  return rows.map((row) => parseDanglingValue(row, reference.id));
}

function parseDanglingValue(row: unknown, referenceId: string): DanglingValue {
  if (
    typeof row === "object" &&
    row !== null &&
    "value" in row &&
    typeof row.value === "string" &&
    "occurrences" in row &&
    typeof row.occurrences === "number" &&
    Number.isInteger(row.occurrences) &&
    row.occurrences > 0
  ) {
    return { value: row.value, occurrences: row.occurrences };
  }
  throw new Error(
    `Reference ${referenceId} returned an invalid reconciliation row`,
  );
}

/** The LEFT JOIN anti-join for one reference, with its filter values bound. */
export function buildDanglingValueQuery(reference: CrossDomainReference): {
  readonly text: string;
  readonly values: readonly string[];
} {
  const consumerColumn = `${REFERENCING}.${quote(reference.consumerColumn)}`;
  // An array column is checked one element at a time: each element is a
  // reference of its own, and an empty array contributes no rows at all.
  const referencingColumn = reference.consumerHoldsMany
    ? `${ELEMENT}."value"`
    : consumerColumn;
  const unnestElements = reference.consumerHoldsMany
    ? `\n  CROSS JOIN LATERAL unnest(${consumerColumn}) AS ${ELEMENT}("value")`
    : "";
  const referencedColumn = `${REFERENCED}.${quote(reference.providerColumn)}`;

  const conditions = [
    `${referencingColumn} IS NOT NULL`,
    `${referencedColumn} IS NULL`,
  ];
  const values: string[] = [];

  for (const filter of reference.filters ?? []) {
    conditions.push(bindFilter(REFERENCING, filter, values));
  }

  const parent = reference.discriminatedByParent;
  const joinParent =
    parent === undefined
      ? ""
      : `\n  JOIN ${quote(parent.table)} AS ${DISCRIMINATOR}` +
        `\n    ON ${DISCRIMINATOR}.${quote(parent.parentColumn)} = ${REFERENCING}.${quote(parent.localColumn)}`;
  for (const filter of parent?.filters ?? []) {
    conditions.push(bindFilter(DISCRIMINATOR, filter, values));
  }

  // Both sides are compared as text. `user.id` is TEXT while every uuid key is
  // UUID, and `sso_provider.organization_id` is a TEXT column pointing at a
  // UUID key — a typed comparison would abort the run on that one row instead
  // of reporting the malformed id it exists to find.
  const text =
    `SELECT ${referencingColumn}::text AS value, count(*)::int AS occurrences` +
    `\n  FROM ${quote(reference.consumerTable)} AS ${REFERENCING}` +
    unnestElements +
    joinParent +
    `\n  LEFT JOIN ${quote(reference.providerTable)} AS ${REFERENCED}` +
    `\n    ON ${referencedColumn}::text = ${referencingColumn}::text` +
    `\n  WHERE ${conditions.join("\n    AND ")}` +
    `\n  GROUP BY 1` +
    `\n  ORDER BY occurrences DESC, value ASC`;

  return { text, values };
}

/** Adds one filter's value to the bind list and returns its SQL condition. */
function bindFilter(
  alias: string,
  filter: ReferenceFilter,
  values: string[],
): string {
  values.push(filter.equals);
  return `${alias}.${quote(filter.column)} = $${String(values.length)}`;
}

/**
 * A registry identifier, double-quoted so `user` and friends survive.
 *
 * Registry rows are repo-authored, never request input — but a typo that
 * produced injectable SQL would be found in production rather than in review,
 * so the shape is asserted rather than assumed.
 */
function quote(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(
      `registry identifier \`${identifier}\` is not a plain lower_snake_case Postgres identifier`,
    );
  }
  return `"${identifier}"`;
}
