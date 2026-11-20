import type { EntityHandle } from "./entity-handle.js";
import type { AccessDefinition } from "./model.js";

/**
 * What one role on a record is, in the record's own storage. Kind only: the
 * SQL that renders each kind belongs to the list seam, not to this kit.
 *
 * - `scope-column` — one column on the record holds the scope id
 *   (document `owner` → `workspace_id`).
 * - `scope-join` — rows in a child table hold the scope ids
 *   (document `shared_with` → active `document_shares`).
 * - `tag` — a wildcard role written to mark the record itself
 *   (document `published`); it becomes a constant condition.
 * - `derived` — a condition with no column of its own
 *   (document `private_owner` = the owner while no share is active).
 * - `sparse-direct` — a direct per-user grant that is rare per caller (an
 *   assignee); the plan may ask for those record ids directly because the set
 *   is small.
 */
export type RoleBinding =
  | { readonly kind: "scope-column" }
  | { readonly kind: "scope-join" }
  | { readonly kind: "tag" }
  | { readonly kind: "derived" }
  | { readonly kind: "sparse-direct" };

/**
 * One record entity's role bindings. A role left out is unbound; a plan that
 * reaches an unbound role is refused. `Roles` keeps each role's declared kind
 * in the type, so the list seam can require the matching SQL for each role.
 */
export type ScopeBindings<Roles extends ScopeRoleBindings = ScopeRoleBindings> =
  {
    readonly entity: EntityHandle;
    readonly kind: "record";
    readonly roles: Roles;
  };

/** Each bound role of one record, by role name. */
export type ScopeRoleBindings = Readonly<Record<string, RoleBinding>>;

/**
 * Declare how a record's roles are stored, so its lists can be filtered by
 * scope. Role names are checked against the access definition at compile time.
 */
export function scopeBindings<
  RoleTable,
  PermissionTable,
  const Roles extends ScopeRoleBindings,
>(
  definition: AccessDefinition<RoleTable, PermissionTable>,
  roles: Roles & Readonly<Record<Exclude<keyof Roles, keyof RoleTable>, never>>,
): ScopeBindings<Roles> {
  return { entity: definition.entity, kind: "record", roles };
}
