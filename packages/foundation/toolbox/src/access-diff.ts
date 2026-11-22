/** Pure-IR schema diffing for SpiceDB `.zed` schemas. */

import { resolve } from "node:path";
import {
  parseZed,
  type AccessIrDefinition,
  type AccessIrPermission,
  type AccessIrRole,
  type AccessIrSubject,
} from "@dads-framework/access";
import {
  canonicalPermissionKey,
  formatAccessDiffSummary,
  formatBaseSubject,
  formatPermissionExpression,
} from "./access-diff-format.js";
import type {
  AccessDiffBreakingChange,
  AccessDiffSafeChange,
  AccessPermissionChangeSummary,
  AccessSchemaDiff,
  DiffZedSchemasOptions,
  ZedSchemaDiffResult,
} from "./access-diff-types.js";
import { loadAccessSource } from "./access-source-loader.js";
import { readZedFile } from "./access-zed-io.js";

export type {
  AccessDiffBreakingChange,
  AccessDiffSafeChange,
  AccessPermissionChangeSummary,
  AccessSchemaDiff,
  DiffZedSchemasOptions,
  ZedSchemaDiffResult,
} from "./access-diff-types.js";

type DiffCollector = {
  readonly safe: AccessDiffSafeChange[];
  readonly breaking: AccessDiffBreakingChange[];
  readonly permissionChanges: AccessPermissionChangeSummary[];
};

/**
 * Load two access sources (`.ts`, `.mts`, `.js`, `.mjs`, or `.zed`), emit
 * their access IR, and classify every change into safe additions/permission
 * edits vs breaking removals.
 */
export async function diffAccessSources(
  options: DiffZedSchemasOptions,
): Promise<ZedSchemaDiffResult> {
  const before = await loadAccessSource(options.beforePath, options.cwd);
  const after = await loadAccessSource(options.afterPath, options.cwd);
  const diff = diffAccessIrDefinitions(before.definitions, after.definitions);

  return {
    beforePath: before.path,
    afterPath: after.path,
    diff,
  };
}

/**
 * Read two `.zed` schema files, parse them into Dads access IR, and classify
 * every change into safe additions/permission edits vs breaking removals.
 */
export function diffZedSchemas(
  options: DiffZedSchemasOptions,
): ZedSchemaDiffResult {
  const baseDirectory = options.cwd ?? process.cwd();
  const beforePath = resolve(baseDirectory, options.beforePath);
  const afterPath = resolve(baseDirectory, options.afterPath);
  const beforeDefinitions = parseZed(readZedFile(beforePath));
  const afterDefinitions = parseZed(readZedFile(afterPath));
  const diff = diffAccessIrDefinitions(beforeDefinitions, afterDefinitions);

  return { beforePath, afterPath, diff };
}

/**
 * Compare two access IR definition lists and classify every resource, role,
 * subject, expiration, and permission change into safe vs breaking.
 */
export function diffAccessIrDefinitions(
  before: readonly AccessIrDefinition[],
  after: readonly AccessIrDefinition[],
): AccessSchemaDiff {
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
    summary: formatAccessDiffSummary(collector, requiresMigration),
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
    classifySubjectChange(
      resource,
      role,
      subject,
      beforeMap.get(subject),
      afterMap.get(subject),
      collector,
    );
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
    recordAddedPermission(resource, permission, next, collector);
    return;
  }
  if (prev !== undefined && next === undefined) {
    recordRemovedPermission(resource, permission, prev, collector);
    return;
  }
  if (prev === undefined || next === undefined) {
    return;
  }
  compareExistingPermission(resource, permission, prev, next, collector);
}

function recordAddedPermission(
  resource: string,
  permission: string,
  next: AccessIrPermission,
  collector: DiffCollector,
): void {
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
}

function recordRemovedPermission(
  resource: string,
  permission: string,
  prev: AccessIrPermission,
  collector: DiffCollector,
): void {
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
