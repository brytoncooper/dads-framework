import type { RelationshipWrite } from "./authorization.js";

/** Bounded maintenance read, separate from application permission lookups. */
export type RelationshipPageRequest = {
  readonly resourceType: string;
  readonly cursor?: string;
};

/** Opaque cursors resume the same filtered read; null means the scan is complete. */
export type RelationshipPage = {
  readonly relationships: readonly RelationshipWrite[];
  readonly nextCursor: string | null;
};
