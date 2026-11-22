import type { SqliteQuery } from "../sqlite-types.js";
import {
  columnChunk,
  compileForwardPermission,
  literalChunk,
  type ForwardCompileContext,
} from "./compile-check.js";
import {
  permissionKey,
  type SqliteAuthorizationModel,
  type SqlitePermissionExpression,
  type SqliteSubjectLookup,
} from "./policy-model.js";
import { activeTupleCondition, QueryBuilder, TUPLES } from "./policy-sql.js";

type ArrowEdge = {
  readonly entity: string;
  readonly permission: string;
  readonly relation: string;
  readonly targetEntity: string;
  readonly targetPermission: string;
};

type PositiveRelation = {
  readonly entity: string;
  readonly permission: string;
  readonly relation: string;
};

type ReachableGraph = {
  readonly arrows: readonly ArrowEdge[];
  readonly relations: readonly PositiveRelation[];
};

/**
 * Compile transitive `lookupSubjects` into one SQLite query returning concrete
 * `(subject_id, is_wildcard = 0)` rows and an optional `('', is_wildcard = 1)` row.
 */
export function compileSqliteLookupSubjects(
  model: SqliteAuthorizationModel,
  namespace: string,
  nowMs: number,
  request: SqliteSubjectLookup,
): SqliteQuery {
  const graph = collectReachablePositiveGraph(
    model,
    request.resource.type,
    request.permission,
  );
  if (graph.relations.length === 0) {
    return Object.freeze({
      sql: "SELECT '' AS subject_id, 0 AS is_wildcard WHERE 0",
      params: [],
    });
  }
  let aliasCount = 0;
  const forward: ForwardCompileContext = {
    model,
    namespace,
    nowMs,
    nextAlias: (prefix) => `${prefix}_${aliasCount++}`,
  };
  return buildLookupSubjectsQuery(forward, request, graph);
}

function buildLookupSubjectsQuery(
  forward: ForwardCompileContext,
  request: SqliteSubjectLookup,
  graph: ReachableGraph,
): SqliteQuery {
  const resource = {
    entity: request.resource.type,
    typeExpr: literalChunk(request.resource.type),
    idExpr: literalChunk(request.resource.id),
  };
  const concreteCheck = compileForwardPermission(
    forward,
    {
      kind: "concrete",
      typeExpr: literalChunk(request.subjectType),
      idExpr: columnChunk("c.subject_id"),
    },
    resource,
    request.permission,
  );
  const wildcardCheck = compileForwardPermission(
    forward,
    {
      kind: "wildcard-only",
      typeExpr: literalChunk(request.subjectType),
    },
    resource,
    request.permission,
  );

  const b = new QueryBuilder();
  const ctes = buildCandidateCtes(b, forward, request, graph);
  return b.finish(`WITH RECURSIVE ${ctes}
    SELECT subject_id, is_wildcard FROM (
      SELECT c.subject_id AS subject_id, 0 AS is_wildcard
      FROM candidates c
      WHERE ${b.append(concreteCheck)}
      UNION ALL
      SELECT '' AS subject_id, 1 AS is_wildcard
      WHERE ${b.append(wildcardCheck)}
    )
    ORDER BY is_wildcard ASC, subject_id ASC`);
}

function buildCandidateCtes(
  b: QueryBuilder,
  forward: ForwardCompileContext,
  request: SqliteSubjectLookup,
  graph: ReachableGraph,
): string {
  const parts: string[] = [];
  if (graph.arrows.length > 0) {
    parts.push(buildArrowEdgesCte(b, graph.arrows));
  }
  parts.push(buildPositiveRelationsCte(b, graph.relations));
  parts.push(buildReachCte(b, forward, request, graph.arrows.length > 0));
  parts.push(buildSubjectWalkCte(b, forward));
  parts.push(buildCandidatesCte(b, forward, request.subjectType));
  return parts.join(", ");
}

function buildArrowEdgesCte(
  b: QueryBuilder,
  arrows: readonly ArrowEdge[],
): string {
  const rows = arrows.map(
    (edge) =>
      `(${b.value(edge.entity)}, ${b.value(edge.permission)}, ${b.value(edge.relation)}, ${b.value(edge.targetEntity)}, ${b.value(edge.targetPermission)})`,
  );
  return `arrow_edges(entity, perm, relation, target_entity, target_perm) AS (VALUES ${rows.join(", ")})`;
}

function buildPositiveRelationsCte(
  b: QueryBuilder,
  relations: readonly PositiveRelation[],
): string {
  const rows = relations.map(
    (entry) =>
      `(${b.value(entry.entity)}, ${b.value(entry.permission)}, ${b.value(entry.relation)})`,
  );
  return `pos_relations(entity, perm, relation) AS (VALUES ${rows.join(", ")})`;
}

function buildReachCte(
  b: QueryBuilder,
  forward: ForwardCompileContext,
  request: SqliteSubjectLookup,
  hasArrows: boolean,
): string {
  const anchor = `SELECT ${b.value(request.resource.type)}, ${b.value(request.resource.id)}, ${b.value(request.permission)}`;
  if (!hasArrows) {
    return `reach(entity, resource_id, perm) AS (${anchor})`;
  }
  return `reach(entity, resource_id, perm) AS (
    ${anchor}
    UNION
    SELECT ae.target_entity, t.subject_id, ae.target_perm
    FROM reach r
    JOIN arrow_edges ae
      ON ae.entity = r.entity AND ae.perm = r.perm
    JOIN ${TUPLES} t
      ON t.namespace = ${b.value(forward.namespace)}
      AND t.resource_kind = r.entity
      AND t.resource_id = r.resource_id
      AND t.relation = ae.relation
      AND t.subject_kind = ae.target_entity
      AND t.subject_is_wildcard = 0
      AND t.subject_relation = ''
      AND ${activeTupleCondition("t", b, forward.nowMs)}
  )`;
}

function buildSubjectWalkCte(
  b: QueryBuilder,
  forward: ForwardCompileContext,
): string {
  return `subj_walk(resource_kind, resource_id, relation) AS (
    SELECT r.entity, r.resource_id, pr.relation
    FROM reach r
    JOIN pos_relations pr ON pr.entity = r.entity AND pr.perm = r.perm
    UNION
    SELECT t.subject_kind, t.subject_id, t.subject_relation
    FROM subj_walk sw
    JOIN ${TUPLES} t
      ON t.namespace = ${b.value(forward.namespace)}
      AND t.resource_kind = sw.resource_kind
      AND t.resource_id = sw.resource_id
      AND t.relation = sw.relation
      AND t.subject_is_wildcard = 0
      AND t.subject_relation <> ''
      AND ${activeTupleCondition("t", b, forward.nowMs)}
  )`;
}

function buildCandidatesCte(
  b: QueryBuilder,
  forward: ForwardCompileContext,
  subjectType: string,
): string {
  return `candidates(subject_id) AS (
    SELECT DISTINCT t.subject_id
    FROM subj_walk sw
    JOIN ${TUPLES} t
      ON t.namespace = ${b.value(forward.namespace)}
      AND t.resource_kind = sw.resource_kind
      AND t.resource_id = sw.resource_id
      AND t.relation = sw.relation
      AND t.subject_kind = ${b.value(subjectType)}
      AND t.subject_is_wildcard = 0
      AND t.subject_relation = ''
      AND ${activeTupleCondition("t", b, forward.nowMs)}
  )`;
}

function collectReachablePositiveGraph(
  model: SqliteAuthorizationModel,
  startEntity: string,
  startPermission: string,
): ReachableGraph {
  const visited = new Set<string>();
  const arrows = new Map<string, ArrowEdge>();
  const relations = new Map<string, PositiveRelation>();
  const queue: { readonly entity: string; readonly permission: string }[] = [
    { entity: startEntity, permission: startPermission },
  ];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const key = permissionKey(current.entity, current.permission);
    if (visited.has(key)) continue;
    visited.add(key);
    const definition = model.permissionByKey.get(key);
    if (definition === undefined) continue;
    collectPositiveFromExpression(
      current.entity,
      current.permission,
      definition.expression,
      arrows,
      relations,
      queue,
    );
  }
  return { arrows: [...arrows.values()], relations: [...relations.values()] };
}

function collectPositiveFromExpression(
  entity: string,
  permission: string,
  expression: SqlitePermissionExpression,
  arrows: Map<string, ArrowEdge>,
  relations: Map<string, PositiveRelation>,
  queue: { readonly entity: string; readonly permission: string }[],
): void {
  switch (expression.kind) {
    case "relation":
      relations.set(
        `${entity}\u0000${permission}\u0000${expression.relation}`,
        {
          entity,
          permission,
          relation: expression.relation,
        },
      );
      return;
    case "through":
    case "through-all":
      for (const target of expression.targets) {
        const edgeKey = `${entity}\u0000${permission}\u0000${expression.relation}\u0000${target.entity}\u0000${target.permission}`;
        arrows.set(edgeKey, {
          entity,
          permission,
          relation: expression.relation,
          targetEntity: target.entity,
          targetPermission: target.permission,
        });
        queue.push({ entity: target.entity, permission: target.permission });
      }
      return;
    case "exclude":
      collectPositiveFromExpression(
        entity,
        permission,
        expression.include,
        arrows,
        relations,
        queue,
      );
      return;
    case "any-of":
    case "all-of":
      for (const child of expression.expressions) {
        collectPositiveFromExpression(
          entity,
          permission,
          child,
          arrows,
          relations,
          queue,
        );
      }
      return;
  }
}
