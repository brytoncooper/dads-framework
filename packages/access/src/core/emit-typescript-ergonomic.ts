import type { AccessIrDefinition, AccessIrRole, AccessIrSubject } from "./ir.js";
import { planResourcesAndLazyTargets, type ResourcePlan } from "./emit-typescript-ergonomic-plan.js";
import { emitErgonomicCanBlock } from "./emit-typescript-ergonomic-terms.js";
import {
  allocateErgonomicSymbols,
  formatPropAccess,
  formatPropKey,
  orderErgonomicResources,
  type ErgonomicSymbols,
} from "./emit-typescript-symbols.js";

type ErgonomicEmitContext = {
  readonly symbols: ErgonomicSymbols;
  readonly valueImports: Set<string>;
  readonly typeImports: Set<string>;
  readonly declared: Set<string>;
};

function varOf(ctx: ErgonomicEmitContext, wireName: string): string {
  const variable = ctx.symbols.varByWireName.get(wireName);
  if (variable === undefined) {
    throw new Error(`missing ergonomic variable for ${wireName}`);
  }
  return variable;
}

function emitTypeSubject(
  ctx: ErgonomicEmitContext,
  subject: Extract<AccessIrSubject, { readonly kind: "type" }>,
): string {
  const targetVar = varOf(ctx, subject.wireName);
  const isActor = ctx.symbols.actorWireNames.has(subject.wireName);
  const isDeclared = ctx.declared.has(subject.wireName);

  if (subject.expiration === true) {
    if (isActor) return `${targetVar}.expiring`;
    if (isDeclared) {
      return `{ kind: "expirable", holder: ${targetVar}.handle }`;
    }
    ctx.valueImports.add("actor");
    return `actor(${JSON.stringify(subject.wireName)}).expiring`;
  }
  if (isActor || isDeclared) {
    return targetVar;
  }
  return `() => ${targetVar}`;
}

function emitWildcardSubject(
  ctx: ErgonomicEmitContext,
  subject: Extract<AccessIrSubject, { readonly kind: "wildcard" }>,
): string {
  const targetVar = varOf(ctx, subject.wireName);
  const isActor = ctx.symbols.actorWireNames.has(subject.wireName);
  const isDeclared = ctx.declared.has(subject.wireName);

  if (isActor) {
    return subject.expiration === true ? `${targetVar}.anyone.expiring` : `${targetVar}.anyone`;
  }
  if (isDeclared) {
    const base = `{ kind: "wildcard", entity: ${targetVar}.handle }`;
    return subject.expiration === true ? `{ kind: "expirable", holder: ${base} }` : base;
  }
  ctx.valueImports.add("actor");
  const base = `actor(${JSON.stringify(subject.wireName)}).anyone`;
  return subject.expiration === true ? `${base}.expiring` : base;
}

function emitUsersetSubject(
  ctx: ErgonomicEmitContext,
  subject: Extract<AccessIrSubject, { readonly kind: "userset" }>,
): string {
  const targetVar = varOf(ctx, subject.wireName);
  const isActor = ctx.symbols.actorWireNames.has(subject.wireName);
  const isDeclared = ctx.declared.has(subject.wireName);
  const targetDef = ctx.symbols.definitionByWireName.get(subject.wireName);
  const canRefDeclaredRole =
    targetDef !== undefined && isDeclared && !isActor && targetDef.roles.some((role) => role.name === subject.relation);

  if (canRefDeclaredRole) {
    const roleExpr = formatPropAccess(`${targetVar}.roles`, subject.relation);
    return subject.expiration === true ? `${roleExpr}.expiring` : roleExpr;
  }

  const literal = `{ kind: "userset", entityWireName: ${JSON.stringify(subject.wireName)}, roleName: ${JSON.stringify(subject.relation)} }`;
  return subject.expiration === true ? `{ kind: "expirable", holder: ${literal} }` : literal;
}

function emitSubject(ctx: ErgonomicEmitContext, subject: AccessIrSubject): string {
  if (subject.kind === "type") return emitTypeSubject(ctx, subject);
  if (subject.kind === "wildcard") return emitWildcardSubject(ctx, subject);
  return emitUsersetSubject(ctx, subject);
}

function emitRoleHolder(ctx: ErgonomicEmitContext, role: AccessIrRole): string {
  const emitted = role.subjects.map((subject) => emitSubject(ctx, subject));
  const [only] = emitted;
  if (emitted.length === 1 && only !== undefined) {
    return only;
  }
  return `[${emitted.join(", ")}]`;
}

function emitResourceTypeAnnotation(ctx: ErgonomicEmitContext, definition: AccessIrDefinition): string {
  ctx.typeImports.add("DslResource");
  let rolesType = "Record<never, never>";
  if (definition.roles.length > 0) {
    ctx.typeImports.add("DslSubjectInput");
    const fields = definition.roles.map((role) => `readonly ${formatPropKey(role.name)}: DslSubjectInput`).join("; ");
    rolesType = `{ ${fields} }`;
  }
  const permsType =
    definition.permissions.length === 0
      ? "never"
      : definition.permissions.map((permission) => JSON.stringify(permission.name)).join(" | ");
  return `: DslResource<${JSON.stringify(definition.wireName)}, ${rolesType}, ${permsType}>`;
}

function emitResourceBlock(ctx: ErgonomicEmitContext, plan: ResourcePlan, needsTypeAnnotation: boolean): string {
  ctx.valueImports.add("resource");
  const { definition } = plan;
  const varName = varOf(ctx, definition.wireName);
  const typeAnnotation = needsTypeAnnotation ? emitResourceTypeAnnotation(ctx, definition) : "";

  const bodyLines: string[] = [];
  if (plan.parentWireNames.length > 0) {
    const parentVars = plan.parentWireNames.map((wire) => varOf(ctx, wire));
    bodyLines.push(`  parents: [${parentVars.join(", ")}],`);
  }
  if (plan.recursive) {
    bodyLines.push("  recursive: true,");
  }
  if (plan.explicitRoles.length > 0) {
    bodyLines.push("  roles: {");
    for (const role of plan.explicitRoles) {
      bodyLines.push(`    ${formatPropKey(role.name)}: ${emitRoleHolder(ctx, role)},`);
    }
    bodyLines.push("  },");
  }
  bodyLines.push(...emitErgonomicCanBlock(ctx, definition, plan.emittedPermissions));

  ctx.declared.add(definition.wireName);
  return [
    `export const ${varName}${typeAnnotation} = resource(${JSON.stringify(definition.wireName)}, {`,
    ...bodyLines,
    "});",
  ].join("\n");
}

function emitImports(ctx: ErgonomicEmitContext): readonly string[] {
  const imports: string[] = [];
  const valueNames = [...ctx.valueImports].sort();
  if (valueNames.length > 0) {
    imports.push(`import { ${valueNames.join(", ")} } from "@dads-framework/access";`);
  }
  const typeNames = [...ctx.typeImports].sort();
  if (typeNames.length > 0) {
    imports.push(`import type { ${typeNames.join(", ")} } from "@dads-framework/access";`);
  }
  return imports;
}

/**
 * Compile access IR definitions into strict, zero-`any` ergonomic Dads DSL
 * TypeScript using `actor`, `resource`, and `compileAccess`.
 */
export function emitErgonomicTypeScript(definitions: readonly AccessIrDefinition[]): string {
  const symbols = allocateErgonomicSymbols(definitions);
  const ctx: ErgonomicEmitContext = {
    symbols,
    valueImports: new Set<string>(["compileAccess"]),
    typeImports: new Set<string>(),
    declared: new Set<string>(),
  };

  const actorLines: string[] = [];
  for (const wireName of symbols.allWireNames) {
    if (!symbols.actorWireNames.has(wireName)) continue;
    ctx.valueImports.add("actor");
    const varName = varOf(ctx, wireName);
    actorLines.push(`export const ${varName} = actor(${JSON.stringify(wireName)});`);
    ctx.declared.add(wireName);
  }

  const orderedResources = orderErgonomicResources(definitions, symbols.actorWireNames);
  const { plans, lazyTargets } = planResourcesAndLazyTargets(orderedResources, symbols);
  const resourceBlocks = plans.map((plan) => emitResourceBlock(ctx, plan, lazyTargets.has(plan.definition.wireName)));

  const modelEntries = definitions.map((definition) => varOf(ctx, definition.wireName));

  const sections: string[] = [emitImports(ctx).join("\n")];
  if (actorLines.length > 0) {
    sections.push(actorLines.join("\n"));
  }
  if (resourceBlocks.length > 0) {
    sections.push(resourceBlocks.join("\n\n"));
  }
  sections.push(`export const access = compileAccess([${modelEntries.join(", ")}]);`);
  return `${sections.join("\n\n")}\n`;
}
