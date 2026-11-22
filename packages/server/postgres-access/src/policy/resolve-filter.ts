import type { PostgresQuery, PostgresRow } from "../postgres-types.js";
import type {
  AuthorizationModelDefinition,
  CompiledPermissionExpression,
  NormalizedResourceLookup,
} from "./policy-model.js";
import {
  compileReverseExpressionQuery,
  compileReversePermission,
} from "./compile-reverse-policy.js";
import type {
  PostgresAccessFilter,
  ValidatedPostgresFilterInput,
} from "./compile-filter.js";
import {
  directSubjectReachability,
  modelHasUsersetTargets,
  QueryBuilder,
  resolveArrowTargets,
  subjectReachability,
} from "./policy-sql.js";

type ResolvedBranchSpec = {
  readonly kind: "include" | "exclude";
  readonly column: string;
  readonly innerSql: string;
};

type BranchCollectorContext = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespaceSql: string;
  readonly entity: string;
  readonly idColumn: string;
  readonly scopeColumns: Readonly<Record<string, string>>;
};

export type ResolvedFilterPlan = {
  readonly query: PostgresQuery;
  readonly branches: readonly {
    readonly kind: "include" | "exclude";
    readonly column: string;
  }[];
};

/** Executes a single tagged reverse-index query and prunes empty `scopeColumns` branches. */
export async function resolvePostgresFilter(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
  options: ValidatedPostgresFilterInput,
  runQuery: (query: PostgresQuery) => Promise<readonly PostgresRow[]>,
  fallback: () => PostgresAccessFilter,
): Promise<PostgresAccessFilter> {
  const plan = buildPostgresResolveFilterPlan(
    model,
    namespace,
    request,
    options,
  );
  if (plan === undefined) return fallback();
  const rows = await runQuery(plan.query);
  return finalizePostgresResolvedFilter(plan, rows, options.paramOffset);
}

/**
 * Builds a single tagged lookup query for a `scopeColumns`-assisted permission.
 * Returns `undefined` when the permission cannot be decomposed onto
 * `scopeColumns`, letting callers fall back directly to `compilePostgresFilter`.
 */
export function buildPostgresResolveFilterPlan(
  model: AuthorizationModelDefinition,
  namespace: string,
  request: NormalizedResourceLookup,
  options: ValidatedPostgresFilterInput,
): ResolvedFilterPlan | undefined {
  if (options.scopeColumns === undefined) return undefined;
  const definition = model.permissions.find(
    (candidate) =>
      candidate.entity === request.resourceType &&
      candidate.wireName === request.permission,
  );
  if (definition === undefined) return undefined;

  const builder = new QueryBuilder(1);
  const namespaceSql = builder.value(namespace);
  const subjectTypeSql = builder.value(request.subject.type);
  const subjectIdSql = builder.value(request.subject.id);

  const branches = collectResolvedBranches(
    {
      model,
      builder,
      namespaceSql,
      entity: request.resourceType,
      idColumn: options.idColumn,
      scopeColumns: options.scopeColumns,
    },
    definition.expression,
  );
  if (branches === undefined) return undefined;

  const usesUsersets = modelHasUsersetTargets(model);
  const reachCte = usesUsersets
    ? subjectReachability(
        namespaceSql,
        subjectTypeSql,
        subjectIdSql,
        model.columnRelations,
        builder,
      )
    : directSubjectReachability(
        namespaceSql,
        subjectTypeSql,
        subjectIdSql,
        model.columnRelations,
        builder,
      );
  const withKeyword =
    usesUsersets || builder.hasRecursive ? "WITH RECURSIVE" : "WITH";
  const tagged = branches.map(
    (branch, index) =>
      `SELECT ${String(index)} AS branch, allowed_resource.resource_id FROM (${branch.innerSql}) allowed_resource`,
  );
  return {
    query: {
      text: `${withKeyword} ${reachCte} ${tagged.join(" UNION ALL ")}`,
      values: builder.values,
    },
    branches: branches.map(({ kind, column }) => ({ kind, column })),
  };
}

/**
 * Materializes a branch-pruned SQL `WHERE` predicate from the tagged lookup
 * rows. Empty include branches are omitted; if every include branch is empty,
 * returns `{ sql: "FALSE", values: [] }`.
 */
export function finalizePostgresResolvedFilter(
  plan: ResolvedFilterPlan,
  rows: readonly PostgresRow[],
  paramOffset: number,
): PostgresAccessFilter {
  const buckets = bucketResolvedRows(plan.branches.length, rows);
  const values: string[][] = [];
  const includeParts: string[] = [];
  const excludeParts: string[] = [];

  for (let index = 0; index < plan.branches.length; index += 1) {
    const branch = plan.branches[index];
    const bucket = buckets[index];
    if (branch === undefined || bucket === undefined || bucket.size === 0) {
      continue;
    }
    const placeholder = `$${String(paramOffset + values.length)}::text[]`;
    values.push([...bucket]);
    if (branch.kind === "include") {
      includeParts.push(`(${branch.column} = ANY(${placeholder}))`);
    } else {
      excludeParts.push(`(NOT (${branch.column} = ANY(${placeholder})))`);
    }
  }

  if (includeParts.length === 0) {
    return Object.freeze({ sql: "FALSE", values: [] });
  }
  const includeSql =
    includeParts.length === 1 && includeParts[0] !== undefined
      ? includeParts[0]
      : `(${includeParts.join(" OR ")})`;
  const fullSql =
    excludeParts.length === 0
      ? includeSql
      : `(${includeSql} AND ${excludeParts.join(" AND ")})`;
  return Object.freeze({ sql: fullSql, values });
}

function bucketResolvedRows(
  branchCount: number,
  rows: readonly PostgresRow[],
): readonly Set<string>[] {
  const buckets = Array.from({ length: branchCount }, () => new Set<string>());
  for (const row of rows) {
    const branch = Number(row["branch"]);
    const id = row["resource_id"];
    if (
      Number.isInteger(branch) &&
      branch >= 0 &&
      branch < buckets.length &&
      typeof id === "string"
    ) {
      buckets[branch]?.add(id);
    }
  }
  return buckets;
}

function collectResolvedBranches(
  ctx: BranchCollectorContext,
  expression: CompiledPermissionExpression,
): readonly ResolvedBranchSpec[] | undefined {
  if (expression.kind !== "exclude") {
    return collectPositiveBranches(ctx, expression);
  }
  const includeBranches = collectPositiveBranches(ctx, expression.include);
  if (includeBranches === undefined) return undefined;
  const excludeSql = compileReverseExpressionQuery(
    ctx.model,
    ctx.builder,
    ctx.namespaceSql,
    ctx.entity,
    expression.exclude,
    new Set(),
    { deduplicate: false },
  );
  return [
    ...includeBranches,
    { kind: "exclude", column: ctx.idColumn, innerSql: excludeSql },
  ];
}

function collectPositiveBranches(
  ctx: BranchCollectorContext,
  expression: CompiledPermissionExpression,
): readonly ResolvedBranchSpec[] | undefined {
  if (expression.kind === "through") {
    return collectScopedThroughBranch(ctx, expression);
  }
  if (expression.kind !== "any-of") return undefined;
  return collectScopedAnyOfBranches(ctx, expression.expressions);
}

function collectScopedThroughBranch(
  ctx: BranchCollectorContext,
  expression: Extract<CompiledPermissionExpression, { kind: "through" }>,
): readonly ResolvedBranchSpec[] | undefined {
  const column = ctx.scopeColumns[expression.relation];
  if (column === undefined) return undefined;
  const targets = resolveArrowTargets(ctx.model, ctx.entity, expression);
  const target = targets.length === 1 ? targets[0] : undefined;
  if (target === undefined) return undefined;
  const allowedScopes = compileReversePermission(
    ctx.model,
    ctx.builder,
    ctx.namespaceSql,
    target.entity,
    target.permission,
    new Set(),
    { deduplicate: false },
  );
  return [{ kind: "include", column, innerSql: allowedScopes }];
}

function collectScopedAnyOfBranches(
  ctx: BranchCollectorContext,
  expressions: readonly CompiledPermissionExpression[],
): readonly ResolvedBranchSpec[] | undefined {
  const branches: ResolvedBranchSpec[] = [];
  const remainder: CompiledPermissionExpression[] = [];
  for (const child of expressions) {
    const childBranches = collectPositiveBranches(ctx, child);
    if (childBranches !== undefined) {
      branches.push(...childBranches);
    } else {
      remainder.push(child);
    }
  }
  if (branches.length === 0) return undefined;
  if (remainder.length > 0) {
    const restExpr: CompiledPermissionExpression =
      remainder.length === 1 && remainder[0] !== undefined
        ? remainder[0]
        : { kind: "any-of", expressions: remainder };
    const restSql = compileReverseExpressionQuery(
      ctx.model,
      ctx.builder,
      ctx.namespaceSql,
      ctx.entity,
      restExpr,
      new Set(),
      { deduplicate: false },
    );
    branches.push({ kind: "include", column: ctx.idColumn, innerSql: restSql });
  }
  return branches;
}
