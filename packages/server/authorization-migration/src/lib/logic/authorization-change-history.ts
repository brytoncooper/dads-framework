import {
  AuthorizationChangeError,
  composeAuthorizationChanges,
  orderAuthorizationChanges,
} from "../../definition-changes.mjs";
import type { LoadedAuthorizationMigration } from "../journal/journal-entry.js";
import type { LoadedAuthorizationChange } from "../journal/load-authorization-changes.js";

const BARRIER_PREFIX = "authz_graph_v1_";
const APPLIED_PREFIX = "authz_applied_";
const STARTED_PATTERN =
  /^authz_started_(.+)_([a-f0-9]{64})_([a-f0-9]{64})_([a-f0-9]{64})$/;

export type StartedChange = {
  readonly id: string;
  readonly marker: string;
  readonly checksum: string;
  readonly beforeHash: string;
  readonly afterHash: string;
};

export type PreparedAuthorizationChanges = {
  readonly ordered: readonly LoadedAuthorizationChange[];
  readonly legacyApplied: readonly string[];
  readonly applied: ReadonlySet<string>;
  readonly barrier: boolean;
  readonly barrierMarker: string;
  readonly started: StartedChange | undefined;
  readonly baseline: string;
};

type AuthorizationChangeHistory = {
  readonly legacyApplied: string[];
  readonly applied: Set<string>;
  readonly started: StartedChange[];
};

type HistoryMarker =
  | { readonly kind: "legacy"; readonly id: string }
  | { readonly kind: "barrier" }
  | { readonly kind: "applied"; readonly id: string }
  | { readonly kind: "started"; readonly entry: StartedChange };

type KnownAuthorizationHistory = {
  readonly legacyIds: ReadonlySet<string>;
  readonly changes: ReadonlyMap<string, LoadedAuthorizationChange>;
  readonly finishedMarkers: ReadonlyMap<string, string>;
  readonly barrierMarker: string;
};

/** Validate all known history and patches before the first relationship write. */
export function prepareAuthorizationChanges(
  journal: readonly LoadedAuthorizationMigration[],
  changes: readonly LoadedAuthorizationChange[],
  markers: readonly string[],
  legacyChecksum: string,
): PreparedAuthorizationChanges {
  const latest = journal.at(-1);
  if (latest === undefined)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization changes require a legacy journal baseline",
    );
  const ordered = orderAuthorizationChanges(changes, latest.id);
  const barrierMarker = `${BARRIER_PREFIX}${legacyChecksum}`;
  const history = readAuthorizationChangeHistory(
    journal,
    ordered,
    markers,
    barrierMarker,
  );
  const barrier = markers.includes(barrierMarker);
  assertAuthorizationChangeHistory(
    history,
    ordered,
    latest.id,
    journal.length,
    barrier,
  );
  composeAuthorizationChanges(latest.schema, ordered);
  return {
    ordered,
    legacyApplied: history.legacyApplied.sort(),
    applied: history.applied,
    barrier,
    barrierMarker,
    started: history.started[0],
    baseline: latest.schema,
  };
}

function readAuthorizationChangeHistory(
  journal: readonly LoadedAuthorizationMigration[],
  ordered: readonly LoadedAuthorizationChange[],
  markers: readonly string[],
  barrierMarker: string,
): AuthorizationChangeHistory {
  const known: KnownAuthorizationHistory = {
    legacyIds: new Set(journal.map((entry) => entry.id)),
    changes: new Map(ordered.map((change) => [change.id, change])),
    finishedMarkers: new Map(
      ordered.map((change) => [authorizationAppliedMarker(change), change.id]),
    ),
    barrierMarker,
  };
  const history: AuthorizationChangeHistory = {
    legacyApplied: [],
    applied: new Set(),
    started: [],
  };
  for (const marker of new Set(markers)) {
    const record = classifyHistoryMarker(marker, known);
    if (record.kind === "legacy") history.legacyApplied.push(record.id);
    else if (record.kind === "applied") history.applied.add(record.id);
    else if (record.kind === "started") history.started.push(record.entry);
  }
  return history;
}

function classifyHistoryMarker(
  marker: string,
  known: KnownAuthorizationHistory,
): HistoryMarker {
  if (known.legacyIds.has(marker)) return { kind: "legacy", id: marker };
  if (marker === known.barrierMarker) return { kind: "barrier" };
  if (marker.startsWith(BARRIER_PREFIX))
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_CHECKSUM",
      "authorization legacy journal checksum differs from the sealed graph baseline",
    );
  const finished = known.finishedMarkers.get(marker);
  if (finished !== undefined) return { kind: "applied", id: finished };
  const started = readStartedChange(marker, known.changes);
  if (started !== undefined) return { kind: "started", entry: started };
  const edited = [...known.changes.values()].find((change) =>
    marker.startsWith(`${APPLIED_PREFIX}${change.id}_`),
  );
  if (edited !== undefined) throw checksumFailure(edited.id);
  throw new AuthorizationChangeError(
    "AUTHZ_CHANGE_HISTORY",
    `authorization store has applied entries this build does not contain: ${marker}; the store is ahead of this build`,
  );
}

function readStartedChange(
  marker: string,
  changes: ReadonlyMap<string, LoadedAuthorizationChange>,
): StartedChange | undefined {
  const match = STARTED_PATTERN.exec(marker);
  if (match === null) return undefined;
  const [, id, checksum, beforeHash, afterHash] = match;
  if (
    id === undefined ||
    checksum === undefined ||
    beforeHash === undefined ||
    afterHash === undefined
  )
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization store has a malformed in-progress marker",
    );
  const active = changes.get(id);
  if (active === undefined)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      `authorization store has a started change this build does not contain: ${id}`,
    );
  return { id, marker, checksum, beforeHash, afterHash };
}

function assertAuthorizationChangeHistory(
  history: AuthorizationChangeHistory,
  ordered: readonly LoadedAuthorizationChange[],
  legacyHead: string,
  legacyCount: number,
  barrier: boolean,
): void {
  if ((history.applied.size > 0 || history.started.length > 0) && !barrier)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization graph markers are missing their protocol barrier",
    );
  if (barrier && history.legacyApplied.length !== legacyCount)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization graph state requires the complete immutable legacy journal prefix",
    );
  if (history.started.length > 1)
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      "authorization store has multiple in-progress changes; only one migrator may write at a time",
    );
  for (const change of ordered.filter((candidate) =>
    history.applied.has(candidate.id),
  )) {
    assertAppliedChangeHistory(change, history, legacyHead);
  }
}

function assertAppliedChangeHistory(
  change: LoadedAuthorizationChange,
  history: AuthorizationChangeHistory,
  legacyHead: string,
): void {
  const started = history.started.find((entry) => entry.id === change.id);
  if (started !== undefined && started.checksum !== change.checksum)
    throw checksumFailure(change.id);
  if (
    !change.dependsOn.every(
      (dependency) =>
        dependency === legacyHead || history.applied.has(dependency),
    )
  )
    throw new AuthorizationChangeError(
      "AUTHZ_CHANGE_HISTORY",
      `applied authorization change ${change.id} is missing an applied prerequisite`,
    );
}

export function authorizationAppliedMarker(
  change: LoadedAuthorizationChange,
): string {
  return `${APPLIED_PREFIX}${change.id}_${change.checksum}`;
}

function checksumFailure(id: string): AuthorizationChangeError {
  return new AuthorizationChangeError(
    "AUTHZ_CHANGE_CHECKSUM",
    `authorization change ${id} checksum differs from applied immutable content`,
  );
}
