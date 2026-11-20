import { parseWriteSchemaBlocker } from "@dads-framework/access/schema";
import type { RelationshipWrite } from "@dads-framework/access/runtime";

import {
  applyAuthorizationDefinitionPatches,
  AuthorizationChangeError,
  authorizationSchemaDefinitions,
  authorizationSchemaFingerprint,
  composeAuthorizationChanges,
} from "../definition-changes.mjs";
import type { LoadedAuthorizationChange } from "./journal/load-authorization-changes.js";
import {
  authorizationAppliedMarker as appliedMarker,
  type PreparedAuthorizationChanges,
  type StartedChange,
} from "./logic/authorization-change-history.js";
import { classifySchemaDiff } from "./logic/classify-schema-diff.js";
import type { RunAuthorizationMigrationsOptions } from "./run-authorization-migrations.js";

export {
  prepareAuthorizationChanges,
  type PreparedAuthorizationChanges,
} from "./logic/authorization-change-history.js";

type AuthorizationChangeExecution = {
  readonly schema: string;
  readonly pending: readonly LoadedAuthorizationChange[];
  readonly applied: number;
};

export async function runPreparedAuthorizationChanges(
  prepared: PreparedAuthorizationChanges,
  options: RunAuthorizationMigrationsOptions,
): Promise<number> {
  const initialSchema = composeAuthorizationChanges(
    prepared.baseline,
    prepared.ordered.filter((change) => prepared.applied.has(change.id)),
  );
  const initialPending = prepared.ordered.filter(
    (change) => !prepared.applied.has(change.id),
  );
  const resumed = await resumeStartedAuthorizationChange(
    prepared,
    initialSchema,
    initialPending,
    options,
  );
  let schema = resumed.schema;
  if (resumed.pending.length > 0 && !prepared.barrier)
    await options.store.writeRelationships([
      markerFact(prepared.barrierMarker),
    ]);
  for (const change of resumed.pending)
    schema = await runPendingAuthorizationChange(change, schema, options);
  const applied = resumed.applied + resumed.pending.length;
  options.log.info(
    {
      event: "authorization.change.complete",
      applied,
    },
    "authorization store is at the checked-in definition changes",
  );
  return applied;
}

async function resumeStartedAuthorizationChange(
  prepared: PreparedAuthorizationChanges,
  schema: string,
  pending: readonly LoadedAuthorizationChange[],
  options: RunAuthorizationMigrationsOptions,
): Promise<AuthorizationChangeExecution> {
  const live = await options.store.readSchema();
  const active = prepared.started;
  if (active === undefined) {
    assertRecordedSchema(schema, live);
    return { schema, pending, applied: 0 };
  }
  if (prepared.applied.has(active.id)) {
    assertCompletedStartedSchema(schema, live, active);
    await options.store.deleteExactRelationship(markerFact(active.marker));
    return { schema, pending, applied: 0 };
  }
  const change = requiredStartedChange(active, pending, prepared.applied);
  if (active.checksum !== change.checksum) {
    assertCorrectionBeforeSchemaWrite(active, schema, live);
    // Retire the stale marker first: a failed replacement write leaves the
    // recorded pre-change schema retryable without two in-progress entries.
    await options.store.deleteExactRelationship(markerFact(active.marker));
    const after = await runPendingAuthorizationChange(change, schema, options);
    return {
      schema: after,
      pending: pending.filter((entry) => entry.id !== change.id),
      applied: 1,
    };
  }
  const after = applyAuthorizationDefinitionPatches(schema, change);
  const schemaWritten = verifyStartedSchema(active, schema, after, live);
  await applyChange(
    change,
    schema,
    after,
    active.marker,
    schemaWritten,
    options,
  );
  return {
    schema: after,
    pending: pending.filter((entry) => entry.id !== change.id),
    applied: 1,
  };
}

function assertCorrectionBeforeSchemaWrite(
  active: StartedChange,
  before: string,
  live: string,
): void {
  if (authorizationSchemaFingerprint(before) !== active.beforeHash)
    throw driftFailure(before, live);
  const liveHash = authorizationSchemaFingerprint(live);
  if (liveHash === active.beforeHash) return;
  if (liveHash === active.afterHash)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_CHECKSUM",
      `authorization change ${active.id} checksum differs after its schema write; retry the exact recorded content`,
    );
  throw driftFailure(before, live);
}

function requiredStartedChange(
  active: StartedChange,
  pending: readonly LoadedAuthorizationChange[],
  applied: ReadonlySet<string>,
): LoadedAuthorizationChange {
  const change = pending.find((candidate) => candidate.id === active.id);
  if (
    change === undefined ||
    !change.dependsOn.every(
      (dependency) =>
        dependency === change.legacyHead || applied.has(dependency),
    )
  )
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      `started authorization change ${active.id} has unapplied prerequisites`,
    );
  return change;
}

function verifyStartedSchema(
  active: StartedChange,
  before: string,
  after: string,
  live: string,
): boolean {
  const beforeHash = authorizationSchemaFingerprint(before);
  const afterHash = authorizationSchemaFingerprint(after);
  const liveHash = authorizationSchemaFingerprint(live);
  if (
    active.beforeHash !== beforeHash ||
    active.afterHash !== afterHash ||
    (liveHash !== beforeHash && liveHash !== afterHash)
  )
    throw driftFailure(before, live);
  // Equal fingerprints cannot prove that the before hook finished.
  return liveHash === afterHash && beforeHash !== afterHash;
}

function assertCompletedStartedSchema(
  schema: string,
  live: string,
  active: StartedChange,
): void {
  if (
    authorizationSchemaFingerprint(live) !== active.afterHash ||
    authorizationSchemaFingerprint(schema) !== active.afterHash
  )
    throw driftFailure(schema, live);
}

function assertRecordedSchema(schema: string, live: string): void {
  if (
    authorizationSchemaFingerprint(live) !==
    authorizationSchemaFingerprint(schema)
  )
    throw driftFailure(schema, live);
}

async function runPendingAuthorizationChange(
  change: LoadedAuthorizationChange,
  schema: string,
  options: RunAuthorizationMigrationsOptions,
): Promise<string> {
  const next = applyAuthorizationDefinitionPatches(schema, change);
  const marker = `authz_started_${change.id}_${change.checksum}_${authorizationSchemaFingerprint(schema)}_${authorizationSchemaFingerprint(next)}`;
  await options.store.writeRelationships([markerFact(marker)]);
  await applyChange(change, schema, next, marker, false, options);
  return next;
}

async function applyChange(
  change: LoadedAuthorizationChange,
  previous: string,
  next: string,
  startedMarker: string,
  schemaWritten: boolean,
  options: RunAuthorizationMigrationsOptions,
): Promise<void> {
  const { store, log } = options;
  if (!schemaWritten) {
    const classification = classifySchemaDiff(previous, next);
    if (classification.kind === "destructive") {
      const snapshot = options.snapshotDatastore
        ? await options.snapshotDatastore()
        : "skipped";
      log.info(
        {
          event: "authorization.migrate.snapshot",
          entry: change.id,
          snapshot,
          removals: classification.removals,
        },
        "destructive change — datastore snapshot before applying",
      );
    }
    if (change.beforeSchemaWrite !== undefined)
      await change.beforeSchemaWrite(store);
    try {
      await store.writeSchema(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocker = parseWriteSchemaBlocker(message);
      if (blocker === undefined) throw error;
      const blocked =
        blocker.kind === "removed-type"
          ? `definition ${blocker.resourceType}`
          : `${blocker.resourceType}#${blocker.relation}`;
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_RELATIONSHIPS",
        `authorization change ${change.id} cannot retire ${blocked}: its relationship step must preserve access and clear the blocking relationships before the schema write`,
      );
    }
  }
  if (change.afterSchemaWrite !== undefined)
    await change.afterSchemaWrite(store);
  await store.writeRelationships([markerFact(appliedMarker(change))]);
  await store.deleteExactRelationship(markerFact(startedMarker));
  log.info(
    { event: "authorization.change.applied", entry: change.id },
    "authorization definition change applied",
  );
}

function markerFact(marker: string): RelationshipWrite {
  return {
    resource: { type: "authz/migration_journal", id: "journal" },
    relation: "applied",
    subject: { type: "authz/migration_version", id: marker },
  };
}

function driftFailure(
  expected: string,
  observed: string,
): AuthorizationChangeError {
  const before = authorizationSchemaDefinitions(expected);
  const after = authorizationSchemaDefinitions(observed);
  const definition = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .find((name) => before.get(name) !== after.get(name));
  const previous = (
    definition === undefined ? "" : (before.get(definition) ?? "<absent>")
  ).split(" ");
  const next = (
    definition === undefined ? "" : (after.get(definition) ?? "<absent>")
  ).split(" ");
  let position = 0;
  while (
    position < Math.max(previous.length, next.length) &&
    previous[position] === next[position]
  )
    position += 1;
  const start = Math.max(0, position - 6);
  const context =
    definition === undefined
      ? "recorded in-progress fingerprints differ"
      : `definition ${definition} at token ${String(position)}; expected ${previous.slice(start, position + 12).join(" ")}; observed ${next.slice(start, position + 12).join(" ")}`;
  return new AuthorizationChangeError(
    "AUTHZ_CHANGE_DRIFT",
    `authorization schema drift differs from recorded migration state (${context}); reconcile the live schema before resuming`,
  );
}
