import type { AccessModel, ResolvedAccessDefinition } from "./access-model.js";
import {
  bindingKey,
  compareBindings,
  compareStrings,
  localizedTextEquals,
  normalizeLocalizedText,
  normalizePlacement,
  normalizeRequires,
  normalizeScopes,
  permissionsReferencingRole,
  placementEquals,
  requireNonEmptyString,
  stringArrayEquals,
  type GrantableCatalogBinding,
  type GrantableCatalogLabel,
  type GrantableCatalogPlacement,
} from "./build-grantable-catalog-normalize.js";
import type { CatalogOnlyCapability } from "./catalog-only.js";
import {
  isGrantableRole,
  type GrantableRisk,
  type GrantableRole,
  type GrantableScope,
  type GrantableTargetKind,
} from "./grantable.js";
import { isExpirableHolder, type SingleRoleValue } from "./holders.js";
import type { RoleHolder } from "./refs.js";

export type { GrantableCatalogBinding, GrantableCatalogLabel, GrantableCatalogPlacement };

export type GrantableCatalogEntry = {
  readonly id: string;
  readonly domainId: string;
  readonly domainLabel: GrantableCatalogLabel;
  readonly label: GrantableCatalogLabel;
  readonly description: GrantableCatalogLabel;
  readonly placement: GrantableCatalogPlacement | null;
  readonly requires: readonly string[];
  readonly allowedScopes: readonly GrantableScope[];
  readonly targetKind: GrantableTargetKind;
  readonly risk: GrantableRisk;
  readonly customerAssignable: boolean;
  readonly bindings: readonly GrantableCatalogBinding[];
};

type AccumulatedEntry = {
  readonly id: string;
  readonly domainId: string;
  readonly domainLabel: GrantableCatalogLabel;
  readonly label: GrantableCatalogLabel;
  readonly description: GrantableCatalogLabel;
  readonly placement: GrantableCatalogPlacement | null;
  readonly requires: readonly string[];
  readonly targetKind: GrantableTargetKind;
  readonly risk: GrantableRisk;
  readonly customerAssignable: boolean;
  readonly allowedScopes: Set<GrantableScope>;
  readonly bindings: Map<string, GrantableCatalogBinding>;
};

function isDefinitionList(
  input: AccessModel | readonly ResolvedAccessDefinition[],
): input is readonly ResolvedAccessDefinition[] {
  return Array.isArray(input);
}

function isRoleHolderArray(holder: RoleHolder): holder is readonly SingleRoleValue[] {
  return Array.isArray(holder);
}

function extractGrantableFromSingle(entry: SingleRoleValue): readonly GrantableRole[] {
  if (isGrantableRole(entry)) return [entry];
  if (isExpirableHolder(entry)) return extractGrantableFromSingle(entry.holder);
  return [];
}

function extractGrantableRoles(holder: RoleHolder): readonly GrantableRole[] {
  if (isRoleHolderArray(holder)) {
    return holder.flatMap(extractGrantableFromSingle);
  }
  return extractGrantableFromSingle(holder);
}

function resolveGrantablePermissions(
  definition: ResolvedAccessDefinition,
  roleName: string,
  role: GrantableRole,
  context: string,
): readonly string[] {
  const declared = role.permission.trim();
  if (declared.length > 0) {
    return [declared];
  }
  const referenced = permissionsReferencingRole(definition.expressions, roleName);
  if (referenced.length === 0) {
    throw new Error(`Invalid grantable catalog entry (${context}): "permission" must be a non-empty string.`);
  }
  return referenced;
}

function entryFromGrantableRole(
  definition: ResolvedAccessDefinition,
  roleName: string,
  role: GrantableRole,
): GrantableCatalogEntry {
  const wireName = definition.entity.wireName;
  const context = `entity "${wireName}", role "${roleName}"`;
  const allowedScopes = normalizeScopes(role.scopes, context);
  const permissions = resolveGrantablePermissions(definition, roleName, role, context);
  const bindings: GrantableCatalogBinding[] = [];
  for (const scope of allowedScopes) {
    for (const permission of permissions) {
      bindings.push({ scope, entityWireName: wireName, roleName, permission });
    }
  }
  return {
    id: requireNonEmptyString(role.id, "id", context),
    domainId: requireNonEmptyString(role.domainId, "domainId", context),
    domainLabel: normalizeLocalizedText(role.domainLabel, "domainLabel", context),
    label: normalizeLocalizedText(role.label, "label", context),
    description: normalizeLocalizedText(role.description, "description", context),
    placement: normalizePlacement(role.group, context),
    requires: normalizeRequires(role.requires, context),
    allowedScopes,
    targetKind: role.targetKind,
    risk: role.risk,
    customerAssignable: role.customerAssignable,
    bindings,
  };
}

function entryFromCatalogOnly(
  definition: ResolvedAccessDefinition,
  capability: CatalogOnlyCapability,
): GrantableCatalogEntry {
  const context = `entity "${definition.entity.wireName}", catalogOnly "${capability.id}"`;
  const allowedScopes = normalizeScopes(capability.scopes, context);
  const entityWireName = requireNonEmptyString(capability.entityWireName, "entityWireName", context);
  const roleName = requireNonEmptyString(capability.roleName, "roleName", context);
  const permission = requireNonEmptyString(capability.permission, "permission", context);
  return {
    id: requireNonEmptyString(capability.id, "id", context),
    domainId: requireNonEmptyString(capability.domainId, "domainId", context),
    domainLabel: normalizeLocalizedText(capability.domainLabel, "domainLabel", context),
    label: normalizeLocalizedText(capability.label, "label", context),
    description: normalizeLocalizedText(capability.description, "description", context),
    placement: normalizePlacement(capability.group, context),
    requires: normalizeRequires(capability.requires, context),
    allowedScopes,
    targetKind: capability.targetKind,
    risk: capability.risk,
    customerAssignable: capability.customerAssignable,
    bindings: allowedScopes.map((scope) => ({ scope, entityWireName, roleName, permission })),
  };
}

function assertCompatibleMetadata(existing: AccumulatedEntry, incoming: GrantableCatalogEntry): void {
  const checks: readonly (readonly [string, boolean])[] = [
    ["domainId", existing.domainId === incoming.domainId],
    ["domainLabel", localizedTextEquals(existing.domainLabel, incoming.domainLabel)],
    ["label", localizedTextEquals(existing.label, incoming.label)],
    ["description", localizedTextEquals(existing.description, incoming.description)],
    ["placement", placementEquals(existing.placement, incoming.placement)],
    ["requires", stringArrayEquals(existing.requires, incoming.requires)],
    ["targetKind", existing.targetKind === incoming.targetKind],
    ["risk", existing.risk === incoming.risk],
    ["customerAssignable", existing.customerAssignable === incoming.customerAssignable],
  ];
  const mismatches = checks.filter(([, same]) => !same).map(([field]) => field);

  if (mismatches.length > 0) {
    throw new Error(`Conflicting catalog metadata for "${existing.id}": mismatched ${mismatches.join(", ")}.`);
  }
}

function mergeEntry(entriesById: Map<string, AccumulatedEntry>, incoming: GrantableCatalogEntry): void {
  const existing = entriesById.get(incoming.id);
  if (existing === undefined) {
    const bindings = new Map<string, GrantableCatalogBinding>();
    for (const binding of incoming.bindings) {
      bindings.set(bindingKey(binding), binding);
    }
    entriesById.set(incoming.id, {
      id: incoming.id,
      domainId: incoming.domainId,
      domainLabel: incoming.domainLabel,
      label: incoming.label,
      description: incoming.description,
      placement: incoming.placement,
      requires: incoming.requires,
      targetKind: incoming.targetKind,
      risk: incoming.risk,
      customerAssignable: incoming.customerAssignable,
      allowedScopes: new Set(incoming.allowedScopes),
      bindings,
    });
    return;
  }

  assertCompatibleMetadata(existing, incoming);
  for (const scope of incoming.allowedScopes) {
    existing.allowedScopes.add(scope);
  }
  for (const binding of incoming.bindings) {
    existing.bindings.set(bindingKey(binding), binding);
  }
}

function assertDomainAndGroupConsistency(entries: readonly GrantableCatalogEntry[]): void {
  const domainLabels = new Map<string, GrantableCatalogLabel>();
  const groupPlacements = new Map<string, GrantableCatalogPlacement>();

  for (const entry of entries) {
    const existingDomainLabel = domainLabels.get(entry.domainId);
    if (existingDomainLabel === undefined) {
      domainLabels.set(entry.domainId, entry.domainLabel);
    } else if (!localizedTextEquals(existingDomainLabel, entry.domainLabel)) {
      throw new Error(`Conflicting domainLabel for domain "${entry.domainId}" on catalog entry "${entry.id}".`);
    }

    if (entry.placement !== null) {
      const groupKey = `${entry.domainId}\0${entry.placement.groupId}`;
      const existingPlacement = groupPlacements.get(groupKey);
      if (existingPlacement === undefined) {
        groupPlacements.set(groupKey, entry.placement);
      } else if (!placementEquals(existingPlacement, entry.placement)) {
        throw new Error(
          `Conflicting group placement for group "${entry.placement.groupId}" in domain "${entry.domainId}" on catalog entry "${entry.id}".`,
        );
      }
    }
  }
}

function comparePlacements(left: GrantableCatalogPlacement | null, right: GrantableCatalogPlacement | null): number {
  const leftOrder = left?.groupOrder ?? Number.POSITIVE_INFINITY;
  const rightOrder = right?.groupOrder ?? Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  return compareStrings(left.groupId, right.groupId);
}

function compareEntries(left: GrantableCatalogEntry, right: GrantableCatalogEntry): number {
  const domainCmp = compareStrings(left.domainId, right.domainId);
  if (domainCmp !== 0) return domainCmp;
  const placementCmp = comparePlacements(left.placement, right.placement);
  if (placementCmp !== 0) return placementCmp;
  return compareStrings(left.id, right.id);
}

/**
 * Build a deterministic, validated capability catalog from a compiled
 * `AccessModel` or list of `ResolvedAccessDefinition`s.
 */
export function buildGrantableCatalog(
  input: AccessModel | readonly ResolvedAccessDefinition[],
): readonly GrantableCatalogEntry[] {
  const definitions = isDefinitionList(input) ? input : input.definitions;
  const entriesById = new Map<string, AccumulatedEntry>();

  for (const definition of definitions) {
    for (const [roleName, roleToken] of Object.entries(definition.roles)) {
      for (const grantableRole of extractGrantableRoles(roleToken.holder)) {
        mergeEntry(entriesById, entryFromGrantableRole(definition, roleName, grantableRole));
      }
    }
    for (const capability of definition.catalogOnly) {
      mergeEntry(entriesById, entryFromCatalogOnly(definition, capability));
    }
  }

  const entries: GrantableCatalogEntry[] = [...entriesById.values()].map((entry) => ({
    id: entry.id,
    domainId: entry.domainId,
    domainLabel: entry.domainLabel,
    label: entry.label,
    description: entry.description,
    placement: entry.placement,
    requires: entry.requires,
    allowedScopes: [...entry.allowedScopes].sort(compareStrings),
    targetKind: entry.targetKind,
    risk: entry.risk,
    customerAssignable: entry.customerAssignable,
    bindings: [...entry.bindings.values()].sort(compareBindings),
  }));

  entries.sort(compareEntries);
  assertDomainAndGroupConsistency(entries);
  return entries;
}
