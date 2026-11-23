import type { AccessIrDefinition } from "@dads-framework/access";
import type {
  PermissionQuery,
  ResourceLookup,
  SubjectRef,
} from "@dads-framework/access/runtime";

import type { SpiceDbExportedTuple } from "./authzed-client-adapter.js";

const DEFAULT_NEGATIVE_SUBJECT_IDS: readonly string[] = ["__parity_stranger__"];

/** Minimal authorization query surface satisfied by both `SpiceDbAuthorization` and `PostgresAuthorization`. */
export type ParityAuthorizationClient = {
  check(query: PermissionQuery): Promise<boolean>;
  lookupResources(query: ResourceLookup): Promise<readonly string[]>;
};

export type ParityMismatch =
  | {
      readonly kind: "check";
      readonly query: PermissionQuery;
      readonly spiceDb: boolean;
      readonly postgres: boolean;
    }
  | {
      readonly kind: "lookup-resources";
      readonly query: ResourceLookup;
      readonly spiceDb: readonly string[];
      readonly postgres: readonly string[];
    };

export type ParityVerificationResult = {
  readonly total: number;
  readonly matched: number;
  readonly mismatches: readonly ParityMismatch[];
};

export type DerivedParityQueries = {
  readonly checkQueries: readonly PermissionQuery[];
  readonly lookupQueries: readonly ResourceLookup[];
};

export type VerifySpiceDbPostgresParityOptions = {
  readonly spiceDb: ParityAuthorizationClient;
  readonly postgres: ParityAuthorizationClient;
  readonly checkQueries?: readonly PermissionQuery[];
  readonly lookupQueries?: readonly ResourceLookup[];
  /** Optional parsed IR definitions for auto-deriving check and lookup queries. */
  readonly definitions?: readonly AccessIrDefinition[];
  /** Optional migrated tuples for auto-deriving check and lookup queries. */
  readonly tuples?: readonly SpiceDbExportedTuple[];
  /** Synthetic non-existent subject IDs added when auto-deriving queries to prove denial parity. */
  readonly negativeSubjectIds?: readonly string[];
};

/**
 * Derive permission check queries and resource lookup queries directly from
 * parsed schema definitions and exported tuples.
 */
export function deriveParityQueries(
  definitions: readonly AccessIrDefinition[],
  tuples: readonly SpiceDbExportedTuple[],
  negativeSubjectIds: readonly string[] = DEFAULT_NEGATIVE_SUBJECT_IDS,
): DerivedParityQueries {
  const resourcesByType = collectResourcesByType(tuples);
  const actorTypes = leafSubjectTypes(definitions);
  const subjectsByType = collectSubjectsByType(
    tuples,
    actorTypes,
    negativeSubjectIds,
  );
  const allSubjects = flattenSubjects(subjectsByType);

  const checkQueries: PermissionQuery[] = [];
  const lookupQueries: ResourceLookup[] = [];

  for (const definition of definitions) {
    if (definition.permissions.length === 0) continue;
    const resourceIds = [...(resourcesByType.get(definition.wireName) ?? [])];
    if (resourceIds.length === 0) continue;

    appendQueriesForDefinition(
      definition,
      resourceIds,
      allSubjects,
      checkQueries,
      lookupQueries,
    );
  }

  return { checkQueries, lookupQueries };
}

/**
 * Compare SpiceDB and Postgres authorization decisions across explicit and/or
 * auto-derived check and resource lookup queries.
 */
export async function verifySpiceDbPostgresParity(
  options: VerifySpiceDbPostgresParityOptions,
): Promise<ParityVerificationResult> {
  const derived =
    options.definitions !== undefined && options.tuples !== undefined
      ? deriveParityQueries(
          options.definitions,
          options.tuples,
          options.negativeSubjectIds,
        )
      : { checkQueries: [], lookupQueries: [] };

  const checkQueries = deduplicateCheckQueries([
    ...derived.checkQueries,
    ...(options.checkQueries ?? []),
  ]);
  const lookupQueries = deduplicateLookupQueries([
    ...derived.lookupQueries,
    ...(options.lookupQueries ?? []),
  ]);

  const mismatches: ParityMismatch[] = [];
  await compareCheckQueries(
    options.spiceDb,
    options.postgres,
    checkQueries,
    mismatches,
  );
  await compareLookupQueries(
    options.spiceDb,
    options.postgres,
    lookupQueries,
    mismatches,
  );

  const total = checkQueries.length + lookupQueries.length;
  return {
    total,
    matched: total - mismatches.length,
    mismatches,
  };
}

async function compareCheckQueries(
  spiceDb: ParityAuthorizationClient,
  postgres: ParityAuthorizationClient,
  queries: readonly PermissionQuery[],
  mismatches: ParityMismatch[],
): Promise<void> {
  for (const query of queries) {
    const [spiceAllowed, pgAllowed] = await Promise.all([
      spiceDb.check(query),
      postgres.check(query),
    ]);
    if (spiceAllowed !== pgAllowed) {
      mismatches.push({
        kind: "check",
        query,
        spiceDb: spiceAllowed,
        postgres: pgAllowed,
      });
    }
  }
}

async function compareLookupQueries(
  spiceDb: ParityAuthorizationClient,
  postgres: ParityAuthorizationClient,
  queries: readonly ResourceLookup[],
  mismatches: ParityMismatch[],
): Promise<void> {
  for (const query of queries) {
    const [spiceIds, pgIds] = await Promise.all([
      spiceDb.lookupResources(query),
      postgres.lookupResources(query),
    ]);
    const sortedSpice = [...new Set(spiceIds)].sort();
    const sortedPg = [...new Set(pgIds)].sort();
    if (!stringArraysEqual(sortedSpice, sortedPg)) {
      mismatches.push({
        kind: "lookup-resources",
        query,
        spiceDb: sortedSpice,
        postgres: sortedPg,
      });
    }
  }
}

function appendQueriesForDefinition(
  definition: AccessIrDefinition,
  resourceIds: readonly string[],
  subjects: readonly SubjectRef[],
  checkQueries: PermissionQuery[],
  lookupQueries: ResourceLookup[],
): void {
  for (const permission of definition.permissions) {
    for (const subject of subjects) {
      lookupQueries.push({
        subject,
        permission: permission.name,
        resourceType: definition.wireName,
      });
      appendChecksForResourceIds(
        definition.wireName,
        permission.name,
        subject,
        resourceIds,
        checkQueries,
      );
    }
  }
}

function appendChecksForResourceIds(
  resourceType: string,
  permission: string,
  subject: SubjectRef,
  resourceIds: readonly string[],
  target: PermissionQuery[],
): void {
  for (const id of resourceIds) {
    target.push({
      subject,
      permission,
      resource: { type: resourceType, id },
    });
  }
}

function collectResourcesByType(
  tuples: readonly SpiceDbExportedTuple[],
): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const tuple of tuples) {
    addToSetMap(byType, tuple.resource.type, tuple.resource.id);
  }
  return byType;
}

function leafSubjectTypes(
  definitions: readonly AccessIrDefinition[],
): ReadonlySet<string> {
  return new Set(
    definitions
      .filter((def) => def.roles.length === 0 && def.permissions.length === 0)
      .map((def) => def.wireName),
  );
}

function collectSubjectsByType(
  tuples: readonly SpiceDbExportedTuple[],
  actorTypes: ReadonlySet<string>,
  negativeSubjectIds: readonly string[],
): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const tuple of tuples) {
    if (tuple.subject.relation !== undefined) continue;
    if (actorTypes.size > 0 && !actorTypes.has(tuple.subject.type)) continue;
    if (tuple.subject.id === "*") {
      ensureSetEntry(byType, tuple.subject.type);
      continue;
    }
    addToSetMap(byType, tuple.subject.type, tuple.subject.id);
  }
  for (const ids of byType.values()) {
    for (const negId of negativeSubjectIds) {
      ids.add(negId);
    }
  }
  return byType;
}

function ensureSetEntry(map: Map<string, Set<string>>, key: string): void {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
}

function flattenSubjects(
  byType: ReadonlyMap<string, ReadonlySet<string>>,
): readonly SubjectRef[] {
  const subjects: SubjectRef[] = [];
  for (const [type, ids] of [...byType.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const id of [...ids].sort()) {
      subjects.push({ type, id });
    }
  }
  return subjects;
}

function addToSetMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function deduplicateCheckQueries(
  queries: readonly PermissionQuery[],
): readonly PermissionQuery[] {
  const byKey = new Map<string, PermissionQuery>();
  for (const q of queries) {
    const key = [
      q.subject.type,
      q.subject.id,
      q.subject.relation ?? "",
      q.permission,
      q.resource.type,
      q.resource.id,
    ].join("\u0000");
    if (!byKey.has(key)) byKey.set(key, q);
  }
  return [...byKey.values()];
}

function deduplicateLookupQueries(
  queries: readonly ResourceLookup[],
): readonly ResourceLookup[] {
  const byKey = new Map<string, ResourceLookup>();
  for (const q of queries) {
    const key = [
      q.subject.type,
      q.subject.id,
      q.subject.relation ?? "",
      q.permission,
      q.resourceType,
    ].join("\u0000");
    if (!byKey.has(key)) byKey.set(key, q);
  }
  return [...byKey.values()];
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
