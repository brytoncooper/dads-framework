import {
  allowVisibleOnRecordUntil,
  type VisibleRecordException,
} from "./visible-record-exceptions.js";
import type { CatalogOnlyCapability } from "./catalog-only.js";
import type { EntityHandle } from "./entity-handle.js";
import type { AccessDefinition } from "./model.js";
import type { ScopeBindings } from "./scope-bindings.js";
import type { LifecycleTrigger } from "./lifecycle.js";
import type { PermissionTerm, PermissionToken, RoleToken } from "./refs.js";

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
 * Explicit app composition. Declaration modules contribute definitions and
 * bindings without writing process-wide state.
 */
export type AccessModel = {
  readonly definitions: readonly ResolvedAccessDefinition[];
  readonly bindings: readonly ScopeBindings[];
  readonly visibleRecordExceptions: readonly VisibleRecordException[];
  readonly migrations?: readonly AccessMigrationMeta[];
};

export function accessModel(
  declarations: readonly Pick<
    AccessDefinition<unknown, unknown>,
    "entity" | "resolve"
  >[],
  bindings: readonly ScopeBindings[] = [],
  visibleRecordExceptions: readonly VisibleRecordException[] = [],
): AccessModel {
  const definitions = declarations.map((declaration) => declaration.resolve());
  const wireNames = distinctWireNames(definitions);
  distinctWireNames(bindings);
  for (const binding of bindings) {
    if (!wireNames.has(binding.entity.wireName)) {
      throw new Error(
        `scope bindings name missing access definition ${binding.entity.wireName}`,
      );
    }
  }
  return {
    definitions,
    bindings: [...bindings],
    visibleRecordExceptions: visibleRecordExceptions.map((entry) =>
      allowVisibleOnRecordUntil(entry.until, entry),
    ),
  };
}

function distinctWireNames(
  entries: readonly { readonly entity: EntityHandle }[],
): Set<string> {
  const names = new Set<string>();
  for (const { entity } of entries) {
    if (names.has(entity.wireName)) {
      throw new Error(`duplicate access model entry ${entity.wireName}`);
    }
    names.add(entity.wireName);
  }
  return names;
}
