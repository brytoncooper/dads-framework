import { conflict, notFound, validation } from "@dads-framework/errors";

import type {
  FeatureFlagBatchId,
  FeatureFlagDefinition,
  FeatureFlagHistoryEntry,
  FeatureFlagState,
  UpdateFeatureFlagInput,
  UpdateFeatureFlagsRequest,
} from "../../contract/index.js";
import type { FeatureFlagBatchWrite } from "../ports/feature-flag-store.js";
import {
  defaultFeatureFlagState,
  transitionFeatureFlagState,
} from "../logic/transition-feature-flag-state.js";

/** The slugs a batch changes, refused before any tenant lookup when one is repeated or unknown. */
export function requestedFeatureFlagSlugs(input: {
  readonly definitions: readonly FeatureFlagDefinition[];
  readonly request: UpdateFeatureFlagsRequest;
}): readonly string[] {
  const slugs = input.request.changes.map((change) => change.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw validation(
      "FEATURE_FLAG_CHANGE_DUPLICATED",
      "A flag may appear only once in a management batch",
    );
  }
  const known = new Set(input.definitions.map((definition) => definition.slug));
  if (slugs.some((slug) => !known.has(slug))) {
    throw notFound("FEATURE_FLAG_NOT_FOUND", "Feature flag was not found");
  }
  return slugs;
}

/** Every tenant id the batch selects, once each. */
export function selectedTenantIds(
  request: UpdateFeatureFlagsRequest,
): readonly string[] {
  return [
    ...new Set(
      request.changes.flatMap((change) =>
        change.mode === "SELECTED_TENANTS" ? change.tenantIds : [],
      ),
    ),
  ];
}

export function revisionChanged(): Error {
  return conflict(
    "FEATURE_FLAG_STATE_CHANGED",
    "Feature flag state changed before this batch could be applied",
  );
}

type PlanInput = {
  readonly actorId: string;
  readonly batchId: FeatureFlagBatchId;
  readonly currentStates: readonly FeatureFlagState[];
  readonly now: Date;
  readonly request: UpdateFeatureFlagsRequest;
  readonly tenantNames: ReadonlyMap<string, string>;
};

/** The complete atomic write, planned once definitions and tenants are known. */
export function planFeatureFlagBatch(input: PlanInput): FeatureFlagBatchWrite {
  const currentBySlug = new Map(
    input.currentStates.map((state) => [state.slug, state]),
  );
  const planned = input.request.changes.map((change) =>
    planChange(
      input,
      change,
      currentBySlug.get(change.slug) ?? defaultFeatureFlagState(change.slug),
    ),
  );
  return {
    expectedRevisions: new Map(
      input.request.changes.map((change) => [
        change.slug,
        change.expectedRevision,
      ]),
    ),
    nextStates: planned.map((entry) => entry.nextState),
    history: planned,
  };
}

function planChange(
  input: PlanInput,
  change: UpdateFeatureFlagInput,
  current: FeatureFlagState,
): FeatureFlagHistoryEntry {
  if (current.revision !== change.expectedRevision) throw revisionChanged();
  const next = transitionFeatureFlagState({
    current,
    change,
    now: input.now,
    actorId: input.actorId,
    tenantNames: input.tenantNames,
  });
  return {
    batchId: input.batchId,
    slug: next.slug,
    revision: next.revision,
    previousState: current,
    nextState: next,
    ...(change.note === undefined ? {} : { note: change.note }),
    changedAt: input.now.toISOString(),
    changedBy: input.actorId,
  };
}
