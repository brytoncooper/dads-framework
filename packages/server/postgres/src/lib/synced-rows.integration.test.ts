import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  startTestPostgres,
  type TestPostgres,
} from "../testing/start-test-postgres.js";
import {
  applySyncedRows,
  type SyncedRowChange,
  type SyncedRowWriter,
} from "./synced-rows.js";

/**
 * What: a synced row whose unique key a stale row holds, and whose parent is
 * not stored yet, is held `missing_parent` with the stale row untouched, and
 * lands once its parent arrives.
 * Why against a real server: Postgres checks the unique index before the
 * foreign key, so only a real insert shows the second refusal coming after
 * the stale row was moved aside. The tables are temporary, on one
 * connection, so no other test sees them.
 */
type Table = "synced_rows_kit_child";

const childSchema = z.object({ parentId: z.string(), key: z.string() });

/** A child row keyed by `key`; a stale holder of the key moves aside. */
const WRITER: SyncedRowWriter<Table> = {
  async upsert(tx, change) {
    const child = childSchema.parse(change.data);
    await tx.execute(
      sql`INSERT INTO synced_rows_kit_child (id, parent_id, key) VALUES (${change.id}, ${child.parentId}, ${child.key})
          ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, key = excluded.key`,
    );
    return true;
  },
  async delete(tx, _table, id) {
    const deleted = await tx.execute(
      sql`DELETE FROM synced_rows_kit_child WHERE id = ${id}`,
    );
    return (deleted.rowCount ?? 0) > 0;
  },
  async moveKeyHoldersAside(tx, change) {
    const child = childSchema.parse(change.data);
    const moved = await tx.execute(
      sql`UPDATE synced_rows_kit_child SET key = key || ' (' || id || ')' WHERE key = ${child.key} AND id <> ${change.id}`,
    );
    return moved.rowCount ?? 0;
  },
};

function childChange(
  id: string,
  parentId: string,
  key: string,
): SyncedRowChange<Table> {
  return {
    table: "synced_rows_kit_child",
    op: "upsert",
    id,
    rowVersion: 1,
    data: { parentId, key },
    takeNext: false,
  };
}

describe("applySyncedRows (integration)", () => {
  let postgres: TestPostgres;
  let client: PoolClient;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    client = await postgres.pool.connect();
    await client.query(`
      CREATE TEMP TABLE synced_rows_kit_parent (id text PRIMARY KEY);
      CREATE TEMP TABLE synced_rows_kit_child (
        id text PRIMARY KEY,
        parent_id text NOT NULL REFERENCES synced_rows_kit_parent (id),
        key text NOT NULL UNIQUE
      );
      INSERT INTO synced_rows_kit_parent (id) VALUES ('p1');
      INSERT INTO synced_rows_kit_child (id, parent_id, key) VALUES ('stale', 'p1', 'k');
    `);
  }, 180_000);

  afterAll(async () => {
    client.release(true);
    await postgres.stop();
  });

  /** One page, in one transaction on the connection that holds the tables. */
  function applyPage(changes: readonly SyncedRowChange<Table>[]) {
    return drizzle(client).transaction((tx) =>
      applySyncedRows(tx, changes, ["synced_rows_kit_child"], WRITER),
    );
  }

  async function keys(): Promise<Record<string, string>> {
    const rows = await client.query<{ id: string; key: string }>(
      "SELECT id, key FROM synced_rows_kit_child ORDER BY id",
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row.key]));
  }

  it("holds a row missing_parent when its key is taken and its parent is not here, leaving the stale holder as it was, and writes it once the parent arrives", async () => {
    const held = await applyPage([childChange("fresh", "p2", "k")]);

    expect(held).toEqual([
      {
        table: "synced_rows_kit_child",
        id: "fresh",
        outcome: "missing_parent",
        code: null,
      },
    ]);
    expect(await keys()).toEqual({ stale: "k" });

    await client.query("INSERT INTO synced_rows_kit_parent (id) VALUES ('p2')");
    const written = await applyPage([childChange("fresh", "p2", "k")]);

    expect(written).toEqual([
      {
        table: "synced_rows_kit_child",
        id: "fresh",
        outcome: "applied",
        code: null,
      },
    ]);
    expect(await keys()).toEqual({ fresh: "k", stale: "k (stale)" });
  });
});
