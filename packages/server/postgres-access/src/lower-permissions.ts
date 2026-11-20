import type { AccessIrDefinition, AccessIrTerm } from "@dads-framework/access";
import type {
  CompiledAuthorizationPermission,
  CompiledPermissionExpression,
} from "./policy/policy-model.js";

export type PermissionLowering = {
  readonly byName: ReadonlyMap<string, AccessIrDefinition>;
  readonly generated: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

type LowerTerm = (term: AccessIrTerm) => CompiledPermissionExpression;

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
    if (term.kind === "through") return lowerArrow(definition, context, term);
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
  term: Extract<AccessIrTerm, { kind: "through" }>,
): CompiledPermissionExpression {
  const role = definition.roles.find(({ name }) => name === term.roleName);
  const types =
    role?.subjects.filter((subject) => subject.kind === "type") ?? [];
  const [target] = types;
  if (target === undefined || types.length !== 1) {
    throw new Error(
      `Postgres arrow ${definition.wireName}#${term.roleName} requires one direct entity type`,
    );
  }
  const targetDefinition = context.byName.get(target.wireName);
  const name = targetDefinition?.permissions.some(
    ({ name }) => name === term.targetPermission,
  )
    ? term.targetPermission
    : context.generated.get(target.wireName)?.get(term.targetPermission);
  if (name === undefined) {
    throw new Error(
      `Unknown arrow target ${target.wireName}#${term.targetPermission}`,
    );
  }
  return { kind: "through", relation: term.roleName, permission: name };
}

function lowerLocal(
  term: Exclude<AccessIrTerm, { kind: "permission" | "through" }>,
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
