import {
  withProtectedPgTransaction,
  type PostgresAuthorization,
} from "@dads-framework/postgres-access";
import type { Pool } from "pg";

import { document, user } from "../access/model.js";

export type DocumentRow = {
  readonly id: string;
  readonly title: string;
};

/** Paginated list: compiles permissions directly into your SQL WHERE clause. */
export async function listVisibleDocuments(
  pool: Pool,
  authorization: PostgresAuthorization,
  userId: string,
): Promise<DocumentRow[]> {
  const filter = await authorization.resolveFilter({
    subject: user(userId),
    resourceType: document.wireName,
    permission: document.permissions.view.permissionName,
    idColumn: "doc.id",
    scopeColumns: "auto",
  });

  const result = await pool.query<DocumentRow>(
    `SELECT doc.id, doc.title
       FROM documents doc
      WHERE ${filter.sql}
      ORDER BY doc.updated_at DESC, doc.id DESC
      LIMIT 50`,
    [...filter.values],
  );
  return result.rows;
}

/** Protected write: re-checks permission and updates the row in one transaction. */
export async function renameDocument(
  pool: Pool,
  authorization: PostgresAuthorization,
  input: { userId: string; documentId: string; title: string },
): Promise<boolean> {
  return withProtectedPgTransaction(
    { pool, authorization, retries: 2 },
    async ({ client, authorization: scopedAuthorization }) => {
      const allowed = await scopedAuthorization.check({
        subject: user(input.userId),
        permission: document.permissions.edit.permissionName,
        resource: document(input.documentId),
      });
      if (!allowed) return false;

      await client.query("UPDATE documents SET title = $1 WHERE id = $2", [
        input.title,
        input.documentId,
      ]);
      return true;
    },
  );
}
