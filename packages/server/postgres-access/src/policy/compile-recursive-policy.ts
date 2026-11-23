import type { AuthorizationModelDefinition, CompiledPermissionExpression } from "./policy-model.js";
import type { RecursiveEdge, RecursiveNodePlan, RecursiveSccPlan } from "./permission-cycles.js";
import { findColumnRelation } from "./column-relations.js";
import { notExpired, TUPLES, type QueryBuilder } from "./policy-sql.js";

export type RecursiveResourceRef = {
  readonly type: string;
  readonly id: string;
  readonly entity: string;
};

type CompileForwardExpression = (resource: RecursiveResourceRef, expression: CompiledPermissionExpression) => string;

type CompileReverseExpression = (entity: string, expression: CompiledPermissionExpression) => string;

export type RecursiveForwardInput = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly resource: RecursiveResourceRef;
  readonly entryEntity: string;
  readonly entryPermission: string;
  readonly scc: RecursiveSccPlan;
  readonly compileExpression: CompileForwardExpression;
};

export type RecursiveReverseInput = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly entryEntity: string;
  readonly entryPermission: string;
  readonly scc: RecursiveSccPlan;
  readonly compileExpression: CompileReverseExpression;
};

export type RecursiveSharedInput = {
  readonly model: AuthorizationModelDefinition;
  readonly builder: QueryBuilder;
  readonly namespace: string;
  readonly cteName: string;
  readonly scc: RecursiveSccPlan;
  readonly baseAliases: ReadonlyMap<string, string>;
  readonly guardAliases: ReadonlyMap<CompiledPermissionExpression, string>;
};

/**
 * Compiles a monotonic permission SCC into a top-down recursive EXISTS check.
 * SQL UNION deduplicates `(resource_kind, resource_id, permission_name)` so
 * cyclic tuple graphs terminate safely.
 */
export function compileRecursiveForwardCheck(input: RecursiveForwardInput): string {
  const { builder, scc } = input;
  builder.markRecursive();
  const walkAlias = builder.cteAlias("rec_walk");
  const entryEntitySql = builder.value(input.entryEntity);
  const entryPermSql = builder.value(input.entryPermission);
  const edgeSelects = scc.edges.map((edge) => compileForwardEdge(input, edge, "current_node"));
  const baseBranches = scc.nodes
    .filter((node) => node.base !== undefined)
    .map((node) => compileForwardBaseBranch(input, node));
  return `EXISTS (WITH RECURSIVE ${walkAlias}(resource_kind, resource_id, permission_name) AS (
    SELECT ${entryEntitySql}::text, (${input.resource.id})::text, ${entryPermSql}::text
    WHERE (${input.resource.type})::text = ${entryEntitySql}::text
    UNION
    SELECT next_node.resource_kind, next_node.resource_id, next_node.permission_name
    FROM ${walkAlias} current_node
    CROSS JOIN LATERAL (
      ${edgeSelects.join(" UNION ALL ")}
      OFFSET 0
    ) next_node
  )
  SELECT 1
  FROM ${walkAlias} reached
  WHERE (${baseBranches.join(" OR ")})
  LIMIT 1)`;
}

function compileForwardEdge(input: RecursiveForwardInput, edge: RecursiveEdge, nodeAlias: string): string {
  const { builder, namespace } = input;
  const tupleAlias = builder.throughAlias();
  const fromEntity = builder.value(edge.fromEntity);
  const fromPerm = builder.value(edge.fromPermission);
  const toEntity = builder.value(edge.toEntity);
  const toPerm = builder.value(edge.toPermission);
  const guardSql = compileForwardGuards(input, edge, nodeAlias);
  const columnRel = findColumnRelation(input.model, edge.fromEntity, edge.relation);
  if (columnRel !== undefined && columnRel.targetEntity === edge.toEntity) {
    return `SELECT ${toEntity}::text AS resource_kind, ${tupleAlias}.${columnRel.targetIdColumn} AS resource_id, ${toPerm}::text AS permission_name
      FROM ${columnRel.table} ${tupleAlias}
      WHERE ${nodeAlias}.resource_kind = ${fromEntity}
        AND ${nodeAlias}.permission_name = ${fromPerm}
        AND ${tupleAlias}.${columnRel.idColumn} = ${nodeAlias}.resource_id
        AND ${tupleAlias}.${columnRel.targetIdColumn} IS NOT NULL${guardSql}`;
  }
  const relation = builder.value(edge.relation);
  return `SELECT ${tupleAlias}.subject_kind AS resource_kind, ${tupleAlias}.subject_id AS resource_id, ${toPerm}::text AS permission_name
    FROM ${TUPLES} ${tupleAlias}
    WHERE ${nodeAlias}.resource_kind = ${fromEntity}
      AND ${nodeAlias}.permission_name = ${fromPerm}
      AND ${tupleAlias}.namespace = ${namespace}
      AND ${tupleAlias}.resource_kind = ${nodeAlias}.resource_kind
      AND ${tupleAlias}.resource_id = ${nodeAlias}.resource_id
      AND ${tupleAlias}.relation = ${relation}
      AND ${tupleAlias}.subject_kind = ${toEntity}
      AND ${tupleAlias}.subject_is_wildcard = false
      AND ${tupleAlias}.subject_relation = ''
      AND ${notExpired(tupleAlias)}${guardSql}`;
}

function compileForwardGuards(input: RecursiveForwardInput, edge: RecursiveEdge, nodeAlias: string): string {
  if (edge.guards.length === 0) return "";
  const ref: RecursiveResourceRef = {
    type: `${nodeAlias}.resource_kind`,
    id: `${nodeAlias}.resource_id`,
    entity: edge.fromEntity,
  };
  const checks = edge.guards.map((guard) => `(${input.compileExpression(ref, guard)})`);
  return ` AND ${checks.join(" AND ")}`;
}

function compileForwardBaseBranch(input: RecursiveForwardInput, node: RecursiveNodePlan): string {
  if (node.base === undefined) return "false";
  const entitySql = input.builder.value(node.entity);
  const permSql = input.builder.value(node.permission);
  const ref: RecursiveResourceRef = {
    type: "reached.resource_kind",
    id: "reached.resource_id",
    entity: node.entity,
  };
  const expr = input.compileExpression(ref, node.base);
  return `(reached.resource_kind = ${entitySql} AND reached.permission_name = ${permSql} AND (${expr}))`;
}

/**
 * Compiles a monotonic permission SCC into an actor-first bottom-up recursive
 * query returning allowed `resource_id` values for `(entryEntity, entryPermission)`.
 */
export function compileRecursiveReverseLookup(input: RecursiveReverseInput): string {
  const { builder, scc } = input;
  builder.markRecursive();
  const allowedAlias = builder.cteAlias("rec_allowed");
  const baseAnchors = scc.nodes
    .filter((node) => node.base !== undefined)
    .map((node) => compileReverseBaseAnchor(input, node));
  const edgeSelects = scc.edges.map((edge) => compileReverseEdge(input, edge));
  const entryEntitySql = builder.value(input.entryEntity);
  const entryPermSql = builder.value(input.entryPermission);
  return `SELECT DISTINCT reached.resource_id
    FROM (
      WITH RECURSIVE ${allowedAlias}(resource_kind, resource_id, permission_name) AS (
        ${baseAnchors.join(" UNION ")}
        UNION
        SELECT child.resource_kind, child.resource_id, child.permission_name
        FROM ${allowedAlias} parent_node
        CROSS JOIN LATERAL (
          ${edgeSelects.join(" UNION ALL ")}
          OFFSET 0
        ) child
      )
      SELECT resource_id
      FROM ${allowedAlias}
      WHERE resource_kind = ${entryEntitySql} AND permission_name = ${entryPermSql}
    ) reached`;
}

function compileReverseBaseAnchor(input: RecursiveReverseInput, node: RecursiveNodePlan): string {
  if (node.base === undefined) {
    return "SELECT ''::text, ''::text, ''::text WHERE false";
  }
  const entitySql = input.builder.value(node.entity);
  const permSql = input.builder.value(node.permission);
  const baseQuery = input.compileExpression(node.entity, node.base);
  return `SELECT ${entitySql}::text AS resource_kind, base_row.resource_id, ${permSql}::text AS permission_name
    FROM (${baseQuery}) base_row`;
}

function compileReverseEdge(input: RecursiveReverseInput, edge: RecursiveEdge): string {
  const { builder, namespace } = input;
  const tupleAlias = builder.throughAlias();
  const fromEntity = builder.value(edge.fromEntity);
  const fromPerm = builder.value(edge.fromPermission);
  const toEntity = builder.value(edge.toEntity);
  const toPerm = builder.value(edge.toPermission);
  const columnRel = findColumnRelation(input.model, edge.fromEntity, edge.relation);
  if (columnRel !== undefined && columnRel.targetEntity === edge.toEntity) {
    const guardSql = compileReverseGuards(input, edge, `${tupleAlias}.${columnRel.idColumn}`);
    return `SELECT ${fromEntity}::text AS resource_kind, ${tupleAlias}.${columnRel.idColumn} AS resource_id, ${fromPerm}::text AS permission_name
      FROM ${columnRel.table} ${tupleAlias}
      WHERE parent_node.resource_kind = ${toEntity}
        AND parent_node.permission_name = ${toPerm}
        AND ${tupleAlias}.${columnRel.targetIdColumn} = parent_node.resource_id${guardSql}`;
  }
  const relation = builder.value(edge.relation);
  const guardSql = compileReverseGuards(input, edge, `${tupleAlias}.resource_id`);
  return `SELECT ${tupleAlias}.resource_kind, ${tupleAlias}.resource_id, ${fromPerm}::text AS permission_name
    FROM ${TUPLES} ${tupleAlias}
    WHERE parent_node.resource_kind = ${toEntity}
      AND parent_node.permission_name = ${toPerm}
      AND ${tupleAlias}.namespace = ${namespace}
      AND ${tupleAlias}.resource_kind = ${fromEntity}
      AND ${tupleAlias}.relation = ${relation}
      AND ${tupleAlias}.subject_kind = parent_node.resource_kind
      AND ${tupleAlias}.subject_id = parent_node.resource_id
      AND ${tupleAlias}.subject_is_wildcard = false
      AND ${tupleAlias}.subject_relation = ''
      AND ${notExpired(tupleAlias)}${guardSql}`;
}

function compileReverseGuards(input: RecursiveReverseInput, edge: RecursiveEdge, idExpr: string): string {
  if (edge.guards.length === 0) return "";
  const checks = edge.guards.map((guard) => {
    const query = input.compileExpression(edge.fromEntity, guard);
    return `EXISTS (SELECT 1 FROM (${query}) guard_row WHERE guard_row.resource_id = ${idExpr})`;
  });
  return ` AND ${checks.join(" AND ")}`;
}

/** Compiles the recursive CTE body for a shared point-check plan. */
export function compileRecursiveSharedBody(input: RecursiveSharedInput): string {
  const { builder, cteName, scc, baseAliases } = input;
  builder.markRecursive();
  const anchors = scc.nodes
    .filter((node) => baseAliases.has(node.identity))
    .map((node) => {
      const alias = baseAliases.get(node.identity) ?? "";
      const entitySql = builder.value(node.entity);
      const permSql = builder.value(node.permission);
      return `SELECT resource_kind, resource_id, ${permSql}::text AS permission_name FROM ${alias} WHERE resource_kind = ${entitySql}`;
    });
  const edges = scc.edges.map((edge) => compileSharedEdge(input, edge));
  return `${anchors.join(" UNION ")}
    UNION
    SELECT child.resource_kind, child.resource_id, child.permission_name
    FROM ${cteName} parent_node
    CROSS JOIN LATERAL (
      ${edges.join(" UNION ALL ")}
      OFFSET 0
    ) child`;
}

function compileSharedEdge(input: RecursiveSharedInput, edge: RecursiveEdge): string {
  const { builder, namespace, guardAliases } = input;
  const tupleAlias = builder.throughAlias();
  const fromEntity = builder.value(edge.fromEntity);
  const fromPerm = builder.value(edge.fromPermission);
  const toEntity = builder.value(edge.toEntity);
  const toPerm = builder.value(edge.toPermission);
  const columnRel = findColumnRelation(input.model, edge.fromEntity, edge.relation);
  if (columnRel !== undefined && columnRel.targetEntity === edge.toEntity) {
    const colGuards = edge.guards.map((guard) => {
      const alias = guardAliases.get(guard) ?? "";
      return `EXISTS (SELECT 1 FROM ${alias} guard_row WHERE guard_row.resource_kind = ${fromEntity} AND guard_row.resource_id = ${tupleAlias}.${columnRel.idColumn})`;
    });
    const guardSql = colGuards.length > 0 ? ` AND ${colGuards.join(" AND ")}` : "";
    return `SELECT ${fromEntity}::text AS resource_kind, ${tupleAlias}.${columnRel.idColumn} AS resource_id, ${fromPerm}::text AS permission_name
      FROM ${columnRel.table} ${tupleAlias}
      WHERE parent_node.resource_kind = ${toEntity}
        AND parent_node.permission_name = ${toPerm}
        AND ${tupleAlias}.${columnRel.targetIdColumn} = parent_node.resource_id${guardSql}`;
  }
  const relation = builder.value(edge.relation);
  const guardChecks = edge.guards.map((guard) => {
    const alias = guardAliases.get(guard) ?? "";
    return `EXISTS (SELECT 1 FROM ${alias} guard_row WHERE guard_row.resource_kind = ${tupleAlias}.resource_kind AND guard_row.resource_id = ${tupleAlias}.resource_id)`;
  });
  const guardSql = guardChecks.length > 0 ? ` AND ${guardChecks.join(" AND ")}` : "";
  return `SELECT ${tupleAlias}.resource_kind, ${tupleAlias}.resource_id, ${fromPerm}::text AS permission_name
    FROM ${TUPLES} ${tupleAlias}
    WHERE parent_node.resource_kind = ${toEntity}
      AND parent_node.permission_name = ${toPerm}
      AND ${tupleAlias}.namespace = ${namespace}
      AND ${tupleAlias}.resource_kind = ${fromEntity}
      AND ${tupleAlias}.relation = ${relation}
      AND ${tupleAlias}.subject_kind = parent_node.resource_kind
      AND ${tupleAlias}.subject_id = parent_node.resource_id
      AND ${tupleAlias}.subject_is_wildcard = false
      AND ${tupleAlias}.subject_relation = ''
      AND ${notExpired(tupleAlias)}${guardSql}`;
}
