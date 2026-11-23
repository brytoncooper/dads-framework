import type { ImpersonationStoredGrant, ImpersonationOptions } from "../../impersonation/index.js";
import type { PostgresPool } from "kysely";

function storedText(row: object, column: string): string {
  const value: unknown = Reflect.get(row, column);
  if (typeof value !== "string") throw new Error("Invalid stored impersonation grant");
  return value;
}

function parseGrant(row: unknown): ImpersonationStoredGrant | null {
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null) {
    throw new Error("Invalid stored impersonation grant");
  }
  const expiresAtMs = Number(storedText(row, "expires_at_ms"));
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error("Invalid impersonation grant expiry");
  return {
    id: storedText(row, "id"),
    tenantId: storedText(row, "tenant_id"),
    effectiveAccountId: storedText(row, "effective_account_id"),
    staffAccountId: storedText(row, "staff_account_id"),
    staffSessionId: storedText(row, "staff_session_id"),
    expiresAtMs,
  };
}

export function createPostgresImpersonationStore(
  pool: PostgresPool,
): Pick<ImpersonationOptions, "store" | "writeAudit"> {
  async function query(sql: string, parameters: readonly unknown[]) {
    const client = await pool.connect();
    try {
      return await client.query(sql, parameters);
    } finally {
      client.release();
    }
  }

  return {
    store: {
      async insert(grant, event) {
        await query(
          `WITH created AS (
            INSERT INTO identity_staff_impersonation_grants
              (id, tenant_id, staff_account_id, effective_account_id, staff_session_id, expires_at_ms)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
          )
          INSERT INTO identity_staff_impersonation_audit (event)
          SELECT $7::jsonb FROM created`,
          [
            grant.id,
            grant.tenantId,
            grant.staffAccountId,
            grant.effectiveAccountId,
            grant.staffSessionId,
            grant.expiresAtMs,
            JSON.stringify(event),
          ],
        );
      },
      async read(id) {
        const result = await query(
          `SELECT id, tenant_id, staff_account_id, effective_account_id, staff_session_id, expires_at_ms::text
           FROM identity_staff_impersonation_grants WHERE id = $1`,
          [id],
        );
        return parseGrant(result.rows[0]);
      },
      async remove(id, event) {
        const result = await query(
          `WITH deleted AS (
            DELETE FROM identity_staff_impersonation_grants WHERE id = $1
            RETURNING id
          )
          INSERT INTO identity_staff_impersonation_audit (event)
          SELECT $2::jsonb FROM deleted`,
          [id, JSON.stringify(event)],
        );
        return result.rowCount === 1;
      },
    },
    async writeAudit(event) {
      await query("INSERT INTO identity_staff_impersonation_audit (event) VALUES ($1::jsonb)", [JSON.stringify(event)]);
    },
  };
}
