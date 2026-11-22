import {
  PostgresAuthorization,
  preparePostgresChecks,
  type ColumnRelationBinding,
} from "@dads-framework/postgres-access";
import type { Pool } from "pg";

import {
  document,
  documentsAccessModel,
} from "../domains/documents/access/index.js";

/**
 * assembly/ is the ONLY layer allowed to import `pg` and
 * `@dads-framework/postgres-access`. Domains remain database-free.
 */
export const documentColumnRelations: readonly ColumnRelationBinding[] = [
  {
    role: document.roles.organization,
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

export function assembleAuthorization(pool: Pool): PostgresAuthorization {
  return new PostgresAuthorization({
    model: documentsAccessModel,
    namespace: "customer",
    executor: preparePostgresChecks(pool),
    columnRelations: documentColumnRelations,
  });
}
