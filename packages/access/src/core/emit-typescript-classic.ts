import type {
  AccessIrDefinition,
  AccessIrPermission,
  AccessIrRole,
  AccessIrSubject,
  AccessIrTerm,
} from "./ir.js";
import {
  allocateSymbols,
  formatPropAccess,
  formatPropKey,
  orderDefinitionsForEmission,
  type EmittedSymbols,
} from "./emit-typescript-symbols.js";

type ClassicEmitContext = {
  readonly symbols: EmittedSymbols;
  readonly valueImports: Set<string>;
  readonly declaredAccess: Set<string>;
  usesPermissionTermType: boolean;
};

function entityVarOf(ctx: ClassicEmitContext, wireName: string): string {
  const variable = ctx.symbols.entityVarByWireName.get(wireName);
  if (variable === undefined) {
    throw new Error(`missing entity variable for ${wireName}`);
  }
  return variable;
}

function accessVarOf(ctx: ClassicEmitContext, wireName: string): string {
  const variable = ctx.symbols.accessVarByWireName.get(wireName);
  if (variable === undefined) {
    throw new Error(`missing access variable for ${wireName}`);
  }
  return variable;
}

function emitBaseSubject(
  ctx: ClassicEmitContext,
  subject: AccessIrSubject,
): string {
  const entityVar = entityVarOf(ctx, subject.wireName);
  if (subject.kind === "type") {
    return entityVar;
  }
  if (subject.kind === "wildcard") {
    ctx.valueImports.add("wildcard");
    return `wildcard(${entityVar})`;
  }
  ctx.valueImports.add("membersOf");
  const targetDef = ctx.symbols.definitionByWireName.get(subject.wireName);
  const canRefDeclared =
    targetDef !== undefined &&
    ctx.declaredAccess.has(subject.wireName) &&
    targetDef.roles.some((role) => role.name === subject.relation);
  if (canRefDeclared) {
    const accessVar = accessVarOf(ctx, subject.wireName);
    return `membersOf(${formatPropAccess(`${accessVar}.roles`, subject.relation)})`;
  }
  ctx.valueImports.add("roleToken");
  return `membersOf(roleToken(${entityVar}.wireName, ${JSON.stringify(subject.relation)}, ${entityVar}))`;
}

function emitSubject(
  ctx: ClassicEmitContext,
  subject: AccessIrSubject,
): string {
  const base = emitBaseSubject(ctx, subject);
  if (subject.expiration === true) {
    ctx.valueImports.add("withExpiration");
    return `withExpiration(${base})`;
  }
  return base;
}

function emitRoleHolder(ctx: ClassicEmitContext, role: AccessIrRole): string {
  const emitted = role.subjects.map((subject) => emitSubject(ctx, subject));
  const [only] = emitted;
  if (emitted.length === 1 && only !== undefined) {
    return only;
  }
  return `[${emitted.join(", ")}]`;
}

function findTargetTokenInDefinitions(
  ctx: ClassicEmitContext,
  candidates: readonly string[],
  targetPermission: string,
): string | undefined {
  for (const wireName of candidates) {
    const targetDef = ctx.symbols.definitionByWireName.get(wireName);
    if (targetDef?.permissions.some((p) => p.name === targetPermission)) {
      const accessVar = accessVarOf(ctx, wireName);
      return formatPropAccess(`${accessVar}.permissions`, targetPermission);
    }
  }
  for (const wireName of candidates) {
    const targetDef = ctx.symbols.definitionByWireName.get(wireName);
    if (targetDef?.roles.some((r) => r.name === targetPermission)) {
      const accessVar = accessVarOf(ctx, wireName);
      return formatPropAccess(`${accessVar}.roles`, targetPermission);
    }
  }
  return undefined;
}

function resolveArrowTarget(
  ctx: ClassicEmitContext,
  owner: AccessIrDefinition,
  roleName: string,
  targetPermission: string,
): string {
  const role = owner.roles.find((entry) => entry.name === roleName);
  const subjects = role?.subjects ?? [];
  const typeTargets = subjects
    .filter((subject) => subject.kind === "type")
    .map((subject) => subject.wireName);
  const candidates =
    typeTargets.length > 0
      ? typeTargets
      : subjects.map((subject) => subject.wireName);

  const resolved = findTargetTokenInDefinitions(
    ctx,
    candidates,
    targetPermission,
  );
  if (resolved !== undefined) {
    return resolved;
  }
  ctx.valueImports.add("permissionToken");
  const fallbackWireName = candidates[0] ?? owner.wireName;
  const fallbackEntityVar = entityVarOf(ctx, fallbackWireName);
  return `permissionToken(${fallbackEntityVar}.wireName, ${JSON.stringify(targetPermission)})`;
}

type PermissionScope = {
  readonly owner: AccessIrDefinition;
  usesRolesParam: boolean;
};

function emitNamedTerm(
  ctx: ClassicEmitContext,
  scope: PermissionScope,
  name: string,
): string {
  if (scope.owner.roles.some((role) => role.name === name)) {
    scope.usesRolesParam = true;
    return formatPropAccess("roles", name);
  }
  if (scope.owner.permissions.some((perm) => perm.name === name)) {
    const accessVar = accessVarOf(ctx, scope.owner.wireName);
    return formatPropAccess(`${accessVar}.permissions`, name);
  }
  ctx.valueImports.add("permissionToken");
  const entityVar = entityVarOf(ctx, scope.owner.wireName);
  return `permissionToken(${entityVar}.wireName, ${JSON.stringify(name)})`;
}

function emitTerm(
  ctx: ClassicEmitContext,
  scope: PermissionScope,
  term: AccessIrTerm,
): string {
  if (term.kind === "role" || term.kind === "permission") {
    return emitNamedTerm(ctx, scope, term.name);
  }
  if (term.kind === "through" || term.kind === "through-all") {
    const helper = term.kind === "through" ? "through" : "throughAll";
    ctx.valueImports.add(helper);
    scope.usesRolesParam = true;
    const roleExpr = formatPropAccess("roles", term.roleName);
    const targetExpr = resolveArrowTarget(
      ctx,
      scope.owner,
      term.roleName,
      term.targetPermission,
    );
    return `${helper}(${roleExpr}, ${targetExpr})`;
  }
  if (term.kind === "or") {
    ctx.valueImports.add("asPermissionTerm");
    const items = term.terms.map((entry) => emitTerm(ctx, scope, entry));
    return `asPermissionTerm([${items.join(", ")}])`;
  }
  if (term.kind === "excluding") {
    ctx.valueImports.add("excluding");
    return `excluding(${emitTerm(ctx, scope, term.term)}, ${emitTerm(ctx, scope, term.banned)})`;
  }
  ctx.valueImports.add("both");
  const left = term.kind === "gated" ? term.term : term.left;
  const right = term.kind === "gated" ? term.condition : term.right;
  return `both(${emitTerm(ctx, scope, left)}, ${emitTerm(ctx, scope, right)})`;
}

function emitPermissionsBlock(
  ctx: ClassicEmitContext,
  definition: AccessIrDefinition,
): readonly string[] {
  if (definition.permissions.length === 0) {
    return ["  permissions: () => ({}),"];
  }
  ctx.usesPermissionTermType = true;
  const scope: PermissionScope = { owner: definition, usesRolesParam: false };
  const entries = definition.permissions.map((permission) =>
    emitPermissionEntry(ctx, scope, permission),
  );
  const keyUnion = definition.permissions
    .map((permission) => JSON.stringify(permission.name))
    .join(" | ");
  const params = scope.usesRolesParam ? "(roles)" : "()";
  return [
    `  permissions: ${params}: Record<${keyUnion}, readonly PermissionTerm[]> => ({`,
    ...entries,
    "  }),",
  ];
}

function emitPermissionEntry(
  ctx: ClassicEmitContext,
  scope: PermissionScope,
  permission: AccessIrPermission,
): string {
  const terms = permission.terms.map((term) => emitTerm(ctx, scope, term));
  return `    ${formatPropKey(permission.name)}: [${terms.join(", ")}],`;
}

function emitRolesBlock(
  ctx: ClassicEmitContext,
  definition: AccessIrDefinition,
): readonly string[] {
  if (definition.roles.length === 0) {
    return ["  roles: {},"];
  }
  return [
    "  roles: {",
    ...definition.roles.map(
      (role) =>
        `    ${formatPropKey(role.name)}: ${emitRoleHolder(ctx, role)},`,
    ),
    "  },",
  ];
}

function emitDefinitionBlock(
  ctx: ClassicEmitContext,
  definition: AccessIrDefinition,
): string {
  ctx.valueImports.add("access");
  const entityVar = entityVarOf(ctx, definition.wireName);
  const accessVar = accessVarOf(ctx, definition.wireName);
  const lines = [
    `export const ${accessVar} = access(${entityVar}, {`,
    ...emitRolesBlock(ctx, definition),
    ...emitPermissionsBlock(ctx, definition),
    "});",
  ];
  ctx.declaredAccess.add(definition.wireName);
  return lines.join("\n");
}

function emitImports(ctx: ClassicEmitContext): readonly string[] {
  const imports: string[] = [];
  const valueNames = [...ctx.valueImports].sort();
  if (valueNames.length > 0) {
    imports.push(
      `import { ${valueNames.join(", ")} } from "@dads-framework/access";`,
    );
  }
  if (ctx.usesPermissionTermType) {
    imports.push(
      `import type { PermissionTerm } from "@dads-framework/access";`,
    );
  }
  if (ctx.symbols.allWireNames.length > 0) {
    imports.push(`import { z } from "zod";`);
  }
  return imports;
}

/**
 * Compile access IR definitions into strict, zero-`any` classic Dads TypeScript
 * using `entityHandle`, `access`, and `accessModel`.
 */
export function emitClassicTypeScript(
  definitions: readonly AccessIrDefinition[],
): string {
  const symbols = allocateSymbols(definitions);
  const ctx: ClassicEmitContext = {
    symbols,
    valueImports: new Set<string>(["accessModel"]),
    declaredAccess: new Set<string>(),
    usesPermissionTermType: false,
  };

  const entityLines = symbols.allWireNames.map((wireName) => {
    ctx.valueImports.add("entityHandle");
    const entityVar = entityVarOf(ctx, wireName);
    return `export const ${entityVar} = entityHandle({ wireName: ${JSON.stringify(wireName)}, idSchema: z.string().min(1) });`;
  });

  const ordered = orderDefinitionsForEmission(definitions);
  const accessBlocks = ordered.map((definition) =>
    emitDefinitionBlock(ctx, definition),
  );
  const modelEntries = definitions.map((definition) =>
    accessVarOf(ctx, definition.wireName),
  );

  const sections: string[] = [emitImports(ctx).join("\n")];
  if (entityLines.length > 0) {
    sections.push(entityLines.join("\n"));
  }
  if (accessBlocks.length > 0) {
    sections.push(accessBlocks.join("\n\n"));
  }
  sections.push(
    `export const model = accessModel([${modelEntries.join(", ")}]);`,
  );
  return `${sections.join("\n\n")}\n`;
}
