import type { SqliteQuery } from "../sqlite-types.js";
import {
  columnChunk,
  compileArrowTargetDisjunction,
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
import {
  activeTupleCondition,
  joinChunks,
  QueryBuilder,
  TUPLES,
} from "./policy-sql.js";

export {
  columnChunk,
  literalChunk,
  type ForwardCompileContext,
  type SqlResource,
  type SqlSubject,
};

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
  const identities = [
    ...new Set(
      requests.map((entry) =>
        permissionKey(entry.resource.type, entry.permission),
      ),
    ),
  ];
  const branches = identities.map((identity) =>
    compileBatchBranch(context, identity),
  );
  const branchSql = branches.map((branch) => b.append(branch)).join(" ");
  return b.finish(
    `WITH input(ordinal, subject_kind, subject_id, resource_kind, resource_id, permission) AS (VALUES ${rows.join(", ")}) SELECT i.ordinal AS ordinal, CASE ${branchSql} ELSE 0 END AS allowed FROM input i ORDER BY i.ordinal`,
  );
}

function compileBatchBranch(
  context: ForwardCompileContext,
  identity: string,
): SqliteQuery {
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
    throw new Error(
      `SQLite policy cannot find permission ${resource.entity}#${permissionName}`,
    );
  }
  const scc = context.model.cyclicSccsByKey.get(key);
  if (scc !== undefined) {
    return compileForwardCyclicScc(
      context,
      scc,
      subject,
      resource,
      permissionName,
      compileForwardExpression,
    );
  }
  return compileForwardExpression(
    context,
    subject,
    resource,
    definition.expression,
  );
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
      return compileRelationMembership(
        context,
        subject,
        resource,
        expression.relation,
      );
    case "through":
      return compileThrough(
        context,
        subject,
        resource,
        expression.relation,
        expression.targets,
      );
    case "through-all":
      return compileThroughAll(
        context,
        subject,
        resource,
        expression.relation,
        expression.targets,
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
  return compileArrowTargetDisjunction(
    context,
    subject,
    tupleAlias,
    targets,
    compileForwardPermission,
  );
}

/** Compile external guard conditions using forward expression checks. */
export function compileForwardGuards(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  guards: readonly GuardCondition[],
): SqliteQuery | undefined {
  return compileGuardConditions(
    context,
    subject,
    resource,
    guards,
    compileForwardExpression,
  );
}

function compileExclude(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: Extract<SqlitePermissionExpression, { kind: "exclude" }>,
): SqliteQuery {
  const b = new QueryBuilder();
  const inc = compileForwardExpression(
    context,
    subject,
    resource,
    expression.include,
  );
  const exc = compileForwardExpression(
    context,
    subject,
    resource,
    expression.exclude,
  );
  return b.finish(`((${b.append(inc)}) AND NOT (${b.append(exc)}))`);
}

function compileGroup(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  expression: Extract<
    SqlitePermissionExpression,
    { kind: "any-of" | "all-of" }
  >,
): SqliteQuery {
  const joiner = expression.kind === "any-of" ? " OR " : " AND ";
  const parts = expression.expressions.map((child) => {
    const compiled = compileForwardExpression(
      context,
      subject,
      resource,
      child,
    );
    return { sql: `(${compiled.sql})`, params: compiled.params };
  });
  const combined = joinChunks(parts, joiner);
  return { sql: `(${combined.sql})`, params: combined.params };
}

function compileRelationMembership(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
): SqliteQuery {
  const b = new QueryBuilder();
  const cte = context.nextAlias("req");
  const subjectMatch = compileSubjectMatch(subject);
  return b.finish(`EXISTS (
    WITH RECURSIVE ${cte}(resource_kind, resource_id, relation) AS (
      SELECT ${b.append(resource.typeExpr)}, ${b.append(resource.idExpr)}, ${b.value(relation)}
      UNION
      SELECT t.subject_kind, t.subject_id, t.subject_relation
      FROM ${cte} r
      JOIN ${TUPLES} t
        ON t.namespace = ${b.value(context.namespace)}
        AND t.resource_kind = r.resource_kind
        AND t.resource_id = r.resource_id
        AND t.relation = r.relation
        AND t.subject_is_wildcard = 0
        AND t.subject_relation <> ''
        AND ${activeTupleCondition("t", b, context.nowMs)}
    )
    SELECT 1
    FROM ${cte} r
    JOIN ${TUPLES} m
      ON m.namespace = ${b.value(context.namespace)}
      AND m.resource_kind = r.resource_kind
      AND m.resource_id = r.resource_id
      AND m.relation = r.relation
      AND ${activeTupleCondition("m", b, context.nowMs)}
    WHERE ${b.append(subjectMatch)}
    LIMIT 1
  )`);
}

function compileSubjectMatch(subject: SqlSubject): SqliteQuery {
  const b = new QueryBuilder();
  if (subject.kind === "wildcard-only") {
    return b.finish(
      `(m.subject_is_wildcard = 1 AND m.subject_kind = ${b.append(subject.typeExpr)})`,
    );
  }
  return b.finish(
    `((m.subject_is_wildcard = 0 AND m.subject_relation = '' AND m.subject_kind = ${b.append(subject.typeExpr)} AND m.subject_id = ${b.append(subject.idExpr)}) OR (m.subject_is_wildcard = 1 AND m.subject_kind = ${b.append(subject.typeExpr)}))`,
  );
}

function compileThrough(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  const alias = context.nextAlias("thr");
  const targetMatch = compileForwardArrowTargets(
    context,
    subject,
    alias,
    targets,
  );
  const b = new QueryBuilder();
  return b.finish(`EXISTS (
    SELECT 1
    FROM ${TUPLES} ${alias}
    WHERE ${alias}.namespace = ${b.value(context.namespace)}
      AND ${alias}.resource_kind = ${b.append(resource.typeExpr)}
      AND ${alias}.resource_id = ${b.append(resource.idExpr)}
      AND ${alias}.relation = ${b.value(relation)}
      AND ${alias}.subject_is_wildcard = 0
      AND ${alias}.subject_relation = ''
      AND ${activeTupleCondition(alias, b, context.nowMs)}
      AND (${b.append(targetMatch)})
  )`);
}

function compileThroughAll(
  context: ForwardCompileContext,
  subject: SqlSubject,
  resource: SqlResource,
  relation: string,
  targets: readonly SqliteArrowTarget[],
): SqliteQuery {
  const existsAlias = context.nextAlias("all_e");
  const failAlias = context.nextAlias("all_n");
  const targetMatch = compileForwardArrowTargets(
    context,
    subject,
    failAlias,
    targets,
  );
  const b = new QueryBuilder();
  return b.finish(`(
    EXISTS (
      SELECT 1
      FROM ${TUPLES} ${existsAlias}
      WHERE ${existsAlias}.namespace = ${b.value(context.namespace)}
        AND ${existsAlias}.resource_kind = ${b.append(resource.typeExpr)}
        AND ${existsAlias}.resource_id = ${b.append(resource.idExpr)}
        AND ${existsAlias}.relation = ${b.value(relation)}
        AND ${existsAlias}.subject_is_wildcard = 0
        AND ${existsAlias}.subject_relation = ''
        AND ${activeTupleCondition(existsAlias, b, context.nowMs)}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ${TUPLES} ${failAlias}
      WHERE ${failAlias}.namespace = ${b.value(context.namespace)}
        AND ${failAlias}.resource_kind = ${b.append(resource.typeExpr)}
        AND ${failAlias}.resource_id = ${b.append(resource.idExpr)}
        AND ${failAlias}.relation = ${b.value(relation)}
        AND ${failAlias}.subject_is_wildcard = 0
        AND ${failAlias}.subject_relation = ''
        AND ${activeTupleCondition(failAlias, b, context.nowMs)}
        AND NOT (${b.append(targetMatch)})
    )
  )`);
}
