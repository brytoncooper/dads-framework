import type { AccessIrDefinition, AccessIrPermission, AccessIrTerm } from "./ir.js";
import {
  formatPropAccess,
  formatPropKey,
  isJsReservedWord,
  isValidJsIdentifier,
  toCamelCase,
  type ErgonomicSymbols,
} from "./emit-typescript-symbols.js";

const RESERVED_ROLE_REF_PROPS = new Set([
  "kind",
  "term",
  "or",
  "and",
  "unless",
  "$roleToken",
  "$targetPerms",
  "then",
  "toJSON",
]);

const CAN_HELPER_NAMES = new Set(["anyOf", "allOf", "every", "permissionToken"]);

export type ErgonomicTermContext = {
  readonly symbols: ErgonomicSymbols;
  readonly valueImports: Set<string>;
};

type RoleBinding = {
  readonly propName: string;
  readonly varName: string;
};

type CanScope = {
  readonly owner: AccessIrDefinition;
  readonly varByRoleName: ReadonlyMap<string, string>;
};

type EmittedTerm = {
  readonly code: string;
  readonly isDslTerm: boolean;
};

export function childIrTermsOf(term: AccessIrTerm): readonly AccessIrTerm[] {
  if (term.kind === "or") return term.terms;
  if (term.kind === "excluding") return [term.term, term.banned];
  if (term.kind === "gated") return [term.term, term.condition];
  if (term.kind === "both") return [term.left, term.right];
  return [];
}

function collectTermRoles(term: AccessIrTerm, declaredRoleNames: ReadonlySet<string>, out: Set<string>): void {
  if (term.kind === "role" || term.kind === "permission") {
    if (declaredRoleNames.has(term.name)) out.add(term.name);
    return;
  }
  if (term.kind === "through" || term.kind === "through-all") {
    if (declaredRoleNames.has(term.roleName)) out.add(term.roleName);
    return;
  }
  for (const child of childIrTermsOf(term)) {
    collectTermRoles(child, declaredRoleNames, out);
  }
}

function allocateSafeBindingName(roleName: string, used: Set<string>): string {
  const preferred =
    isValidJsIdentifier(roleName) && !isJsReservedWord(roleName) && !CAN_HELPER_NAMES.has(roleName)
      ? roleName
      : `${toCamelCase(roleName)}Role`;
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let index = 2;
  while (used.has(`${preferred}_${index}`)) {
    index += 1;
  }
  const candidate = `${preferred}_${index}`;
  used.add(candidate);
  return candidate;
}

function buildRoleBindings(
  definition: AccessIrDefinition,
  permissions: readonly AccessIrPermission[],
): readonly RoleBinding[] {
  const declaredRoleNames = new Set(definition.roles.map((role) => role.name));
  const referenced = new Set<string>();
  for (const permission of permissions) {
    for (const term of permission.terms) {
      collectTermRoles(term, declaredRoleNames, referenced);
    }
  }
  const used = new Set<string>(CAN_HELPER_NAMES);
  const bindings: RoleBinding[] = [];
  for (const role of definition.roles) {
    if (!referenced.has(role.name)) continue;
    bindings.push({
      propName: role.name,
      varName: allocateSafeBindingName(role.name, used),
    });
  }
  return bindings;
}

function supportsDirectArrow(
  ctx: ErgonomicTermContext,
  owner: AccessIrDefinition,
  roleName: string,
  targetPermission: string,
): boolean {
  if (RESERVED_ROLE_REF_PROPS.has(targetPermission)) {
    return false;
  }
  const role = owner.roles.find((entry) => entry.name === roleName);
  if (role === undefined || role.subjects.length === 0) {
    return false;
  }
  return role.subjects.every((subject) => {
    if (subject.kind !== "type" || subject.expiration === true) {
      return false;
    }
    if (ctx.symbols.actorWireNames.has(subject.wireName)) {
      return false;
    }
    const targetDef = ctx.symbols.definitionByWireName.get(subject.wireName);
    return (
      targetDef !== undefined &&
      (targetDef.permissions.some((perm) => perm.name === targetPermission) ||
        targetDef.roles.some((targetRole) => targetRole.name === targetPermission))
    );
  });
}

function resolveFallbackTargetWire(owner: AccessIrDefinition, roleName: string): string {
  const role = owner.roles.find((entry) => entry.name === roleName);
  const subjects = role?.subjects ?? [];
  const firstType = subjects.find((subject) => subject.kind === "type");
  return firstType?.wireName ?? subjects[0]?.wireName ?? owner.wireName;
}

function flattenLeftConjunction(term: AccessIrTerm): readonly AccessIrTerm[] {
  if (term.kind === "both") {
    return [...flattenLeftConjunction(term.left), term.right];
  }
  if (term.kind === "gated") {
    return [...flattenLeftConjunction(term.term), term.condition];
  }
  return [term];
}

function emitArrowTerm(
  ctx: ErgonomicTermContext,
  scope: CanScope,
  roleName: string,
  targetPermission: string,
  kind: "through" | "through-all",
): EmittedTerm {
  const roleVar = scope.varByRoleName.get(roleName);
  if (roleVar === undefined) {
    throw new Error(`missing role "${roleName}" on "${scope.owner.wireName}" for arrow "${targetPermission}"`);
  }
  if (supportsDirectArrow(ctx, scope.owner, roleName, targetPermission)) {
    if (kind === "through") {
      return {
        code: formatPropAccess(roleVar, targetPermission),
        isDslTerm: true,
      };
    }
    ctx.valueImports.add("every");
    return {
      code: formatPropAccess(`every(${roleVar})`, targetPermission),
      isDslTerm: true,
    };
  }
  ctx.valueImports.add("permissionToken");
  const targetWire = resolveFallbackTargetWire(scope.owner, roleName);
  return {
    code: `{ kind: ${JSON.stringify(kind)}, role: ${roleVar}.$roleToken, target: permissionToken(${JSON.stringify(targetWire)}, ${JSON.stringify(targetPermission)}) }`,
    isDslTerm: false,
  };
}

function emitExcludingTerm(
  ctx: ErgonomicTermContext,
  scope: CanScope,
  baseTerm: AccessIrTerm,
  bannedTerm: AccessIrTerm,
): EmittedTerm {
  const base = emitErgonomicTerm(ctx, scope, baseTerm);
  const banned = emitErgonomicTerm(ctx, scope, bannedTerm);
  if (base.isDslTerm) {
    return { code: `${base.code}.unless(${banned.code})`, isDslTerm: true };
  }
  ctx.valueImports.add("anyOf");
  return {
    code: `anyOf(${base.code}).unless(${banned.code})`,
    isDslTerm: true,
  };
}

function emitErgonomicTerm(ctx: ErgonomicTermContext, scope: CanScope, term: AccessIrTerm): EmittedTerm {
  if (term.kind === "role" || term.kind === "permission") {
    const roleVar = scope.varByRoleName.get(term.name);
    if (roleVar !== undefined) {
      return { code: roleVar, isDslTerm: true };
    }
    ctx.valueImports.add("permissionToken");
    return {
      code: `permissionToken(${JSON.stringify(scope.owner.wireName)}, ${JSON.stringify(term.name)})`,
      isDslTerm: false,
    };
  }
  if (term.kind === "through" || term.kind === "through-all") {
    return emitArrowTerm(ctx, scope, term.roleName, term.targetPermission, term.kind);
  }
  if (term.kind === "or") {
    ctx.valueImports.add("anyOf");
    const items = term.terms.map((entry) => emitErgonomicTerm(ctx, scope, entry).code);
    return { code: `anyOf(${items.join(", ")})`, isDslTerm: true };
  }
  if (term.kind === "excluding") {
    return emitExcludingTerm(ctx, scope, term.term, term.banned);
  }
  ctx.valueImports.add("allOf");
  const factors = flattenLeftConjunction(term).map((entry) => emitErgonomicTerm(ctx, scope, entry).code);
  return { code: `allOf(${factors.join(", ")})`, isDslTerm: true };
}

function emitPermissionValue(ctx: ErgonomicTermContext, scope: CanScope, permission: AccessIrPermission): string {
  const emitted = permission.terms.map((term) => emitErgonomicTerm(ctx, scope, term).code);
  const [only] = emitted;
  if (emitted.length === 1 && only !== undefined) {
    return only;
  }
  return `[${emitted.join(", ")}]`;
}

function formatDestructuredParams(bindings: readonly RoleBinding[]): string {
  if (bindings.length === 0) {
    return "()";
  }
  const parts = bindings.map((binding) =>
    binding.propName === binding.varName ? binding.varName : `${formatPropKey(binding.propName)}: ${binding.varName}`,
  );
  return `({ ${parts.join(", ")} })`;
}

/**
 * Emit the `can: ({ ... }) => ({ ... }),` block for an ergonomic `resource(...)`.
 */
export function emitErgonomicCanBlock(
  ctx: ErgonomicTermContext,
  definition: AccessIrDefinition,
  permissions: readonly AccessIrPermission[],
): readonly string[] {
  if (permissions.length === 0) {
    return [];
  }
  const bindings = buildRoleBindings(definition, permissions);
  const scope: CanScope = {
    owner: definition,
    varByRoleName: new Map(bindings.map((binding) => [binding.propName, binding.varName])),
  };
  const entries = permissions.map(
    (permission) => `    ${formatPropKey(permission.name)}: ${emitPermissionValue(ctx, scope, permission)},`,
  );
  return [`  can: ${formatDestructuredParams(bindings)} => ({`, ...entries, "  }),"];
}
