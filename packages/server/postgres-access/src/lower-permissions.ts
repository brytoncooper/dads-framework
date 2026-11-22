import type { AccessIrDefinition, AccessIrTerm } from "@dads-framework/access";
import type {
  CompiledArrowTarget,
  CompiledAuthorizationPermission,
  CompiledPermissionExpression,
} from "./policy/policy-model.js";

export type PermissionLowering = {
  readonly byName: ReadonlyMap<string, AccessIrDefinition>;
  readonly generated: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

type LowerTerm = (term: AccessIrTerm) => CompiledPermissionExpression;
type ArrowTerm = Extract<AccessIrTerm, { kind: "through" | "through-all" }>;

export function lowerPermissions(
  definition: AccessIrDefinition,
  context: PermissionLowering,
): readonly CompiledAuthorizationPermission[] {
  const byName = new Map(
    definition.permissions.map((entry) => [entry.name, entry.terms]),
  );
  const cached = new Map<string, CompiledPermissionExpression>();
  const visiting = new Set<string>();

  function permission(name: string): CompiledPermissionExpression {
    const existing = cached.get(name);
    if (existing !== undefined) return existing;
    if (visiting.has(name))
      throw new Error(
        `Cyclic permission reference ${definition.wireName}#${name}`,
      );
    const terms = byName.get(name);
    if (terms === undefined)
      throw new Error(`Unknown permission ${definition.wireName}#${name}`);
    visiting.add(name);
    const compiled = group("any-of", terms.map(lower));
    visiting.delete(name);
    cached.set(name, compiled);
    return compiled;
  }

  function lower(term: AccessIrTerm): CompiledPermissionExpression {
    if (term.kind === "permission") return permission(term.name);
    if (term.kind === "through" || term.kind === "through-all")
      return lowerArrow(definition, context, term);
    return lowerLocal(term, lower);
  }

  return definition.permissions.map(({ name }, index) => ({
    entity: definition.wireName,
    sourceName: `permission_${index}`,
    wireName: name,
    expression: permission(name),
  }));
}

function lowerArrow(
  definition: AccessIrDefinition,
  context: PermissionLowering,
  term: ArrowTerm,
): CompiledPermissionExpression {
  const role = definition.roles.find(({ name }) => name === term.roleName);
  const entityNames = uniqueDirectEntityNames(role?.subjects ?? []);
  if (entityNames.length === 0) {
    throw new Error(
      `Postgres arrow ${definition.wireName}#${term.roleName} requires at least one direct entity type`,
    );
  }
  const targets = resolveTargetPermissions(
    entityNames,
    term.targetPermission,
    context,
  );
  if (targets.length === 0) {
    throw new Error(
      `Unknown arrow target ${definition.wireName}#${term.roleName}->${term.targetPermission}`,
    );
  }
  return {
    kind: term.kind,
    relation: term.roleName,
    permission: term.targetPermission,
    targets,
  };
}

function uniqueDirectEntityNames(
  subjects: AccessIrDefinition["roles"][number]["subjects"],
): readonly string[] {
  const names = new Set<string>();
  for (const subject of subjects) {
    if (subject.kind === "type") names.add(subject.wireName);
  }
  return [...names];
}

function resolveTargetPermissions(
  entityNames: readonly string[],
  targetPermission: string,
  context: PermissionLowering,
): readonly CompiledArrowTarget[] {
  const targets: CompiledArrowTarget[] = [];
  for (const entity of entityNames) {
    const resolved = findTargetPermission(entity, targetPermission, context);
    if (resolved !== undefined) {
      targets.push({ entity, permission: resolved });
    }
  }
  return targets;
}

function findTargetPermission(
  entity: string,
  targetPermission: string,
  context: PermissionLowering,
): string | undefined {
  const targetDefinition = context.byName.get(entity);
  if (
    targetDefinition?.permissions.some(({ name }) => name === targetPermission)
  )
    return targetPermission;
  return context.generated.get(entity)?.get(targetPermission);
}

function lowerLocal(
  term: Exclude<
    AccessIrTerm,
    { kind: "permission" | "through" | "through-all" }
  >,
  lower: LowerTerm,
): CompiledPermissionExpression {
  switch (term.kind) {
    case "role":
      return { kind: "relation", relation: term.name };
    case "or":
      return group("any-of", term.terms.map(lower));
    case "both":
      return group("all-of", [lower(term.left), lower(term.right)]);
    case "gated":
      return group("all-of", [lower(term.term), lower(term.condition)]);
    case "excluding":
      return {
        kind: "exclude",
        include: lower(term.term),
        exclude: lower(term.banned),
      };
  }
}

function group(
  kind: "any-of" | "all-of",
  expressions: readonly CompiledPermissionExpression[],
): CompiledPermissionExpression {
  if (expressions.length === 0)
    throw new Error(
      "Postgres authorization requires nonempty permission expressions",
    );
  const [only] = expressions;
  return expressions.length === 1 && only !== undefined
    ? only
    : { kind, expressions };
}
