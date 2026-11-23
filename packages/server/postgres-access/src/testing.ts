import type { PermissionToken } from "@dads-framework/access";
import type { SubjectRef } from "@dads-framework/access/runtime";

import type { PostgresAuthorization } from "./postgres-authorization.js";
import type { PgClientLike, PgPoolLike, PostgresValue } from "./postgres-types.js";

export type PostgresFilterParityInput = {
  readonly db: PgPoolLike | PgClientLike;
  readonly authorization: PostgresAuthorization;
  readonly table: string;
  readonly idColumn: string;
  readonly permission: PermissionToken;
  readonly scopeColumns?: Readonly<Record<string, string>>;
  readonly subjects: readonly SubjectRef[];
};

type FilterDisagreement = {
  readonly subject: SubjectRef;
  readonly mode: string;
  readonly onlyInFilter: readonly string[];
  readonly onlyInLookup: readonly string[];
};

function formatSubject(subject: SubjectRef): string {
  return subject.relation === undefined
    ? `${subject.type}:${subject.id}`
    : `${subject.type}:${subject.id}#${subject.relation}`;
}

async function queryFilteredIds(
  db: PgPoolLike | PgClientLike,
  table: string,
  idColumn: string,
  filterSql: string,
  values: readonly PostgresValue[],
): Promise<readonly string[]> {
  const result = await db.query(`SELECT ${idColumn} AS row_id FROM ${table} WHERE ${filterSql} ORDER BY ${idColumn}`, [
    ...values,
  ]);
  return result.rows
    .map((row) => {
      const rawId = row["row_id"];
      return typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    })
    .sort();
}

function compareSets(
  subject: SubjectRef,
  mode: string,
  filterIds: readonly string[],
  lookupIds: readonly string[],
): FilterDisagreement | undefined {
  const filterSet = new Set(filterIds);
  const lookupSet = new Set(lookupIds);
  const onlyInFilter = filterIds.filter((id) => !lookupSet.has(id));
  const onlyInLookup = lookupIds.filter((id) => !filterSet.has(id));
  if (onlyInFilter.length === 0 && onlyInLookup.length === 0) return undefined;
  return { subject, mode, onlyInFilter, onlyInLookup };
}

async function runSingleFilterCheck(
  input: PostgresFilterParityInput,
  subject: SubjectRef,
  mode: string,
  filter: { readonly sql: string; readonly values: readonly PostgresValue[] },
  lookupIds: readonly string[],
): Promise<FilterDisagreement | undefined> {
  const actualIds = await queryFilteredIds(input.db, input.table, input.idColumn, filter.sql, filter.values);
  return compareSets(subject, mode, actualIds, lookupIds);
}

async function checkSubjectFilters(
  input: PostgresFilterParityInput,
  subject: SubjectRef,
): Promise<readonly FilterDisagreement[]> {
  const disagreements: FilterDisagreement[] = [];
  const lookupIds = [
    ...(await input.authorization.lookupResources({
      subject,
      resourceType: input.permission.entityWireName,
      permission: input.permission.permissionName,
    })),
  ].sort();

  const baseQuery = {
    subject,
    resourceType: input.permission.entityWireName,
    permission: input.permission.permissionName,
    idColumn: input.idColumn,
  };
  const plainDiff = await runSingleFilterCheck(
    input,
    subject,
    "compileFilter",
    input.authorization.compileFilter(baseQuery),
    lookupIds,
  );
  if (plainDiff !== undefined) disagreements.push(plainDiff);

  const scopedQuery = input.scopeColumns === undefined ? baseQuery : { ...baseQuery, scopeColumns: input.scopeColumns };
  if (input.scopeColumns !== undefined) {
    const scopedDiff = await runSingleFilterCheck(
      input,
      subject,
      "compileFilter(scopeColumns)",
      input.authorization.compileFilter(scopedQuery),
      lookupIds,
    );
    if (scopedDiff !== undefined) disagreements.push(scopedDiff);
  }

  const resolvedDiff = await runSingleFilterCheck(
    input,
    subject,
    "resolveFilter",
    await input.authorization.resolveFilter(scopedQuery),
    lookupIds,
  );
  if (resolvedDiff !== undefined) disagreements.push(resolvedDiff);
  return disagreements;
}

/**
 * Drizzle-free Postgres filter parity proof: verifies `compileFilter`,
 * `compileFilter({ scopeColumns })`, and `resolveFilter` return the exact same
 * row IDs as `lookupResources` for every subject.
 */
export async function provePostgresFilterParity(input: PostgresFilterParityInput): Promise<void> {
  const disagreements: FilterDisagreement[] = [];
  for (const subject of input.subjects) {
    disagreements.push(...(await checkSubjectFilters(input, subject)));
  }

  if (disagreements.length > 0) {
    const details = disagreements.map((item) => {
      const parts = [`  ${formatSubject(item.subject)} [${item.mode}]`];
      if (item.onlyInFilter.length > 0) {
        parts.push(`    SQL leaked rows: [${item.onlyInFilter.join(", ")}]`);
      }
      if (item.onlyInLookup.length > 0) {
        parts.push(`    SQL missed rows: [${item.onlyInLookup.join(", ")}]`);
      }
      return parts.join("\n");
    });
    throw new Error(
      [
        `Postgres filter parity failed for ${input.permission.entityWireName}#${input.permission.permissionName}:`,
        ...details,
      ].join("\n"),
    );
  }
}
