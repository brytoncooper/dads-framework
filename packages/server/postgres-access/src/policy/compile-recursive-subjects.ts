import type { AuthorizationModelDefinition, CompiledPermissionExpression } from "./policy-model.js";
import { findColumnRelation } from "./column-relations.js";
import type { RecursiveEdge, RecursiveNodePlan, RecursiveSccPlan } from "./permission-cycles.js";
import { type LazySqlParam, notExpired, TUPLES, type QueryBuilder } from "./policy-sql.js";

export type SubjectResourceRef = {
  readonly type: string;
  readonly id: string;
  readonly entity: string;
};

export type CompileSubjectExpr = (resource: SubjectResourceRef, expression: CompiledPermissionExpression) => string;

export type CompileSubjectAllOf = (
  resource: SubjectResourceRef,
  expressions: readonly CompiledPermissionExpression[],
) => string;

export type RecursiveSubjectInput = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespace: LazySqlParam;
  readonly resource: SubjectResourceRef;
  readonly entryPermission: string;
  readonly scc: RecursiveSccPlan;
  readonly compileExpr: CompileSubjectExpr;
  readonly compileAllOf: CompileSubjectAllOf;
};

/**
 * Compiles transitive subject lookup for a monotonic permission SCC.
 * Uses top-down `UNION` walk for unguarded SCCs, and bounded bottom-up
 * propagation when edges carry non-recursive guards.
 */
export function compileRecursiveSubjectLookup(input: RecursiveSubjectInput): string {
  input.builder.markRecursive();
  if (input.scc.edges.some((edge) => edge.guards.length > 0)) {
    return compileGuardedRecursiveSubjects(input);
  }
  const walkAlias = input.builder.cteAlias("rec_sub_walk");
  const walkSql = compileRecursiveWalkCte(input, walkAlias);
  const baseBranches = input.scc.nodes
    .filter((node) => node.base !== undefined)
    .map((node) => compileBaseSubjectBranch(input, node, "reached"));
  return `WITH RECURSIVE ${walkSql}
    SELECT DISTINCT sub.subject_id, sub.is_wildcard
    FROM ${walkAlias} reached
    CROSS JOIN LATERAL (${baseBranches.join(" UNION ")}) sub`;
}

function compileGuardedRecursiveSubjects(input: RecursiveSubjectInput): string {
  const { builder, resource, entryPermission, scc } = input;
  const walkAlias = builder.cteAlias("rec_sub_nodes");
  const propAlias = builder.cteAlias("rec_sub_prop");
  const walkSql = compileRecursiveWalkCte(input, walkAlias);
  const baseAnchors = scc.nodes
    .filter((node) => node.base !== undefined)
    .map((node) => compileGuardedAnchor(input, walkAlias, node));
  const stepSelects = scc.edges.map((edge) => compileGuardedSubjectEdge(input, walkAlias, edge));
  const entryEntitySql = builder.value(resource.entity);
  const entryPermSql = builder.value(entryPermission);
  return `WITH RECURSIVE ${walkSql},
    ${propAlias}(resource_kind, resource_id, permission_name, subject_id, is_wildcard) AS (
      ${baseAnchors.join(" UNION ")}
      UNION
      SELECT step.resource_kind, step.resource_id, step.permission_name, step.subject_id, step.is_wildcard
      FROM ${propAlias} parent_sub
      CROSS JOIN LATERAL (${stepSelects.join(" UNION ")}) step
    )
    SELECT DISTINCT subject_id, is_wildcard
    FROM ${propAlias}
    WHERE resource_kind = ${entryEntitySql}
      AND resource_id = (${resource.id})::text
      AND permission_name = ${entryPermSql}`;
}

function compileGuardedAnchor(input: RecursiveSubjectInput, walkAlias: string, node: RecursiveNodePlan): string {
  const entitySql = input.builder.value(node.entity);
  const permSql = input.builder.value(node.permission);
  const branch = compileBaseSubjectBranch(input, node, "reached");
  return `SELECT reached.resource_kind, reached.resource_id, ${permSql}::text AS permission_name, sub.subject_id, sub.is_wildcard
    FROM ${walkAlias} reached
    CROSS JOIN LATERAL (${branch}) sub
    WHERE reached.resource_kind = ${entitySql} AND reached.permission_name = ${permSql}`;
}

function compileGuardedSubjectEdge(input: RecursiveSubjectInput, walkAlias: string, edge: RecursiveEdge): string {
  const { builder } = input;
  const columnRel = findColumnRelation(input.model, edge.fromEntity, edge.relation);
  if (columnRel !== undefined && columnRel.targetEntity !== edge.toEntity) {
    return `SELECT ''::text AS resource_kind, ''::text AS resource_id, ''::text AS permission_name, ''::text AS subject_id, false AS is_wildcard WHERE false`;
  }
  const tupleAlias = builder.throughAlias();
  const fromEntity = builder.value(edge.fromEntity);
  const fromPerm = builder.value(edge.fromPermission);
  const toEntity = builder.value(edge.toEntity);
  const toPerm = builder.value(edge.toPermission);
  const guardJoin = compileGuardSubjectJoin(input, edge);
  const outSub = edge.guards.length > 0 ? "guarded" : "parent_sub";
  if (columnRel !== undefined) {
    return `SELECT child_node.resource_kind, child_node.resource_id, ${fromPerm}::text AS permission_name, ${outSub}.subject_id, ${outSub}.is_wildcard
      FROM ${walkAlias} child_node
      JOIN ${columnRel.table} ${tupleAlias}
        ON ${tupleAlias}.${columnRel.idColumn}::text = child_node.resource_id
        AND ${tupleAlias}.${columnRel.targetIdColumn}::text = parent_sub.resource_id
        AND ${tupleAlias}.${columnRel.targetIdColumn} IS NOT NULL
      ${guardJoin}
      WHERE child_node.resource_kind = ${fromEntity}
        AND child_node.permission_name = ${fromPerm}
        AND parent_sub.resource_kind = ${toEntity}
        AND parent_sub.permission_name = ${toPerm}`;
  }
  const namespace = input.namespace();
  const relation = builder.value(edge.relation);
  return `SELECT child_node.resource_kind, child_node.resource_id, ${fromPerm}::text AS permission_name, ${outSub}.subject_id, ${outSub}.is_wildcard
    FROM ${walkAlias} child_node
    JOIN ${TUPLES} ${tupleAlias}
      ON ${tupleAlias}.namespace = ${namespace}
      AND ${tupleAlias}.resource_kind = child_node.resource_kind
      AND ${tupleAlias}.resource_id = child_node.resource_id
      AND ${tupleAlias}.relation = ${relation}
      AND ${tupleAlias}.subject_kind = parent_sub.resource_kind
      AND ${tupleAlias}.subject_id = parent_sub.resource_id
      AND ${tupleAlias}.subject_is_wildcard = false
      AND ${tupleAlias}.subject_relation = ''
      AND ${notExpired(tupleAlias)}
    ${guardJoin}
    WHERE child_node.resource_kind = ${fromEntity}
      AND child_node.permission_name = ${fromPerm}
      AND parent_sub.resource_kind = ${toEntity}
      AND parent_sub.permission_name = ${toPerm}`;
}

function compileGuardSubjectJoin(input: RecursiveSubjectInput, edge: RecursiveEdge): string {
  if (edge.guards.length === 0) return "";
  const guardRef: SubjectResourceRef = {
    type: "child_node.resource_kind",
    id: "child_node.resource_id",
    entity: edge.fromEntity,
  };
  const guardSql = input.compileAllOf(guardRef, edge.guards);
  return `CROSS JOIN LATERAL (
      SELECT CASE WHEN parent_sub.is_wildcard THEN g.subject_id ELSE parent_sub.subject_id END AS subject_id,
        (parent_sub.is_wildcard AND g.is_wildcard) AS is_wildcard
      FROM (${guardSql}) g
      WHERE (parent_sub.is_wildcard AND g.is_wildcard)
        OR (NOT parent_sub.is_wildcard AND (g.is_wildcard OR (NOT g.is_wildcard AND g.subject_id = parent_sub.subject_id)))
        OR (parent_sub.is_wildcard AND NOT g.is_wildcard)
    ) guarded`;
}

function compileRecursiveWalkCte(input: RecursiveSubjectInput, walkAlias: string): string {
  const { builder, resource, entryPermission, scc } = input;
  const entryEntitySql = builder.value(resource.entity);
  const entryPermSql = builder.value(entryPermission);
  const edgeSelects = scc.edges.map((edge) => compileWalkEdge(input, edge));
  return `${walkAlias}(resource_kind, resource_id, permission_name) AS (
    SELECT ${entryEntitySql}::text, (${resource.id})::text, ${entryPermSql}::text
    WHERE (${resource.type})::text = ${entryEntitySql}::text
    UNION
    SELECT next_node.resource_kind, next_node.resource_id, next_node.permission_name
    FROM ${walkAlias} current_node
    CROSS JOIN LATERAL (${edgeSelects.join(" UNION ALL ")} OFFSET 0) next_node
  )`;
}

function compileWalkEdge(input: RecursiveSubjectInput, edge: RecursiveEdge): string {
  const { builder } = input;
  const columnRel = findColumnRelation(input.model, edge.fromEntity, edge.relation);
  if (columnRel !== undefined && columnRel.targetEntity !== edge.toEntity) {
    return `SELECT ''::text AS resource_kind, ''::text AS resource_id, ''::text AS permission_name WHERE false`;
  }
  const tupleAlias = builder.throughAlias();
  const fromEntity = builder.value(edge.fromEntity);
  const fromPerm = builder.value(edge.fromPermission);
  const toEntity = builder.value(edge.toEntity);
  const toPerm = builder.value(edge.toPermission);
  if (columnRel !== undefined) {
    return `SELECT ${toEntity}::text AS resource_kind, ${tupleAlias}.${columnRel.targetIdColumn}::text AS resource_id, ${toPerm}::text AS permission_name
      FROM ${columnRel.table} ${tupleAlias}
      WHERE current_node.resource_kind = ${fromEntity}
        AND current_node.permission_name = ${fromPerm}
        AND ${tupleAlias}.${columnRel.idColumn}::text = current_node.resource_id
        AND ${tupleAlias}.${columnRel.targetIdColumn} IS NOT NULL`;
  }
  const namespace = input.namespace();
  const relation = builder.value(edge.relation);
  return `SELECT ${tupleAlias}.subject_kind AS resource_kind, ${tupleAlias}.subject_id AS resource_id, ${toPerm}::text AS permission_name
    FROM ${TUPLES} ${tupleAlias}
    WHERE current_node.resource_kind = ${fromEntity}
      AND current_node.permission_name = ${fromPerm}
      AND ${tupleAlias}.namespace = ${namespace}
      AND ${tupleAlias}.resource_kind = current_node.resource_kind
      AND ${tupleAlias}.resource_id = current_node.resource_id
      AND ${tupleAlias}.relation = ${relation}
      AND ${tupleAlias}.subject_kind = ${toEntity}
      AND ${tupleAlias}.subject_is_wildcard = false
      AND ${tupleAlias}.subject_relation = ''
      AND ${notExpired(tupleAlias)}`;
}

function compileBaseSubjectBranch(input: RecursiveSubjectInput, node: RecursiveNodePlan, nodeAlias: string): string {
  if (node.base === undefined) {
    return "SELECT ''::text AS subject_id, false AS is_wildcard WHERE false";
  }
  const entitySql = input.builder.value(node.entity);
  const permSql = input.builder.value(node.permission);
  const baseSql = input.compileExpr(
    {
      type: `${nodeAlias}.resource_kind`,
      id: `${nodeAlias}.resource_id`,
      entity: node.entity,
    },
    node.base,
  );
  return `SELECT s.subject_id, s.is_wildcard FROM (${baseSql}) s WHERE ${nodeAlias}.resource_kind = ${entitySql} AND ${nodeAlias}.permission_name = ${permSql}`;
}
