import type {
  ZedRelation,
  ZedSchemaSurface,
} from "./parse-zed-schema-surface.js";

export type SchemaContractionPlan = {
  removedTypes: readonly string[];
  removedRelations: readonly ZedRelation[];
};

/** Names definitions and relations present in live schema and absent from desired. */
export function planSchemaContraction(
  live: ZedSchemaSurface,
  desired: ZedSchemaSurface,
): SchemaContractionPlan {
  const removedTypes = [...live.resourceTypes]
    .filter((resourceType) => !desired.resourceTypes.has(resourceType))
    .sort((left, right) => left.localeCompare(right));

  const desiredRelations = new Set(
    desired.relations.map((entry) => relationKey(entry)),
  );
  const removedRelations = live.relations.filter((entry) => {
    if (!desired.resourceTypes.has(entry.resourceType)) {
      return false;
    }
    return !desiredRelations.has(relationKey(entry));
  });

  return { removedTypes, removedRelations };
}

export function contractionPlanIsEmpty(plan: SchemaContractionPlan): boolean {
  return plan.removedTypes.length === 0 && plan.removedRelations.length === 0;
}

function relationKey(entry: ZedRelation): string {
  return `${entry.resourceType}#${entry.relation}`;
}
