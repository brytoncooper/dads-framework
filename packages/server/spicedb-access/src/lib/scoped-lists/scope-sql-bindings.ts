/**
 * The SQL side of a record's scope bindings. The access kit declares each
 * role's kind (`scopeBindings`); the owning domain hands the matching SQL
 * here, once per record, beside its tables. A role's SQL must match its
 * declared kind: TypeScript refuses a mismatch when the declaration's type is
 * in view, and registration refuses it at boot otherwise.
 */
import type { AnyColumn, SQL, Table } from "drizzle-orm";

import type { RoleBinding, ScopeBindings, ScopeRoleBindings } from "@dads-framework/access/scopes";

/** `scope-column`: the record's own column holding the scope id. */
export type ScopeColumnSql = {
  readonly kind: "scope-column";
  readonly column: AnyColumn;
};

/**
 * `scope-join`: an EXISTS over the record's child rows. `ids` renders as one
 * `uuid[]` parameter; compare with `= ANY(${ids})`.
 */
export type ScopeJoinSql = {
  readonly kind: "scope-join";
  readonly matches: (ids: SQL) => SQL;
};

/** `tag`: the constant condition the wildcard tuple stands for. */
export type TagSql = {
  readonly kind: "tag";
  readonly condition: SQL;
};

/**
 * `derived`: the domain's condition for a role with no column of its own,
 * including that its target id is one of `ids`.
 */
export type DerivedSql = {
  readonly kind: "derived";
  readonly matches: (ids: SQL) => SQL;
};

export type RoleSql = ScopeColumnSql | ScopeJoinSql | TagSql | DerivedSql;

type RoleSqlFor<Binding extends RoleBinding> = Extract<RoleSql, { readonly kind: Binding["kind"] }>;

/**
 * The SQL each declared role needs, by the kind it was declared with. A
 * `sparse-direct` role takes none: the plan matches it on the id column.
 */
export type ScopeSqlRoles<Roles extends ScopeRoleBindings> = {
  readonly [Role in keyof Roles as Roles[Role]["kind"] extends "sparse-direct" ? never : Role]: RoleSqlFor<Roles[Role]>;
};

/** One record's registered SQL bindings, read by `scopePredicate`. */
export type ScopeSqlBindings = {
  readonly wireName: string;
  readonly table: Table;
  readonly id: AnyColumn;
  readonly roles: Readonly<Record<string, RoleSql>>;
};

/**
 * Declare how a bound record's roles render as SQL. Throws, naming every role,
 * when the SQL does not match the declared kinds.
 */
export function scopeSqlBindings<const Roles extends ScopeRoleBindings>(
  bindings: ScopeBindings<Roles>,
  storage: {
    readonly table: Table;
    readonly id: AnyColumn;
    readonly roles: ScopeSqlRoles<Roles> & Readonly<Record<string, RoleSql>>;
  },
): ScopeSqlBindings {
  const wireName = bindings.entity.wireName;
  const failures = mismatchedRoles(bindings.roles, storage.roles);
  if (failures.length > 0) {
    throw new Error(
      `scope SQL bindings for ${wireName} do not match its scope bindings:\n${failures
        .map((failure) => `  ${failure}`)
        .join("\n")}`,
    );
  }
  return {
    wireName,
    table: storage.table,
    id: storage.id,
    roles: storage.roles,
  };
}

function mismatchedRoles(declared: ScopeRoleBindings, rendered: Readonly<Record<string, RoleSql>>): readonly string[] {
  const failures: string[] = [];
  for (const [roleName, binding] of Object.entries<RoleBinding>(declared)) {
    const roleSql = rendered[roleName];
    if (binding.kind === "sparse-direct") {
      if (roleSql !== undefined) {
        failures.push(`role ${roleName} is sparse-direct and takes no SQL; the plan matches it on the id column`);
      }
      continue;
    }
    if (roleSql === undefined) {
      failures.push(`role ${roleName} is bound as ${binding.kind} but has no SQL`);
      continue;
    }
    if (roleSql.kind !== binding.kind) {
      failures.push(`role ${roleName} is bound as ${binding.kind} but its SQL is for ${roleSql.kind}`);
    }
  }
  for (const roleName of Object.keys(rendered)) {
    if (declared[roleName] === undefined) {
      failures.push(`SQL names role ${roleName}, which the scope bindings do not bind`);
    }
  }
  return failures;
}
