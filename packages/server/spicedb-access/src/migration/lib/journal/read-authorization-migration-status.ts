import {
  AuthorizationChangeError,
  orderAuthorizationChanges,
} from "../../definition-changes.mjs";
import { prepareAuthorizationChanges } from "../run-authorization-changes.js";
import {
  type AuthorizationJournalMarkerReader,
  readAppliedAuthorizationMigrationIds,
} from "../run-authorization-migrations.js";
import {
  type AuthorizationChangeFile,
  authorizationLegacyJournalChecksum,
  loadAuthorizationChangeFiles,
} from "./authorization-change-files.js";
import {
  listShippedAuthorizationMigrationIds,
  loadJournal,
} from "./load-journal.js";

const FINISHED =
  /^authz_applied_(\d{14}_[a-f0-9]{8}_[a-z0-9]+(?:_[a-z0-9]+)*)_([a-f0-9]{64})$/;

export async function readAuthorizationMigrationStatus(input: {
  readonly journalFolder: string;
  readonly changesFolder: string;
  readonly store: AuthorizationJournalMarkerReader;
}): Promise<{
  readonly shippedIds: readonly string[];
  readonly appliedIds: readonly string[];
}> {
  const [legacyIds, rawMarkers] = await Promise.all([
    listShippedAuthorizationMigrationIds(input.journalFolder),
    readAppliedAuthorizationMigrationIds(input.store),
  ]);
  const changes = await changesForStatus(input.changesFolder);
  const latest = legacyIds.at(-1);
  const ordered =
    changes.length === 0
      ? []
      : orderAuthorizationChanges(changes, latest ?? "");
  const markers = logicalAuthorizationMarkers(
    rawMarkers,
    new Set(ordered.map((change) => change.id)),
  );
  await validateKnownAuthorizationStatus(
    input.journalFolder,
    legacyIds,
    changes,
    rawMarkers,
    markers.unknownAppliedChange,
  );
  return {
    shippedIds: [...legacyIds, ...ordered.map((change) => change.id)],
    appliedIds: markers.logicalApplied.sort(),
  };
}

function logicalAuthorizationMarkers(
  rawMarkers: readonly string[],
  knownIds: ReadonlySet<string>,
): { logicalApplied: string[]; unknownAppliedChange: boolean } {
  const logicalApplied: string[] = [];
  let unknownAppliedChange = false;
  for (const marker of rawMarkers) {
    if (
      marker.startsWith("authz_graph_v1_") ||
      marker.startsWith("authz_started_")
    )
      continue;
    const id = FINISHED.exec(marker)?.[1];
    if (id !== undefined) {
      logicalApplied.push(id);
      if (!knownIds.has(id)) unknownAppliedChange = true;
    } else if (marker.startsWith("authz_")) {
      throw new AuthorizationChangeError(
        "AUTHZ_CHANGE_HISTORY",
        "authorization migration status contains an unsupported protocol marker",
      );
    } else logicalApplied.push(marker);
  }
  return { logicalApplied, unknownAppliedChange };
}

async function validateKnownAuthorizationStatus(
  journalFolder: string,
  legacyIds: readonly string[],
  changes: readonly AuthorizationChangeFile[],
  rawMarkers: readonly string[],
  unknownAppliedChange: boolean,
): Promise<void> {
  if (
    unknownAppliedChange ||
    (changes.length === 0 &&
      !rawMarkers.some((marker) => marker.startsWith("authz_")))
  )
    return;
  if (changes.length === 0)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization store uses graph migrations that are missing from this build",
    );
  const journal = await loadJournal(
    legacyIds.map((id) => ({ id })),
    journalFolder,
  );
  prepareAuthorizationChanges(
    journal,
    changes,
    rawMarkers,
    await authorizationLegacyJournalChecksum(journalFolder),
  );
}

async function changesForStatus(folder: string) {
  try {
    return await loadAuthorizationChangeFiles(folder);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      error.path === folder
    )
      return [];
    throw error;
  }
}
