import type { CompiledAccessPolicy } from "../compile-access-policy.js";
import { requireConcreteSubject } from "../postgres-response.js";
import type { PostgresQuery, PostgresRow } from "../postgres-types.js";
import {
  compilePostgresFilter,
  resolvePostgresFilterTarget,
  validatePostgresFilterQuery,
  type PostgresAccessFilter,
  type PostgresFilterQuery,
} from "./compile-filter.js";
import { resolvePostgresFilter } from "./resolve-filter.js";

const FALSE_FILTER: PostgresAccessFilter = Object.freeze({
  sql: "FALSE",
  values: [],
});

function preparePostgresFilter(policy: CompiledAccessPolicy, query: PostgresFilterQuery) {
  requireConcreteSubject(query.subject);
  const target = resolvePostgresFilterTarget(query);
  const validated = validatePostgresFilterQuery({ ...query, resourceType: target.resourceType }, policy.model);
  const permission = policy.permissionName(target.resourceType, target.permission);
  if (permission === undefined) return undefined;
  return {
    validated,
    normalized: {
      subject: { type: query.subject.type, id: query.subject.id },
      permission,
      resourceType: target.resourceType,
    },
  };
}

export function runCompilePostgresFilter(
  policy: CompiledAccessPolicy,
  namespace: string,
  query: PostgresFilterQuery,
): PostgresAccessFilter {
  const prepared = preparePostgresFilter(policy, query);
  if (prepared === undefined) return FALSE_FILTER;
  return compilePostgresFilter(policy.model, namespace, prepared.normalized, prepared.validated);
}

export async function runResolvePostgresFilter(
  policy: CompiledAccessPolicy,
  namespace: string,
  query: PostgresFilterQuery,
  executePlan: (planQuery: PostgresQuery) => Promise<readonly PostgresRow[]>,
): Promise<PostgresAccessFilter> {
  const prepared = preparePostgresFilter(policy, query);
  if (prepared === undefined) return FALSE_FILTER;
  return resolvePostgresFilter(policy.model, namespace, prepared.normalized, prepared.validated, executePlan, () =>
    compilePostgresFilter(policy.model, namespace, prepared.normalized, prepared.validated),
  );
}
