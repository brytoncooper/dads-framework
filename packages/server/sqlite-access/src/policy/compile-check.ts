import type { SqliteQuery } from "../sqlite-types.js";
import { compileSqliteThrough, compileSqliteThroughAll } from "./compile-check-through.js";
import {
  columnChunk,
  compileArrowTargetDisjunction,
  compileColumnArrowTargets,
  compileForwardCyclicScc,
  compileGuardConditions,
  literalChunk,
  type ForwardCompileContext,
  type SqlResource,
  type SqlSubject,
} from "./compile-forward-scc.js";
import {
  permissionKey,
  splitPermissionKey,
  type SqliteAuthorizationModel,
  type SqliteArrowTarget,
  type SqlitePermissionExpression,
  type GuardCondition,
  type SqlitePermissionCheck,
} from "./policy-model.js";
import { compileRelationMembership } from "./compile-relation-membership.js";
import { joinChunks, QueryBuilder } from "./policy-sql.js";

export { columnChunk, literalChunk, type ForwardCompileContext, type SqlResource, type SqlSubject };

/** Compile a single concrete permission check into a parameterized SQLite Boolean query. */
export function compileSqliteCheck(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqlitePermissionCheck,
): SqliteQuery {
  let aliasCount = 0;
  const context: ForwardCompileContext = {
    model,
    namespace,
    nowMs,
    nextAlias: (prefix) => `${prefix}_${aliasCount++}`,
  };
  const predicate = compileForwardPermission(
    context,
    {
      kind: "concrete",
      typeExpr: literalChunk(request.subject.type),
      idExpr: literalChunk(request.subject.id),
    },
    {
      entity: request.resource.type,
      typeExpr: literalChunk(request.resource.type),
      idExpr: literalChunk(request.resource.id),
    },
    request.permission,
  );
  const b = new QueryBuilder();
  return b.finish(`SELECT (${b.append(predicate)}) AS allowed`);
}

/** Compile an ordered batch of concrete permission checks in one SQLite statement. */
export function compileSqliteCheckMany(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  requests: readonly SqlitePermissionCheck[],
): SqliteQuery {
  let aliasCount = 0;
  const context: ForwardCompileContext = {
    model,
    namespace,
    nowMs,
    nextAlias: (prefix) => `${prefix}_${aliasCount++}`,
  };
  const b = new QueryBuilder();
  const rows = requests.map(
    (request, ordinal) =>
      `(${b.value(ordinal)}, ${b.value(request.subject.type)}, ${b.value(request.subject.id)}, ${b.value(request.resource.type)}, ${b.value(request.resource.id)}, ${b.value(request.permission)})`,
  );
  const identities = [...new Set(requests.map((entry) => permissionKey(entry.resource.type, entry.permission)))];
  const branches = identities.map((identity) => compileBatchBranch(context, identity));
  const branchSql = branches.map((branch) => b.append(branch)).join(" ");
  return b.finish(
    `WITH input(ordinal, subject_kind, subject_id, resource_kind, resource_id, permission) AS (VALUES ${rows.join(", ")}) SELECT i.ordinal AS ordinal, CASE ${branchSql} ELSE 0 END AS allowed FROM input i ORDER BY i.ordinal`,
  );
}

function compileBatchBranch(context: ForwardCompileContext, identity: string): SqliteQuery {
  const [resourceType, permission] = splitPermissionKey(identity);
  const predicate = compileForwardPermission(
    context,
    {
      kind: "concrete",
      typeExpr: columnChunk("i.subject_kind"),
      idExpr: columnChunk("i.subject_id"),
    },
    {
      entity: resourceType,
      typeExpr: columnChunk("i.resource_kind"),
      idExpr: columnChunk("i.resource_id"),
    },
    permission,
  );
  const b = new QueryBuilder();
  return b.finish(
    `WHEN i.resource_kind = ${b.value(resourceType)} AND i.permission = ${b.value(permission)} THEN (${b.append(predicate)})`,
  );
}

/** Compile a forward Boolean predicate for `(subject, permission, resource)`. */
export function compileForwardPermission(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  permissionName: string,
): SqliteQuery {
  const key = permissionKey(resource.entity, permissionName);
  const definition = context.model.permissionByKey.get(key);
  if (definition === undefined) {
    throw new Error(`SQLite policy cannot find permission ${resource.entity}#${permissionName}`);
  }
  const scc = context.model.cyclicSccsByKey.get(key);
  if (scc !== undefined) {
    return compileForwardCyclicScc(context, scc, subject, resource, permissionName, compileForwardExpression);
  }
  return compileForwardExpression(context, subject, resource, definition.expression);
}

/** Compile a forward Boolean predicate for a single compiled expression. */
export function compileForwardExpression(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: SqlitePermissionExpression,
): SqliteQuery {
  switch (expression.kind) {
    case "relation":
      return compileRelationMembership(context, subject, resource, expression.relation);
    case "through":
      return compileSqliteThrough(
        context,
        subject,
        resource,
        expression.relation,
        expression.targets,
        compileForwardPermission,
      );
    case "through-all":
      return compileSqliteThroughAll(
        context,
        subject,
        resource,
        expression.relation,
        expression.targets,
        compileForwardPermission,
      );
    case "exclude":
      return compileExclude(context, subject, resource, expression);
    case "any-of":
    case "all-of":
      return compileGroup(context, subject, resource, expression);
  }
}

/** Compile a disjunction over arrow targets using forward permission checks. */
export function compileForwardArrowTargets(
  context: ForwardCompileContext,
  subject: SqlSubject,
  tupleAlias: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  return compileArrowTargetDisjunction(context, subject, tupleAlias, targets, compileForwardPermission);
}

/** Compile a disjunction over column-backed arrow targets using forward permission checks. */
export function compileForwardColumnArrowTargets(
  context: ForwardCompileContext,
  subject: SqlSubject,
  targetEntity: string,
  targetIdExpr: SqliteQuery,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  return compileColumnArrowTargets(context, subject, targetEntity, targetIdExpr, targets, compileForwardPermission);
}

/** Compile external guard conditions using forward expression checks. */
export function compileForwardGuards(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  guards: readonly GuardCondition[],
): SqliteQuery | undefined {
  return compileGuardConditions(context, subject, resource, guards, compileForwardExpression);
}

function compileExclude(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: Extract<SqlitePermissionExpression, { kind: "exclude" }>,
): SqliteQuery {
  const b = new QueryBuilder();
  const inc = compileForwardExpression(context, subject, resource, expression.include);
  const exc = compileForwardExpression(context, subject, resource, expression.exclude);
  return b.finish(`((${b.append(inc)}) AND NOT (${b.append(exc)}))`);
}

function compileGroup(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: Extract<SqlitePermissionExpression, { kind: "any-of" | "all-of" }>,
): SqliteQuery {
  const joiner = expression.kind === "any-of" ? " OR " : " AND ";
  const parts = expression.expressions.map((child) => {
    const compiled = compileForwardExpression(context, subject, resource, child);
    return { sql: `(${compiled.sql})`, params: compiled.params };
  });
  const combined = joinChunks(parts, joiner);
  return { sql: `(${combined.sql})`, params: combined.params };
}
