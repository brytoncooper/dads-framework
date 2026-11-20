import { isGrantableRole } from "./grantable.js";
import type { ResolvedAccessDefinition } from "./access-model.js";

export type ConformanceFailure = {
  readonly fileHint: string;
  readonly role: string;
  readonly message: string;
};

export type MissingGrantingAdvisory = {
  readonly fileHint: string;
  readonly message: string;
};

function accessFileHint(entityWireName: string): string {
  return `${entityWireName}.access.ts`;
}

function isNonemptyCatalogField(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "object") {
    return Object.values(value).some((entry) => isNonemptyCatalogField(entry));
  }
  return true;
}

function definedPermissionNames(
  definition: ResolvedAccessDefinition,
): Set<string> {
  return new Set(Object.keys(definition.expressions));
}

function hasGrantableRole(definition: ResolvedAccessDefinition): boolean {
  return Object.values(definition.roles).some((roleToken) =>
    isGrantableRole(roleToken.holder),
  );
}

/**
 * Validate sealed access definitions against write-law rules: grantable
 * catalog metadata and granting.requires permissions that exist on the entity.
 */
export function checkAccessConformance(
  definitions: readonly ResolvedAccessDefinition[],
): readonly ConformanceFailure[] {
  return definitions.flatMap((definition) => [
    ...catalogFailures(definition),
    ...grantingFailures(definition),
  ]);
}

function catalogFailures(
  definition: ResolvedAccessDefinition,
): readonly ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  for (const [role, token] of Object.entries(definition.roles)) {
    if (!isGrantableRole(token.holder)) continue;
    const { label, group, id, permission, scopes } = token.holder;
    const fields: readonly (readonly [boolean, string])[] = [
      [isNonemptyCatalogField(label), "is missing a label"],
      [group === null || isNonemptyCatalogField(group), "is missing a group"],
      [isNonemptyCatalogField(id), "is missing a catalog id"],
      [isNonemptyCatalogField(permission), "is missing a permission verb"],
      [scopes.length > 0, "has empty scopes"],
    ];
    for (const [present, detail] of fields) {
      if (present) continue;
      failures.push({
        fileHint: accessFileHint(definition.entity.wireName),
        role,
        message: `Grantable role "${role}" on entity "${definition.entity.wireName}" ${detail}.`,
      });
    }
  }
  return failures;
}

function grantingFailures(
  definition: ResolvedAccessDefinition,
): readonly ConformanceFailure[] {
  const permissionNames = definedPermissionNames(definition);
  const required = definition.granting?.requires ?? [];
  const wireName = definition.entity.wireName;
  return required
    .filter(({ permissionName }) => !permissionNames.has(permissionName))
    .map(({ permissionName }) => ({
      fileHint: accessFileHint(wireName),
      role: "",
      message: `Granting law on entity "${wireName}" requires permission "${permissionName}", which is not declared in permissions().`,
    }));
}

/**
 * Grantable roles without a `granting` block are advisory only until every
 * access leaf declares write law.
 */
export function missingGrantingAdvisories(
  definitions: readonly ResolvedAccessDefinition[],
): readonly MissingGrantingAdvisory[] {
  const advisories: MissingGrantingAdvisory[] = [];

  for (const definition of definitions) {
    if (definition.granting !== undefined || !hasGrantableRole(definition)) {
      continue;
    }

    advisories.push({
      fileHint: accessFileHint(definition.entity.wireName),
      message: `Entity "${definition.entity.wireName}" has grantable roles but no granting block.`,
    });
  }

  return advisories;
}
