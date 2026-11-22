import {
  emitAccessIr,
  type AccessIrDefinition,
  type AccessIrPermission,
  type AccessIrRole,
  type AccessIrSubject,
  type AccessModel,
} from "@dads-framework/access";

import {
  canonicalPermissionKey,
  formatBaseSubject,
  formatDiffSummary,
  formatPermissionExpression,
} from "./diff-access-models-format.js";

export type AccessModelSafeChange =
  | { readonly kind: "added-resource"; readonly resource: string }
  | {
      readonly kind: "added-role";
      readonly resource: string;
      readonly role: string;
    }
  | {
      readonly kind: "widened-role";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "added-expiration";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "added-permission";
      readonly resource: string;
      readonly permission: string;
      readonly expression: string;
    }
  | {
      readonly kind: "modified-permission";
      readonly resource: string;
      readonly permission: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "removed-permission";
      readonly resource: string;
      readonly permission: string;
      readonly before: string;
    };

export type AccessModelBreakingChange =
  | { readonly kind: "removed-resource"; readonly resource: string }
  | {
      readonly kind: "removed-role";
      readonly resource: string;
      readonly role: string;
    }
  | {
      readonly kind: "narrowed-role";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    }
  | {
      readonly kind: "removed-expiration";
      readonly resource: string;
      readonly role: string;
      readonly subject: string;
    };

export type PermissionChangeSummary = {
  readonly kind: "added" | "modified" | "removed";
  readonly resource: string;
  readonly permission: string;
  readonly before?: string;
  readonly after?: string;
  readonly description: string;
};

export type AccessModelDiff = {
  readonly safe: readonly AccessModelSafeChange[];
  readonly breaking: readonly AccessModelBreakingChange[];
  readonly permissionChanges: readonly PermissionChangeSummary[];
  readonly requiresMigration: boolean;
  readonly summary: string;
};

type DiffCollector = {
  readonly safe: AccessModelSafeChange[];
  readonly breaking: AccessModelBreakingChange[];
  readonly permissionChanges: PermissionChangeSummary[];
};

/**
 * Compare two `AccessModel` instances and classify every schema change into
 * safe additions/computed-permission edits vs breaking tuple-bearing removals.
 */
export function diffAccessModels(
  before: AccessModel,
  after: AccessModel,
): AccessModelDiff {
  return diffAccessIr(emitAccessIr(before), emitAccessIr(after));
}

/**
 * Compare two access IR definition lists and classify every change into safe
 * vs breaking changes with human-readable permission impact summaries.
 */
export function diffAccessIr(
  before: readonly AccessIrDefinition[],
  after: readonly AccessIrDefinition[],
): AccessModelDiff {
  const beforeMap = new Map(before.map((def) => [def.wireName, def]));
  const afterMap = new Map(after.map((def) => [def.wireName, def]));
  const collector: DiffCollector = {
    safe: [],
    breaking: [],
    permissionChanges: [],
  };

  for (const wireName of sortedUnionKeys(beforeMap, afterMap)) {
    diffDefinition(
      wireName,
      beforeMap.get(wireName),
      afterMap.get(wireName),
      collector,
    );
  }

  const requiresMigration = collector.breaking.length > 0;
  return {
    safe: collector.safe,
    breaking: collector.breaking,
    permissionChanges: collector.permissionChanges,
    requiresMigration,
    summary: formatDiffSummary(collector, requiresMigration),
  };
}

function diffDefinition(
  resource: string,
  before: AccessIrDefinition | undefined,
  after: AccessIrDefinition | undefined,
  collector: DiffCollector,
): void {
  if (before === undefined && after !== undefined) {
    collector.safe.push({ kind: "added-resource", resource });
    recordAddedDefinitionPermissions(after, collector);
    return;
  }
  if (before !== undefined && after === undefined) {
    collector.breaking.push({ kind: "removed-resource", resource });
    return;
  }
  if (before === undefined || after === undefined) {
    return;
  }
  diffRoles(resource, before.roles, after.roles, collector);
  diffPermissions(resource, before.permissions, after.permissions, collector);
}

function recordAddedDefinitionPermissions(
  definition: AccessIrDefinition,
  collector: DiffCollector,
): void {
  for (const permission of definition.permissions) {
    const expression = formatPermissionExpression(permission.terms);
    collector.permissionChanges.push({
      kind: "added",
      resource: definition.wireName,
      permission: permission.name,
      after: expression,
      description: `Added permission ${definition.wireName}#${permission.name} = ${expression}`,
    });
  }
}

function diffRoles(
  resource: string,
  beforeRoles: readonly AccessIrRole[],
  afterRoles: readonly AccessIrRole[],
  collector: DiffCollector,
): void {
  const beforeMap = new Map(beforeRoles.map((role) => [role.name, role]));
  const afterMap = new Map(afterRoles.map((role) => [role.name, role]));

  for (const roleName of sortedUnionKeys(beforeMap, afterMap)) {
    const prev = beforeMap.get(roleName);
    const next = afterMap.get(roleName);
    if (prev === undefined && next !== undefined) {
      collector.safe.push({ kind: "added-role", resource, role: roleName });
      continue;
    }
    if (prev !== undefined && next === undefined) {
      collector.breaking.push({
        kind: "removed-role",
        resource,
        role: roleName,
      });
      continue;
    }
    if (prev !== undefined && next !== undefined) {
      diffRoleSubjects(
        resource,
        roleName,
        prev.subjects,
        next.subjects,
        collector,
      );
    }
  }
}

function diffRoleSubjects(
  resource: string,
  role: string,
  beforeSubjects: readonly AccessIrSubject[],
  afterSubjects: readonly AccessIrSubject[],
  collector: DiffCollector,
): void {
  const beforeMap = indexSubjects(beforeSubjects);
  const afterMap = indexSubjects(afterSubjects);

  for (const subject of sortedUnionKeys(beforeMap, afterMap)) {
    const prevExp = beforeMap.get(subject);
    const nextExp = afterMap.get(subject);
    classifySubjectChange(resource, role, subject, prevExp, nextExp, collector);
  }
}

function classifySubjectChange(
  resource: string,
  role: string,
  subject: string,
  prevExp: boolean | undefined,
  nextExp: boolean | undefined,
  collector: DiffCollector,
): void {
  if (prevExp === undefined && nextExp !== undefined) {
    collector.safe.push({ kind: "widened-role", resource, role, subject });
    return;
  }
  if (prevExp !== undefined && nextExp === undefined) {
    collector.breaking.push({ kind: "narrowed-role", resource, role, subject });
    return;
  }
  if (prevExp === true && nextExp === false) {
    collector.breaking.push({
      kind: "removed-expiration",
      resource,
      role,
      subject,
    });
    return;
  }
  if (prevExp === false && nextExp === true) {
    collector.safe.push({ kind: "added-expiration", resource, role, subject });
  }
}

function indexSubjects(
  subjects: readonly AccessIrSubject[],
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const subject of subjects) {
    const key = formatBaseSubject(subject);
    const existing = map.get(key) === true;
    map.set(key, existing || subject.expiration === true);
  }
  return map;
}

function diffPermissions(
  resource: string,
  beforePermissions: readonly AccessIrPermission[],
  afterPermissions: readonly AccessIrPermission[],
  collector: DiffCollector,
): void {
  const beforeMap = new Map(beforePermissions.map((p) => [p.name, p]));
  const afterMap = new Map(afterPermissions.map((p) => [p.name, p]));

  for (const permission of sortedUnionKeys(beforeMap, afterMap)) {
    diffSinglePermission(
      resource,
      permission,
      beforeMap.get(permission),
      afterMap.get(permission),
      collector,
    );
  }
}

function diffSinglePermission(
  resource: string,
  permission: string,
  prev: AccessIrPermission | undefined,
  next: AccessIrPermission | undefined,
  collector: DiffCollector,
): void {
  if (prev === undefined && next !== undefined) {
    const expression = formatPermissionExpression(next.terms);
    collector.safe.push({
      kind: "added-permission",
      resource,
      permission,
      expression,
    });
    collector.permissionChanges.push({
      kind: "added",
      resource,
      permission,
      after: expression,
      description: `Added permission ${resource}#${permission} = ${expression}`,
    });
    return;
  }
  if (prev !== undefined && next === undefined) {
    const before = formatPermissionExpression(prev.terms);
    collector.safe.push({
      kind: "removed-permission",
      resource,
      permission,
      before,
    });
    collector.permissionChanges.push({
      kind: "removed",
      resource,
      permission,
      before,
      description: `Removed permission ${resource}#${permission} (was ${before})`,
    });
    return;
  }
  if (prev === undefined || next === undefined) {
    return;
  }
  compareExistingPermission(resource, permission, prev, next, collector);
}

function compareExistingPermission(
  resource: string,
  permission: string,
  prev: AccessIrPermission,
  next: AccessIrPermission,
  collector: DiffCollector,
): void {
  if (
    canonicalPermissionKey(prev.terms) === canonicalPermissionKey(next.terms)
  ) {
    return;
  }
  const before = formatPermissionExpression(prev.terms);
  const after = formatPermissionExpression(next.terms);
  collector.safe.push({
    kind: "modified-permission",
    resource,
    permission,
    before,
    after,
  });
  collector.permissionChanges.push({
    kind: "modified",
    resource,
    permission,
    before,
    after,
    description: `Modified permission ${resource}#${permission}: ${before} -> ${after}`,
  });
}

function sortedUnionKeys<T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
): readonly string[] {
  return [...new Set([...left.keys(), ...right.keys()])].sort();
}
