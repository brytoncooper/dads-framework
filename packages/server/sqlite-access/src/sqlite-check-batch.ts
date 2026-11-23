import type {
  PermissionCheckOutcome,
  PermissionQuery,
} from "@dads-framework/access/runtime";
import type { CompiledSqliteAccessPolicy } from "./policy/compile-access-policy.js";
import { compileSqliteCheckMany } from "./policy/compile-check.js";
import type { SqlitePermissionCheck } from "./policy/policy-model.js";
import type { SqliteExecutor } from "./sqlite-executor.js";
import { readDecisionFlag } from "./sqlite-types.js";
import { requireConcreteSubject } from "./sqlite-validation.js";

type PreparedBatchItem =
  | { readonly kind: "known"; readonly check: SqlitePermissionCheck }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly error: Error };

export type SqliteBatchContext = {
  readonly policy: CompiledSqliteAccessPolicy;
  readonly namespace: string;
  readonly executor: SqliteExecutor;
};

export function normalizeSqliteCheck(
  policy: CompiledSqliteAccessPolicy,
  query: PermissionQuery,
): SqlitePermissionCheck | undefined {
  requireConcreteSubject(query.subject);
  const permission = policy.permissionName(
    query.resource.type,
    query.permission,
  );
  if (permission === undefined) return undefined;
  return {
    subject: { type: query.subject.type, id: query.subject.id },
    resource: { type: query.resource.type, id: query.resource.id },
    permission,
  };
}

export async function runSqliteCheckBatch(
  context: SqliteBatchContext,
  queries: readonly PermissionQuery[],
  nowMs: number,
): Promise<readonly boolean[]> {
  const normalized = queries.map((query) =>
    normalizeSqliteCheck(context.policy, query),
  );
  const known = normalized.filter(
    (entry): entry is SqlitePermissionCheck => entry !== undefined,
  );
  if (known.length === 0) return normalized.map(() => false);
  const rows = await executeCheckMany(context, known, nowMs);
  let index = 0;
  return normalized.map((entry) =>
    entry === undefined ? false : readDecisionFlag(rows[index++]),
  );
}

export async function runSqliteCheckEachBatch(
  context: SqliteBatchContext,
  queries: readonly PermissionQuery[],
  nowMs: number,
): Promise<readonly PermissionCheckOutcome[]> {
  const prepared = queries.map((query) =>
    prepareBatchItem(context.policy, query),
  );
  const known = prepared
    .filter(
      (
        entry,
      ): entry is Extract<PreparedBatchItem, { readonly kind: "known" }> =>
        entry.kind === "known",
    )
    .map((entry) => entry.check);
  const rows =
    known.length === 0 ? [] : await executeCheckMany(context, known, nowMs);
  let index = 0;
  return prepared.map((entry): PermissionCheckOutcome => {
    if (entry.kind === "failed") return { kind: "failed", error: entry.error };
    if (entry.kind === "unknown") return { kind: "answered", allowed: false };
    return { kind: "answered", allowed: readDecisionFlag(rows[index++]) };
  });
}

async function executeCheckMany(
  context: SqliteBatchContext,
  known: readonly SqlitePermissionCheck[],
  nowMs: number,
) {
  const compiled = compileSqliteCheckMany(
    context.policy.model,
    context.namespace,
    nowMs,
    known,
  );
  const rows = await context.executor.all(compiled.sql, compiled.params);
  if (rows.length !== known.length) {
    throw new Error("SQLite authorization omitted a decision");
  }
  return rows;
}

function prepareBatchItem(
  policy: CompiledSqliteAccessPolicy,
  query: PermissionQuery,
): PreparedBatchItem {
  try {
    const normalized = normalizeSqliteCheck(policy, query);
    return normalized === undefined
      ? { kind: "unknown" }
      : { kind: "known", check: normalized };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
