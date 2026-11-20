import { NodePgMigrationJournalError } from "./migration-journal-error.js";

export type MigrationOrderEntry = {
  journalName: string;
  dependsOn?: readonly string[];
};

type Prerequisites = ReadonlyMap<string, readonly string[]>;

/** Legacy entries are one immutable chain; graph entries declare their prerequisites. */
export function planMigrationOrder<Entry extends MigrationOrderEntry>(
  migrations: readonly Entry[],
  appliedNames: readonly string[] = [],
): Entry[] {
  const canonical = migrations.toSorted((left, right) =>
    left.journalName.localeCompare(right.journalName),
  );
  const byName = indexMigrations(canonical);
  const prerequisites = migrationPrerequisites(canonical, byName);
  const ordered = orderDependencies(canonical, byName, prerequisites);
  const applied = validateAppliedOrder(appliedNames, byName, prerequisites);
  const seenApplied = new Set(appliedNames);
  return [
    ...applied,
    ...ordered.filter((entry) => !seenApplied.has(entry.journalName)),
  ];
}

function indexMigrations<Entry extends MigrationOrderEntry>(
  entries: readonly Entry[],
): ReadonlyMap<string, Entry> {
  const byName = new Map<string, Entry>();
  for (const entry of entries) {
    if (byName.has(entry.journalName))
      fail("DUPLICATE", entry.journalName, "duplicate migration identity");
    byName.set(entry.journalName, entry);
  }
  return byName;
}

function migrationPrerequisites(
  canonical: readonly MigrationOrderEntry[],
  byName: ReadonlyMap<string, MigrationOrderEntry>,
): Prerequisites {
  const legacy = canonical.filter((entry) => entry.dependsOn === undefined);
  const prerequisites = new Map<string, readonly string[]>();
  let previousLegacy: string | undefined;
  for (const entry of legacy) {
    prerequisites.set(
      entry.journalName,
      previousLegacy === undefined ? [] : [previousLegacy],
    );
    previousLegacy = entry.journalName;
  }
  for (const entry of canonical) {
    if (entry.dependsOn !== undefined)
      prerequisites.set(
        entry.journalName,
        graphPrerequisites(entry, previousLegacy, byName),
      );
  }
  return prerequisites;
}

function graphPrerequisites(
  entry: MigrationOrderEntry,
  legacyHead: string | undefined,
  byName: ReadonlyMap<string, MigrationOrderEntry>,
): readonly string[] {
  const dependencies = entry.dependsOn ?? [];
  if (new Set(dependencies).size !== dependencies.length)
    fail("DUPLICATE_DEPENDENCY", entry.journalName, "duplicate prerequisite");
  for (const dependency of dependencies) {
    if (!byName.has(dependency))
      fail(
        "DEPENDENCY_MISSING",
        entry.journalName,
        `missing prerequisite ${dependency}`,
      );
  }
  return legacyHead === undefined
    ? dependencies
    : [...dependencies, legacyHead];
}

function orderDependencies<Entry extends MigrationOrderEntry>(
  entries: readonly Entry[],
  byName: ReadonlyMap<string, Entry>,
  prerequisites: Prerequisites,
): Entry[] {
  const ordered: Entry[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(entry: Entry): void {
    if (visited.has(entry.journalName)) return;
    if (visiting.has(entry.journalName))
      fail(
        "DEPENDENCY_CYCLE",
        entry.journalName,
        "migration prerequisite cycle",
      );
    visiting.add(entry.journalName);
    for (const dependency of prerequisites.get(entry.journalName) ?? []) {
      const predecessor = byName.get(dependency);
      if (predecessor !== undefined) visit(predecessor);
    }
    visiting.delete(entry.journalName);
    visited.add(entry.journalName);
    ordered.push(entry);
  }
  for (const entry of entries) visit(entry);
  return ordered;
}

function validateAppliedOrder<Entry extends MigrationOrderEntry>(
  appliedNames: readonly string[],
  byName: ReadonlyMap<string, Entry>,
  prerequisites: Prerequisites,
): Entry[] {
  const applied: Entry[] = [];
  const seenApplied = new Set<string>();
  for (const name of appliedNames) {
    const entry = byName.get(name);
    if (entry === undefined)
      fail(
        "DATABASE_AHEAD",
        name,
        "applied migration is missing from this build",
      );
    if (seenApplied.has(name))
      fail("JOURNAL_DUPLICATE", name, "duplicate applied migration");
    for (const dependency of prerequisites.get(name) ?? []) {
      if (!seenApplied.has(dependency))
        fail(
          "ORDER_DRIFT",
          name,
          `applied journal has a gap before ${name}; prerequisite ${dependency} was not applied first`,
        );
    }
    seenApplied.add(name);
    applied.push(entry);
  }
  return applied;
}

function fail(code: string, name: string, message: string): never {
  throw new NodePgMigrationJournalError(
    `NODE_PG_MIGRATION_${code}`,
    name,
    message,
  );
}
