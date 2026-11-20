import { getTableColumns } from "drizzle-orm";
import { MigrationBuilder } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";

import { attachAuditTrigger } from "../attach-audit-trigger.js";
import { requestLog } from "../generated-tables/request-log.tables.js";
import { up as installAuditSchemaV1 } from "../migrations/20260910233455_audit.migration.js";

describe("fresh product audit foundation", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres({ attributed: false });
    const builder = new MigrationBuilder(
      {
        query: () =>
          Promise.reject(new Error("Schema assembly performs no I/O")),
        select: () => Promise.resolve([]),
      },
      undefined,
      false,
      { info: () => undefined, warn: () => undefined, error: () => undefined },
    );
    installAuditSchemaV1(builder);
    builder.createTable("approval_proof", {
      id: { type: "text", primaryKey: true },
      value: { type: "text" },
    });
    attachAuditTrigger(builder, "approval_proof", { keyColumns: ["id"] });
    await postgres.pool.query(builder.getSql());
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("refuses writes without attribution", async () => {
    await expect(
      postgres.pool.query(
        "INSERT INTO approval_proof(id) VALUES ('unattributed')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("records the actor, reason, and row and refuses audit edits", async () => {
    const client = await postgres.pool.connect();
    try {
      await client.query("SELECT set_config('dads.audit_actor', $1, false)", [
        JSON.stringify({
          kind: "user",
          id: "admin-1",
          requestId: "approval-1",
          reason: "Accepted damaged shipment",
        }),
      ]);
      await client.query(
        "INSERT INTO approval_proof(id, value) VALUES ('approved', 'yes')",
      );
    } finally {
      await client.query("SELECT set_config('dads.audit_actor', '', false)");
      client.release();
    }

    const result = await postgres.pool.query(
      "SELECT actor_kind, actor_id, reason, row_after FROM audit_log WHERE table_name = 'approval_proof'",
    );
    expect(result.rows).toEqual([
      {
        actor_kind: "user",
        actor_id: "admin-1",
        reason: "Accepted damaged shipment",
        row_after: { id: "approved", value: "yes" },
      },
    ]);
    await expect(
      postgres.pool.query("UPDATE audit_log SET actor_id = 'other'"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("installs the current request and client diagnostic columns", async () => {
    await expect(
      postgres.pool.query(
        "SELECT trace_id, exception_fingerprint, db_query_count FROM request_log",
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      postgres.pool.query("SELECT fingerprint FROM client_diagnostic_events"),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      postgres.pool.query("SELECT fingerprint FROM known_fault_fingerprints"),
    ).resolves.toMatchObject({ rows: [] });
  });

  // The shared request-log sink inserts every column of the kit's table
  // module, so a fresh product missing one would lose every request row.
  it("installs every request_log column the shared sink writes", async () => {
    const installed = await postgres.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'request_log'",
    );
    const columns = new Set(installed.rows.map((row) => row.column_name));
    const written = Object.values(getTableColumns(requestLog)).map(
      (column) => column.name,
    );
    expect(written.filter((name) => !columns.has(name))).toEqual([]);
  });
});
