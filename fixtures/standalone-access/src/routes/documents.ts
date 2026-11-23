import {
  withProtectedPgTransaction,
  withReadSnapshot,
  type PostgresAuthorization,
} from "@dads-framework/postgres-access";
import type { Pool } from "pg";

import { document, user } from "../access/model.js";

export type DocumentRow = {
  readonly id: string;
  readonly title: string;
};

function toDocumentRow(row: Readonly<Record<string, unknown>>): DocumentRow {
  const { id, title } = row;
  if (typeof id !== "string" || typeof title !== "string") {
    throw new Error("Unexpected documents row shape.");
  }
  return { id, title };
}

/** Paginated list: resolves permissions and reads rows in one read-only snapshot. */
export async function listVisibleDocuments(
  pool: Pool,
  authorization: PostgresAuthorization,
  userId: string,
): Promise<readonly DocumentRow[]> {
  return withReadSnapshot({ pool, authorization }, async ({ client, authorization: scopedAuthorization }) => {
    const filter = await scopedAuthorization.resolveFilter({
      subject: user(userId),
      permission: document.permissions.view,
      idColumn: "doc.id",
      scopeColumns: "auto",
    });

    const result = await client.query(
      `SELECT doc.id, doc.title
           FROM documents doc
          WHERE ${filter.sql}
          ORDER BY doc.updated_at DESC, doc.id DESC
          LIMIT 50`,
      [...filter.values],
    );
    return result.rows.map(toDocumentRow);
  });
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
      const allowed = await scopedAuthorization.can(user(input.userId), document.permissions.edit, input.documentId);
      if (!allowed) return false;

      await client.query("UPDATE documents SET title = $1 WHERE id = $2", [input.title, input.documentId]);
      return true;
    },
  );
}
