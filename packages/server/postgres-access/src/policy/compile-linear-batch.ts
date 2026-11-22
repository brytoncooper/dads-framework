import type { AuthorizationModelDefinition } from "./policy-model.js";
import type { QueryBuilder } from "./policy-sql.js";
import { compileSharedPointRows } from "./compile-shared-point-check.js";

type LinearBatchBranch = {
  readonly namespace: string;
  readonly resourceType: string;
  readonly permission: string;
  readonly index: number;
};

/** Evaluate a deep linear policy once for each actor in this batch branch. */
export function compileLinearBatchBranch(
  model: AuthorizationModelDefinition,
  builder: QueryBuilder,
  { namespace, resourceType, permission, index }: LinearBatchBranch,
): { readonly hits: string; readonly join: string; readonly decision: string } {
  const resourceKind = builder.value(resourceType);
  const permissionName = builder.value(permission);
  const branch = `i.resource_kind = ${resourceKind} AND i.permission = ${permissionName}`;
  const hits = `linear_hits_${String(index)}`;
  const permitted = compileSharedPointRows(model, builder, {
    namespace,
    subjectKind: "actor.subject_kind",
    subjectId: "actor.subject_id",
    resourceEntity: resourceType,
    permission,
  });
  return {
    hits: `${hits} AS MATERIALIZED (
      SELECT DISTINCT actor.subject_kind, actor.subject_id, permitted.resource_id
      FROM (
        SELECT subject_kind, subject_id, array_agg(DISTINCT resource_id) AS resource_ids
        FROM input i WHERE ${branch}
        GROUP BY subject_kind, subject_id
      ) AS actor
      CROSS JOIN LATERAL (${permitted}) AS permitted
      WHERE permitted.resource_kind = ${resourceKind}
        AND permitted.resource_id = ANY(actor.resource_ids)
    )`,
    join: `LEFT JOIN ${hits} ON ${branch} AND ${hits}.subject_kind = i.subject_kind AND ${hits}.subject_id = i.subject_id AND ${hits}.resource_id = i.resource_id`,
    decision: `WHEN ${branch} THEN (${hits}.resource_id IS NOT NULL)`,
  };
}
