import type { CatalogOnlyCapability } from "./catalog-only.js";
import type { EntityHandle } from "./entity-handle.js";
import type { LifecycleTrigger } from "./lifecycle.js";
import type { PermissionTerm, PermissionToken, RoleToken } from "./refs.js";
import type { ScopeBindings } from "./scope-bindings.js";

export type ResolvedGranting = {
  readonly requires: readonly PermissionToken[];
  readonly removedWhen: readonly LifecycleTrigger[];
};

export type ResolvedAccessDefinition = {
  readonly entity: EntityHandle;
  readonly roles: Record<string, RoleToken>;
  readonly permissions: Record<string, PermissionToken>;
  readonly expressions: Record<string, readonly PermissionTerm[]>;
  readonly granting: ResolvedGranting | undefined;
  readonly catalogOnly: readonly CatalogOnlyCapability[];
};

export type AccessMigrationKind =
  | "rename-relation"
  | "rename-permission"
  | "rename-type"
  | "backfill"
  | "drop-relation"
  | "custom";

export type AccessMigrationMeta = {
  readonly id: string;
  readonly description?: string;
  readonly kind?: AccessMigrationKind;
  readonly from?: string;
  readonly to?: string;
};

/**
 * Explicit compiled authorization model. Declaration modules contribute
 * definitions, scope bindings, and lookup allowlists without global state.
 */
export type AccessModel = {
  readonly definitions: readonly ResolvedAccessDefinition[];
  readonly bindings: readonly ScopeBindings[];
  readonly lookupResourceAllowlist?: readonly string[];
  readonly migrations?: readonly AccessMigrationMeta[];
};

export type FinalizeAccessModelOptions = {
  readonly bindings?: readonly ScopeBindings[];
  readonly allowLookupResourcesOn?: readonly (
    { readonly wireName: string } | string
  )[];
  readonly migrations?: readonly AccessMigrationMeta[];
};

function validateBindings(
  bindings: readonly ScopeBindings[],
  wireNames: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const name = binding.entity.wireName;
    if (seen.has(name)) {
      throw new Error(`duplicate access model entry ${name}`);
    }
    seen.add(name);
    if (!wireNames.has(name)) {
      throw new Error(`scope bindings name missing access definition ${name}`);
    }
  }
}

function normalizeLookupAllowlist(
  entries: readonly ({ readonly wireName: string } | string)[],
  wireNames: ReadonlySet<string>,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.wireName;
    if (!wireNames.has(name)) {
      throw new Error(
        `allowLookupResourcesOn names missing access definition ${name}`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/**
 * Shared finalizer used by `compileAccess` and `compileAccessFromIr` to
 * validate bindings, normalize `allowLookupResourcesOn`, and attach migrations.
 */
export function finalizeAccessModel(
  definitions: readonly ResolvedAccessDefinition[],
  options?: FinalizeAccessModelOptions,
): AccessModel {
  const wireNames = new Set(definitions.map((entry) => entry.entity.wireName));
  const bindings = options?.bindings ?? [];
  validateBindings(bindings, wireNames);

  const allowlist =
    options?.allowLookupResourcesOn === undefined
      ? undefined
      : normalizeLookupAllowlist(options.allowLookupResourcesOn, wireNames);

  return {
    definitions,
    bindings: [...bindings],
    ...(allowlist === undefined ? {} : { lookupResourceAllowlist: allowlist }),
    ...(options?.migrations === undefined
      ? {}
      : { migrations: [...options.migrations] }),
  };
}
