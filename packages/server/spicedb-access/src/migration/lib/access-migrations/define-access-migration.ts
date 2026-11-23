import { isRoleToken, type AccessModel, type RoleToken } from "@dads-framework/access";

import { diffAccessModels, type AccessModelDiff } from "./diff-access-models.js";

export type AccessRoleRef = {
  readonly resource: string;
  readonly role: string;
};

export type AccessMigrationRoleInput = RoleToken | AccessRoleRef;

export type AccessMigrationStepOp =
  | {
      readonly kind: "copy-role";
      readonly from: AccessRoleRef;
      readonly to: AccessRoleRef;
    }
  | {
      readonly kind: "drop-role";
      readonly target: AccessRoleRef;
    };

export type AccessMigrationStepBuilders = {
  copyRole(fromRole: AccessMigrationRoleInput, toRole: AccessMigrationRoleInput): AccessMigrationStepOp;
  dropRole(role: AccessMigrationRoleInput): AccessMigrationStepOp;
  copyParent(fromParentRole: AccessMigrationRoleInput, toParentRole: AccessMigrationRoleInput): AccessMigrationStepOp;
  dropParent(parentRole: AccessMigrationRoleInput): AccessMigrationStepOp;
};

export type DefineAccessMigrationInput = {
  readonly from: AccessModel;
  readonly to: AccessModel;
  readonly steps:
    readonly AccessMigrationStepOp[] | ((ops: AccessMigrationStepBuilders) => readonly AccessMigrationStepOp[]);
};

export type DefinedAccessMigration = {
  readonly id: string;
  readonly from: AccessModel;
  readonly to: AccessModel;
  readonly diff: AccessModelDiff;
  readonly ops: readonly AccessMigrationStepOp[];
};

function toRoleRef(input: AccessMigrationRoleInput): AccessRoleRef {
  const ref: AccessRoleRef = isRoleToken(input)
    ? { resource: input.entityWireName, role: input.roleName }
    : { resource: input.resource, role: input.role };
  if (ref.resource.trim() === "" || ref.role.trim() === "") {
    throw new Error("Access migration role reference requires non-empty resource and role names");
  }
  return Object.freeze(ref);
}

/**
 * Copy stored relationships from `fromRole` to `toRole`, preserving subject
 * relations, wildcards, and expiration timestamps via an idempotent upsert.
 */
export function copyRole(fromRole: AccessMigrationRoleInput, toRole: AccessMigrationRoleInput): AccessMigrationStepOp {
  return Object.freeze({
    kind: "copy-role",
    from: toRoleRef(fromRole),
    to: toRoleRef(toRole),
  });
}

/** Delete all stored relationships for `role`. */
export function dropRole(role: AccessMigrationRoleInput): AccessMigrationStepOp {
  return Object.freeze({
    kind: "drop-role",
    target: toRoleRef(role),
  });
}

/** Semantic helper for reparenting child records from one parent role to another. */
export function copyParent(
  fromParentRole: AccessMigrationRoleInput,
  toParentRole: AccessMigrationRoleInput,
): AccessMigrationStepOp {
  return copyRole(fromParentRole, toParentRole);
}

/** Semantic helper for dropping an obsolete parent role relationship. */
export function dropParent(parentRole: AccessMigrationRoleInput): AccessMigrationStepOp {
  return dropRole(parentRole);
}

const STEP_BUILDERS: AccessMigrationStepBuilders = Object.freeze({
  copyRole,
  dropRole,
  copyParent,
  dropParent,
});

/**
 * Define a backend-portable `(from, to)` access migration that compiles typed
 * step builders into pure data operations runnable across Postgres, SQLite,
 * and SpiceDB.
 */
export function defineAccessMigration(id: string, input: DefineAccessMigrationInput): DefinedAccessMigration {
  const normalizedId = id.trim();
  if (normalizedId === "") {
    throw new Error("Access migration id must be a non-empty string");
  }
  const compiledOps = typeof input.steps === "function" ? input.steps(STEP_BUILDERS) : input.steps;
  return Object.freeze({
    id: normalizedId,
    from: input.from,
    to: input.to,
    diff: diffAccessModels(input.from, input.to),
    ops: Object.freeze([...compiledOps]),
  });
}
