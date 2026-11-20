import type { AccessModel } from "./access-model.js";

/** One record allowed `requiresVisible` and `lookupResources` until `until`. */
export type VisibleRecordException = {
  readonly resourceType: string;
  /** The last day the exception holds, `YYYY-MM-DD` (UTC). */
  readonly until: string;
  /** What removes it, naming the change (a pull request) that adopts the record. */
  readonly removedBy: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Allow `resourceType`'s lists to keep asking SpiceDB for every visible id
 * until `until`. Throws on a malformed date or a missing reason.
 */
export function allowVisibleOnRecordUntil(
  until: string,
  exception: {
    readonly resourceType: string;
    readonly removedBy: string;
  },
): VisibleRecordException {
  const timestamp = Date.parse(until);
  if (
    !DATE_ONLY.test(until) ||
    Number.isNaN(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== until
  ) {
    throw new Error(
      `visible-record exception for ${exception.resourceType} needs a YYYY-MM-DD date, got ${until}`,
    );
  }
  if (exception.removedBy.trim().length === 0) {
    throw new Error(
      `visible-record exception for ${exception.resourceType} must name what removes it`,
    );
  }
  return { ...exception, until };
}

/** The active exception for a record in this model, if any. */
export function visibleRecordException(
  model: AccessModel,
  resourceType: string,
  today = new Date(),
): VisibleRecordException | undefined {
  const todayDate = today.toISOString().slice(0, 10);
  return model.visibleRecordExceptions.find(
    (entry) => entry.resourceType === resourceType && entry.until >= todayDate,
  );
}

export function expiredVisibleRecordExceptions(
  model: AccessModel,
  today: Date,
): readonly VisibleRecordException[] {
  const todayDate = today.toISOString().slice(0, 10);
  return model.visibleRecordExceptions.filter(
    (entry) => entry.until < todayDate,
  );
}
