import { DatabaseSync } from "node:sqlite";

import type { AccessModel, PermissionToken } from "@dads-framework/access";
import type { SubjectRef } from "@dads-framework/access/runtime";
import {
  ControllableClock,
  type TestDuration,
} from "@dads-framework/access/testing";

import { SqliteAuthorization } from "./sqlite-authorization.js";
import { createNodeSqliteExecutor } from "./sqlite-executor.js";
import { sqliteRelationshipSchemaMigration } from "./sqlite-schema.js";
import type { SqliteValue } from "./sqlite-types.js";

export type SqliteTestAuthorizationOptions = {
  readonly namespace?: string;
  readonly clock?: ControllableClock;
  readonly startTime?: Date | number;
};

/** Disposable in-memory SQLite authorization environment (~0.05 ms setup, zero Docker). */
export type SqliteTestEnvironment = {
  readonly db: DatabaseSync;
  readonly authorization: SqliteAuthorization;
  readonly clock: ControllableClock;
  readonly advanceTime: (duration: TestDuration) => Date;
  readonly setTime: (nextTime: Date | number) => Date;
  readonly close: () => void;
  readonly [Symbol.dispose]: () => void;
};

/**
 * Create a real `:memory:` SQLite database with the relationship schema and
 * covering indexes applied. Supports `using testEnv = createSqliteTestAuthorization(model)`.
 */
export function createSqliteTestAuthorization(
  model: AccessModel,
  options?: SqliteTestAuthorizationOptions,
): SqliteTestEnvironment {
  const db = new DatabaseSync(":memory:");
  for (const statement of sqliteRelationshipSchemaMigration.statements) {
    db.exec(statement);
  }
  const clock = options?.clock ?? new ControllableClock(options?.startTime);
  const authorization = new SqliteAuthorization({
    model,
    namespace: options?.namespace ?? "test",
    executor: createNodeSqliteExecutor(db),
    now: () => clock.now(),
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  return {
    db,
    authorization,
    clock,
    advanceTime: (duration) => clock.advance(duration),
    setTime: (nextTime) => clock.set(nextTime),
    close,
    [Symbol.dispose]: close,
  };
}

export type SqliteFilterParityInput = {
  readonly db: DatabaseSync;
  readonly authorization: SqliteAuthorization;
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

function queryFilteredIds(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  filterSql: string,
  values: readonly SqliteValue[],
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT ${idColumn} AS row_id FROM ${table} WHERE ${filterSql} ORDER BY ${idColumn}`,
    )
    .all(...values);
  return rows.map((row) => String(row["row_id"] ?? "")).sort();
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

async function checkSqliteSubjectFilters(
  input: SqliteFilterParityInput,
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

  const plainFilter = input.authorization.compileFilter({
    subject,
    resourceType: input.permission.entityWireName,
    permission: input.permission.permissionName,
    idColumn: input.idColumn,
  });
  const plainIds = queryFilteredIds(
    input.db,
    input.table,
    input.idColumn,
    plainFilter.sql,
    plainFilter.values,
  );
  const plainDiff = compareSets(subject, "compileFilter", plainIds, lookupIds);
  if (plainDiff !== undefined) disagreements.push(plainDiff);

  if (input.scopeColumns !== undefined) {
    const scopedFilter = input.authorization.compileFilter({
      subject,
      resourceType: input.permission.entityWireName,
      permission: input.permission.permissionName,
      idColumn: input.idColumn,
      scopeColumns: input.scopeColumns,
    });
    const scopedIds = queryFilteredIds(
      input.db,
      input.table,
      input.idColumn,
      scopedFilter.sql,
      scopedFilter.values,
    );
    const scopedDiff = compareSets(
      subject,
      "compileFilter(scopeColumns)",
      scopedIds,
      lookupIds,
    );
    if (scopedDiff !== undefined) disagreements.push(scopedDiff);
  }
  return disagreements;
}

/**
 * Prove that `compileFilter` (and `compileFilter({ scopeColumns })` when
 * provided) selects the exact same row IDs as `lookupResources` for every subject.
 */
export async function proveSqliteFilterParity(
  input: SqliteFilterParityInput,
): Promise<void> {
  const disagreements: FilterDisagreement[] = [];
  for (const subject of input.subjects) {
    disagreements.push(...(await checkSqliteSubjectFilters(input, subject)));
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
        `SQLite filter parity failed for ${input.permission.entityWireName}#${input.permission.permissionName}:`,
        ...details,
      ].join("\n"),
    );
  }
}
