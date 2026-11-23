import type { GrantableGroup, GrantableLocalizedText, GrantableScope } from "./grantable.js";
import type { PermissionTerm } from "./refs.js";

export type GrantableCatalogLabel = GrantableLocalizedText;

export type GrantableCatalogPlacement = {
  readonly groupId: string;
  readonly groupLabel: GrantableCatalogLabel;
  readonly groupDescription?: GrantableCatalogLabel;
  readonly groupOrder?: number;
};

export type GrantableCatalogBinding = {
  readonly scope: GrantableScope;
  readonly entityWireName: string;
  readonly roleName: string;
  readonly permission: string;
};

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function childTermsOf(term: PermissionTerm): readonly PermissionTerm[] {
  if (term.kind === "gated") return [term.term, term.condition];
  if (term.kind === "excluding") return [term.term];
  if (term.kind === "both") return [term.left, term.right];
  if (term.kind === "or") return term.terms;
  return [];
}

export function termReferencesRole(term: PermissionTerm, roleName: string): boolean {
  if (term.kind === "role") return term.roleName === roleName;
  if (term.kind === "through" || term.kind === "through-all") return term.role.roleName === roleName;
  return childTermsOf(term).some((child) => termReferencesRole(child, roleName));
}

export function permissionsReferencingRole(
  expressions: Readonly<Record<string, readonly PermissionTerm[]>>,
  roleName: string,
): readonly string[] {
  const matched: string[] = [];
  for (const [permissionName, terms] of Object.entries(expressions)) {
    if (terms.some((term) => termReferencesRole(term, roleName))) {
      matched.push(permissionName);
    }
  }
  return matched.sort(compareStrings);
}

export function requireNonEmptyString(value: string, fieldName: string, context: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid grantable catalog entry (${context}): "${fieldName}" must be a non-empty string.`);
  }
  return trimmed;
}

export function normalizeLocalizedText(
  value: GrantableLocalizedText,
  fieldName: string,
  context: string,
): GrantableCatalogLabel {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(
      `Invalid grantable catalog entry (${context}): "${fieldName}" must include at least one locale entry.`,
    );
  }
  const normalized: Record<string, string> = {};
  const sortedEntries = [...entries].sort(([left], [right]) => compareStrings(left, right));
  for (const [rawLocale, rawText] of sortedEntries) {
    const locale = rawLocale.trim();
    const text = rawText.trim();
    if (locale.length === 0) {
      throw new Error(`Invalid grantable catalog entry (${context}): "${fieldName}" contains an empty locale key.`);
    }
    if (text.length === 0) {
      throw new Error(
        `Invalid grantable catalog entry (${context}): "${fieldName}.${locale}" must be a non-empty string.`,
      );
    }
    normalized[locale] = text;
  }
  return normalized;
}

export function normalizePlacement(group: GrantableGroup, context: string): GrantableCatalogPlacement | null {
  if (group === null) return null;
  const groupId = requireNonEmptyString(group.name, "group.name", context);
  const groupLabel = normalizeLocalizedText(group.label, "group.label", context);
  const groupDescription =
    group.description === undefined
      ? undefined
      : normalizeLocalizedText(group.description, "group.description", context);
  if (group.order !== undefined && (!Number.isFinite(group.order) || typeof group.order !== "number")) {
    throw new Error(`Invalid grantable catalog entry (${context}): "group.order" must be a finite number.`);
  }
  return {
    groupId,
    groupLabel,
    ...(groupDescription === undefined ? {} : { groupDescription }),
    ...(group.order === undefined ? {} : { groupOrder: group.order }),
  };
}

export function normalizeScopes(scopes: readonly GrantableScope[], context: string): readonly GrantableScope[] {
  if (scopes.length === 0) {
    throw new Error(`Invalid grantable catalog entry (${context}): "scopes" must not be empty.`);
  }
  const unique = new Set<GrantableScope>();
  for (const scope of scopes) {
    unique.add(requireNonEmptyString(scope, "scopes", context));
  }
  return [...unique].sort(compareStrings);
}

export function normalizeRequires(requires: readonly string[], context: string): readonly string[] {
  const unique = new Set<string>();
  for (const req of requires) {
    unique.add(requireNonEmptyString(req, "requires", context));
  }
  return [...unique].sort(compareStrings);
}

export function localizedTextEquals(left: GrantableCatalogLabel, right: GrantableCatalogLabel): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function optionalLocalizedTextEquals(
  left: GrantableCatalogLabel | undefined,
  right: GrantableCatalogLabel | undefined,
): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return localizedTextEquals(left, right);
}

export function placementEquals(
  left: GrantableCatalogPlacement | null,
  right: GrantableCatalogPlacement | null,
): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return (
    left.groupId === right.groupId &&
    left.groupOrder === right.groupOrder &&
    localizedTextEquals(left.groupLabel, right.groupLabel) &&
    optionalLocalizedTextEquals(left.groupDescription, right.groupDescription)
  );
}

export function stringArrayEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function bindingKey(binding: GrantableCatalogBinding): string {
  return `${binding.scope}\0${binding.entityWireName}\0${binding.roleName}\0${binding.permission}`;
}

export function compareBindings(left: GrantableCatalogBinding, right: GrantableCatalogBinding): number {
  return (
    compareStrings(left.scope, right.scope) ||
    compareStrings(left.entityWireName, right.entityWireName) ||
    compareStrings(left.roleName, right.roleName) ||
    compareStrings(left.permission, right.permission)
  );
}
