import {
  applyDesiredAuthorizationSchema,
  parseWriteSchemaBlocker,
} from "@dads-framework/access/schema";

import { authorizationLegacyJournalChecksum } from "./journal/authorization-change-files.js";
import type {
  AuthorizationMigration,
  AuthorizationMigrationStore,
  LoadedAuthorizationMigration,
} from "./journal/journal-entry.js";
import { loadAuthorizationChanges } from "./journal/load-authorization-changes.js";
import { JOURNAL_DEFINITION, loadJournal } from "./journal/load-journal.js";
import { classifySchemaDiff } from "./logic/classify-schema-diff.js";
import {
  prepareAuthorizationChanges,
  type PreparedAuthorizationChanges,
  runPreparedAuthorizationChanges,
} from "./run-authorization-changes.js";

export type AuthorizationMigrationsLog = {
  info(context: object, message: string): void;
};

export type RunAuthorizationMigrationsOptions = {
  journal: readonly AuthorizationMigration[];
  journalFolder: string;
  /** Independently authored definition patches after the immutable legacy prefix. */
  changesFolder?: string;
  store: AuthorizationMigrationStore;
  log: AuthorizationMigrationsLog;
  /**
   * Clones the SpiceDB datastore before anything destructive (the kit's
   * cloneSpiceDbDatastore, when a datastore Postgres URL is configured).
   * Optional: without it the runner proceeds and says so.
   */
  snapshotDatastore?: () => Promise<"cloned" | "skipped">;
};

/** The single well-known journal resource the applied markers hang off. */
const JOURNAL_RESOURCE = { type: JOURNAL_DEFINITION, id: "journal" } as const;
const APPLIED_RELATION = "applied";
const VERSION_DEFINITION = "authz/migration_version";

/**
 * Applies every pending journal entry in order.
 *
 * A store whose live schema has never contained the journal definition is
 * pre-journal (the AWS prototype, a fresh SpiceDB, a reset dev store). Its
 * first entry applies through the kit's desired-state convergence —
 * datastore clone, leftover-tuple contraction, schema write — because a
 * pre-journal store never signed the journal's contract. Every entry after
 * that applies strictly: beforeSchemaWrite (the relationship work that makes
 * the write legal) → WriteSchema(snapshot) → afterSchemaWrite → applied
 * marker, with a datastore clone first when the diff is destructive, and a
 * refusal naming the blocking relation when a destructive write has no step.
 * A failure leaves the marker unwritten, so the next run resumes there.
 */
export async function runAuthorizationMigrations(
  options: RunAuthorizationMigrationsOptions,
): Promise<void> {
  const { store, log } = options;
  const journal = await loadJournal(options.journal, options.journalFolder);

  const liveSchema = await store.readSchema();
  const journaled = isJournaledSchema(liveSchema);
  const applied = journaled ? await readAppliedEntryIds(store) : [];
  const graph = await loadAuthorizationGraph(options, journal, applied);
  const legacyApplied = graph?.legacyApplied ?? applied;
  const pending = pendingEntries(journal, legacyApplied);

  let previousSchema = previousAuthorizationSchema(
    journal,
    legacyApplied,
    liveSchema,
  );

  for (const entry of pending) {
    const genesisConvergence = !journaled && entry === pending[0];
    if (genesisConvergence) {
      await convergePreJournalStore(entry, options);
    } else {
      await applyEntry(entry, previousSchema, options);
    }
    await recordAppliedMarker(entry, store);
    previousSchema = entry.schema;
    log.info(
      {
        event: "authorization.migrate.applied",
        entry: entry.id,
        genesis: genesisConvergence,
      },
      "authorization migration applied",
    );
  }

  const appliedChanges =
    graph === undefined
      ? 0
      : await runPreparedAuthorizationChanges(graph, options);

  log.info(
    {
      event: "authorization.migrate.complete",
      code: "AUTHORIZATION_MIGRATION_COMPLETE",
      alreadyApplied: legacyApplied.length + (graph?.applied.size ?? 0),
      applied: pending.length + appliedChanges,
    },
    "authorization store is at the checked-in journal",
  );
}

/**
 * What `runAuthorizationMigrations` would apply, without applying anything.
 * The status command and `--check` mode report from this.
 */
export async function pendingAuthorizationMigrationIds(
  options: Pick<
    RunAuthorizationMigrationsOptions,
    "journal" | "journalFolder" | "changesFolder" | "store"
  >,
): Promise<readonly string[]> {
  const journal = await loadJournal(options.journal, options.journalFolder);
  const applied = await readAppliedAuthorizationMigrationIds(options.store);
  const graph = await loadAuthorizationGraph(options, journal, applied);
  return [
    ...pendingEntries(journal, graph?.legacyApplied ?? applied).map(
      (entry) => entry.id,
    ),
    ...(graph?.ordered
      .filter((change) => !graph.applied.has(change.id))
      .map((change) => change.id) ?? []),
  ];
}

async function loadAuthorizationGraph(
  options: Pick<
    RunAuthorizationMigrationsOptions,
    "changesFolder" | "journalFolder"
  >,
  journal: readonly LoadedAuthorizationMigration[],
  applied: readonly string[],
): Promise<PreparedAuthorizationChanges | undefined> {
  if (options.changesFolder === undefined) return undefined;
  const changes = await loadAuthorizationChanges(options.changesFolder);
  if (changes.length === 0) return undefined;
  return prepareAuthorizationChanges(
    journal,
    changes,
    applied,
    await authorizationLegacyJournalChecksum(options.journalFolder),
  );
}

function previousAuthorizationSchema(
  journal: readonly LoadedAuthorizationMigration[],
  applied: readonly string[],
  liveSchema: string,
): string {
  if (applied.length === 0) return liveSchema;
  return journal[applied.length - 1]?.schema ?? liveSchema;
}

/**
 * The one-time cutover for a store that predates the journal: converge to
 * the entry's snapshot the way the desired-state applier always did — clone
 * the datastore when possible, delete tuples left under removed shapes,
 * write. The entry's own relationship steps are not run; convergence
 * subsumes them, and every store after this carries the journal contract.
 */
async function convergePreJournalStore(
  entry: LoadedAuthorizationMigration,
  options: RunAuthorizationMigrationsOptions,
): Promise<void> {
  await applyDesiredAuthorizationSchema({
    store: options.store,
    desiredSchema: entry.schema,
    ...(options.snapshotDatastore
      ? { snapshotDatastore: options.snapshotDatastore }
      : {}),
    log: options.log,
  });
}

/** What reading the applied markers needs — no schema or relationship writes. */
export type AuthorizationJournalMarkerReader = Pick<
  AuthorizationMigrationStore,
  "readSchema" | "listDirectSubjects"
>;

/**
 * The journal entry ids this store holds an applied marker for, sorted —
 * read only. A store whose live schema never contained the journal
 * definition is pre-journal: it has applied nothing, whatever tuples it holds.
 */
export async function readAppliedAuthorizationMigrationIds(
  store: AuthorizationJournalMarkerReader,
): Promise<readonly string[]> {
  const liveSchema = await store.readSchema();
  return isJournaledSchema(liveSchema) ? readAppliedEntryIds(store) : [];
}

function isJournaledSchema(liveSchema: string): boolean {
  return liveSchema.includes(`definition ${JOURNAL_DEFINITION}`);
}

async function readAppliedEntryIds(
  store: AuthorizationJournalMarkerReader,
): Promise<readonly string[]> {
  const subjects = await store.listDirectSubjects({
    resource: JOURNAL_RESOURCE,
    relation: APPLIED_RELATION,
    consistency: "fully-consistent",
  });
  return subjects
    .filter((subject) => subject.type === VERSION_DEFINITION)
    .map((subject) => subject.id)
    .sort();
}

/**
 * The applied markers must be exactly a prefix of the checked-in journal —
 * a store that has applied entries this build does not know about is ahead
 * of the code trying to migrate it, and continuing would misnumber
 * everything after.
 */
function pendingEntries(
  journal: readonly LoadedAuthorizationMigration[],
  applied: readonly string[],
): readonly LoadedAuthorizationMigration[] {
  const journalIds = journal.map((entry) => entry.id);
  const unknown = applied.filter((id) => !journalIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `authorization store has applied entries this journal does not contain: ` +
        `${unknown.join(", ")} — the store is ahead of this build`,
    );
  }

  const expectedPrefix = journalIds.slice(0, applied.length);
  if (applied.join(",") !== expectedPrefix.join(",")) {
    throw new Error(
      `authorization store's applied entries (${applied.join(", ")}) are not a ` +
        `prefix of the journal (${journalIds.join(", ")})`,
    );
  }

  return journal.slice(applied.length);
}

async function applyEntry(
  entry: LoadedAuthorizationMigration,
  previousSchema: string,
  options: RunAuthorizationMigrationsOptions,
): Promise<void> {
  const { store, log } = options;

  const classification = classifySchemaDiff(previousSchema, entry.schema);
  if (classification.kind === "destructive") {
    const snapshot = options.snapshotDatastore
      ? await options.snapshotDatastore()
      : "skipped";
    log.info(
      {
        event: "authorization.migrate.snapshot",
        entry: entry.id,
        snapshot,
        removals: classification.removals,
      },
      "destructive entry — datastore snapshot before applying",
    );
  }

  if (entry.beforeSchemaWrite) {
    await runStep(
      entry,
      "beforeSchemaWrite",
      () => entry.beforeSchemaWrite?.(store) ?? Promise.resolve(),
    );
  }

  try {
    await store.writeSchema(entry.schema);
  } catch (error) {
    throw schemaWriteFailure(entry, error);
  }

  if (entry.afterSchemaWrite) {
    await runStep(
      entry,
      "afterSchemaWrite",
      () => entry.afterSchemaWrite?.(store) ?? Promise.resolve(),
    );
  }
}

async function recordAppliedMarker(
  entry: LoadedAuthorizationMigration,
  store: AuthorizationMigrationStore,
): Promise<void> {
  await store.writeRelationships([
    {
      resource: JOURNAL_RESOURCE,
      relation: APPLIED_RELATION,
      subject: { type: VERSION_DEFINITION, id: entry.id },
    },
  ]);
}

/**
 * A refused schema write is the journal's teaching moment: when SpiceDB
 * names the blocker, say exactly which relationship step is missing.
 */
function schemaWriteFailure(
  entry: LoadedAuthorizationMigration,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const blocker = parseWriteSchemaBlocker(message);
  if (blocker === undefined) {
    return new Error(
      `authorization migration ${entry.id} failed during schema write: ${message}`,
      { cause: error },
    );
  }
  const blocked =
    blocker.kind === "removed-type"
      ? `definition ${blocker.resourceType}`
      : `${blocker.resourceType}#${blocker.relation}`;
  return new Error(
    `authorization migration ${entry.id} is destructive for ${blocked} but its ` +
      `relationship step did not clear the stored relationships — SpiceDB said: ${message}`,
    { cause: error },
  );
}

async function runStep(
  entry: LoadedAuthorizationMigration,
  phase: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `authorization migration ${entry.id} failed during ${phase}: ${message}`,
      { cause: error },
    );
  }
}
