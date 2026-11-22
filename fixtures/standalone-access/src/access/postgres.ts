import {
  columnRelationIndexSql,
  PostgresAuthorization,
  preparePostgresChecks,
  type ColumnRelationBinding,
} from "@dads-framework/postgres-access";
import type { Pool } from "pg";

import { accessModel, document } from "./model.js";

/** Read existing foreign keys directly from `documents` (zero dual-writes). */
export const columnRelations: readonly ColumnRelationBinding[] = [
  {
    role: document.roles.org,
    table: "documents",
    idColumn: "id",
    targetIdColumn: "org_id",
  },
  {
    role: document.roles.owner,
    table: "documents",
    idColumn: "id",
    targetIdColumn: "owner_id",
  },
];

/** Recommended `(target_id, id)` indexes to run in your SQL migration. */
export const recommendedIndexSql = columnRelationIndexSql(columnRelations);

export function createAuthorization(pool: Pool): PostgresAuthorization {
  return new PostgresAuthorization({
    model: accessModel,
    namespace: "app",
    executor: preparePostgresChecks(pool),
    columnRelations,
  });
}

/** Fail fast at boot if any column-backed table or index is missing. */
export async function verifyAuthorizationAtBoot(
  authorization: PostgresAuthorization,
): Promise<void> {
  const checks = await authorization.verifyColumnRelations();
  const missing = checks.filter((entry) => !entry.hasRecommendedIndex);
  if (missing.length > 0) {
    throw new Error(
      `Missing indexes for columnRelations: ${missing.map((entry) => `${entry.table}.${entry.targetIdColumn}`).join(", ")}`,
    );
  }
}
