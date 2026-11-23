import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createPrivateDatabase,
  startUnmigratedTestPostgres,
  type TestPostgres,
} from "../../testing/index.js";

import {
  readMigrationCompatibilityState,
  UnsupportedMigrationCompatibilityReplicationStateError,
} from "./read-migration-compatibility-state.js";

let server: TestPostgres;

describe("migration compatibility state", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startUnmigratedTestPostgres();
    return () => server.stop();
  }, 60_000);

  it("compares independent added columns by logical name", async () => {
    await withDatabases(async (left, right) => {
      const table = "CREATE TABLE retained (id integer PRIMARY KEY)";
      await left.query(table);
      await right.query(table);
      await left.query(
        "ALTER TABLE retained ADD COLUMN alpha text DEFAULT 'kept'",
      );
      await left.query(
        "ALTER TABLE retained ADD COLUMN beta integer DEFAULT 7",
      );
      await right.query(
        "ALTER TABLE retained ADD COLUMN beta integer DEFAULT 7",
      );
      await right.query(
        "ALTER TABLE retained ADD COLUMN alpha text DEFAULT 'kept'",
      );
      await left.query("INSERT INTO retained (id) VALUES (1)");
      await right.query("INSERT INTO retained (id) VALUES (1)");

      expect(await readMigrationCompatibilityState(left)).toEqual(
        await readMigrationCompatibilityState(right),
      );
    });
  });

  it.each([
    "UPDATE retained SET amount = 12.34",
    "UPDATE retained SET happened_at = '2026-01-01T00:00:00.000001Z'",
    "UPDATE retained SET id = '00000000-0000-7000-8000-000000000002'",
  ])("detects retained business values changed by %s", async (change) => {
    await withDatabases(async (left, right) => {
      const table = `
        CREATE TABLE retained (id uuid PRIMARY KEY, amount numeric, happened_at timestamptz);
        INSERT INTO retained VALUES ('00000000-0000-7000-8000-000000000001', 12.33, '2026-01-01T00:00:00Z');
      `;
      await left.query(table);
      await right.query(table);
      await right.query(change);

      const before = await readMigrationCompatibilityState(left);
      const after = await readMigrationCompatibilityState(right);
      expect(before.schema).toBe(after.schema);
      expect(before.data).not.toEqual(after.data);
      expect(before.data['"public"."retained"']?.rows).toBe(1);
    });
  });

  it.each([
    "CREATE OR REPLACE FUNCTION public.touch_retained() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$",
    "ALTER TABLE retained DISABLE TRIGGER retained_touch",
    "ALTER POLICY retained_visible ON retained USING (id > 1)",
  ])("detects a function, trigger, or policy change: %s", async (change) => {
    await withDatabases(async (left, right) => {
      const schema = `
        CREATE TABLE retained (id integer PRIMARY KEY);
        CREATE FUNCTION public.touch_retained() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER retained_touch BEFORE INSERT ON retained FOR EACH ROW EXECUTE FUNCTION public.touch_retained();
        ALTER TABLE retained ENABLE ROW LEVEL SECURITY;
        CREATE POLICY retained_visible ON retained USING (id > 0);
      `;
      await left.query(schema);
      await right.query(schema);
      await right.query(change);

      const before = await readMigrationCompatibilityState(left);
      const after = await readMigrationCompatibilityState(right);
      expect(before.schema).not.toBe(after.schema);
      expect(before.data).toEqual(after.data);
    });
  });

  it("ignores only audit row noise and keeps the audit schema in the evidence", async () => {
    await withDatabases(async (left, right) => {
      const schema =
        "CREATE TABLE audit_log (position bigint, recorded_at timestamptz)";
      await left.query(schema);
      await right.query(schema);
      await left.query(
        "INSERT INTO audit_log VALUES (1, '2026-01-01T00:00:00Z')",
      );
      await right.query(
        "INSERT INTO audit_log VALUES (99, '2026-03-01T00:00:00Z')",
      );

      const before = await readMigrationCompatibilityState(left);
      expect(before).toEqual(await readMigrationCompatibilityState(right));
      expect(before.data).not.toHaveProperty('"public"."audit_log"');

      await right.query("ALTER TABLE audit_log ADD COLUMN actor_id uuid");
      expect(before.schema).not.toBe(
        (await readMigrationCompatibilityState(right)).schema,
      );
    });
  });

  it("detects sequence position divergence without advancing either sequence", async () => {
    await withDatabases(async (left, right) => {
      await left.query(
        "CREATE SEQUENCE retained_ids START WITH 7 INCREMENT BY 3",
      );
      await right.query(
        "CREATE SEQUENCE retained_ids START WITH 7 INCREMENT BY 3",
      );
      const before = await readMigrationCompatibilityState(left);
      expect(before).toEqual(await readMigrationCompatibilityState(left));
      await right.query("SELECT nextval('retained_ids')");
      const after = await readMigrationCompatibilityState(right);

      expect(before.schema).toBe(after.schema);
      expect(before.data).not.toEqual(after.data);
      expect(before.data['"public"."retained_ids"']?.rows).toBe(1);
    });
  });

  it("includes data and definitions in nonpublic user schemas", async () => {
    await withDatabases(async (left, right) => {
      const schema =
        "CREATE SCHEMA business; CREATE TABLE business.retained (value text); INSERT INTO business.retained VALUES ('kept')";
      await left.query(schema);
      await right.query(schema);
      const before = await readMigrationCompatibilityState(left);
      await right.query("UPDATE business.retained SET value = 'different'");
      const differentData = await readMigrationCompatibilityState(right);
      expect(before.schema).toBe(differentData.schema);
      expect(before.data).not.toEqual(differentData.data);

      await right.query(
        "ALTER TABLE business.retained ADD COLUMN extra boolean",
      );
      expect(before.schema).not.toBe(
        (await readMigrationCompatibilityState(right)).schema,
      );
    });
  });

  it("excludes only the migration bookkeeping schema", async () => {
    await withDatabases(async (left, right) => {
      await left.query("CREATE TABLE retained (id integer)");
      await right.query(
        "CREATE TABLE retained (id integer); CREATE SCHEMA dads_migration; CREATE TABLE dads_migration.executed (name text); INSERT INTO dads_migration.executed VALUES ('a different execution order')",
      );

      expect(await readMigrationCompatibilityState(left)).toEqual(
        await readMigrationCompatibilityState(right),
      );
    });
  });

  it.each([
    "ALTER TABLE retained ALTER COLUMN value SET DEFAULT 'different'",
    "ALTER TABLE retained ADD CONSTRAINT retained_positive CHECK (id > 0)",
    "CREATE INDEX retained_value_idx ON retained(value)",
    "CREATE VIEW retained_values AS SELECT value FROM retained",
  ])(
    "includes defaults, constraints, indexes, and views: %s",
    async (change) => {
      await withDatabases(async (left, right) => {
        const schema =
          "CREATE TABLE retained (id integer, value text DEFAULT 'kept')";
        await left.query(schema);
        await right.query(schema);
        await right.query(change);

        expect((await readMigrationCompatibilityState(left)).schema).not.toBe(
          (await readMigrationCompatibilityState(right)).schema,
        );
      });
    },
  );
  it.each([
    {
      change: "publication names",
      left: "CREATE PUBLICATION retained_publication FOR TABLE retained",
      right: "CREATE PUBLICATION another_publication FOR TABLE retained",
    },
    {
      change: "published operations",
      left: "CREATE PUBLICATION retained_publication FOR TABLE retained WITH (publish = 'insert')",
      right:
        "CREATE PUBLICATION retained_publication FOR TABLE retained WITH (publish = 'insert, update')",
    },
    {
      change: "table membership",
      left: "CREATE PUBLICATION retained_publication FOR TABLE retained",
      right: "CREATE PUBLICATION retained_publication FOR TABLE another",
    },
    {
      change: "row filters",
      left: "CREATE PUBLICATION retained_publication FOR TABLE retained WHERE (id > 0)",
      right:
        "CREATE PUBLICATION retained_publication FOR TABLE retained WHERE (id > 1)",
    },
    {
      change: "column selections",
      left: "CREATE PUBLICATION retained_publication FOR TABLE retained (id)",
      right:
        "CREATE PUBLICATION retained_publication FOR TABLE retained (id, value)",
    },
    {
      change: "schema membership",
      left: "CREATE PUBLICATION retained_publication FOR TABLES IN SCHEMA public",
      right:
        "CREATE PUBLICATION retained_publication FOR TABLES IN SCHEMA business",
    },
  ])(
    "includes $change in logical replication evidence",
    async (publication) => {
      await withDatabases(async (left, right) => {
        const schema =
          "CREATE TABLE retained (id integer PRIMARY KEY, value text); CREATE TABLE another (id integer PRIMARY KEY); CREATE SCHEMA business";
        await left.query(schema);
        await right.query(schema);
        await left.query(publication.left);
        await right.query(publication.right);

        const before = await readMigrationCompatibilityState(left);
        const after = await readMigrationCompatibilityState(right);
        expect(before.schema).not.toBe(after.schema);
        expect(before.data).toEqual(after.data);
      });
    },
  );

  it("refuses subscriptions without inspecting or exposing connection metadata", async () => {
    await withDatabases(async (_left, right) => {
      await right.query(`
        CREATE SUBSCRIPTION retained_subscription
        CONNECTION 'host=127.0.0.1 port=1 dbname=unused user=unused'
        PUBLICATION retained_publication
        WITH (connect = false, create_slot = false, enabled = false, slot_name = NONE)
      `);
      try {
        await expect(
          readMigrationCompatibilityState(right),
        ).rejects.toMatchObject({
          code: "MIGRATION_COMPATIBILITY_UNSUPPORTED_REPLICATION_STATE",
          reason: "subscriptions",
        });
        await expect(
          readMigrationCompatibilityState(right),
        ).rejects.toBeInstanceOf(
          UnsupportedMigrationCompatibilityReplicationStateError,
        );
      } finally {
        await right.query("DROP SUBSCRIPTION retained_subscription");
      }
    });
  });
});

async function withDatabases(
  verify: (left: Client, right: Client) => Promise<void>,
): Promise<void> {
  const leftFixture = await createPrivateDatabase(server.connectionString, {});
  try {
    const rightFixture = await createPrivateDatabase(
      server.connectionString,
      {},
    );
    const left = new Client({ connectionString: leftFixture.connectionString });
    const right = new Client({
      connectionString: rightFixture.connectionString,
    });
    try {
      await Promise.all([left.connect(), right.connect()]);
      await verify(left, right);
    } finally {
      await Promise.allSettled([left.end(), right.end()]);
      await rightFixture.stop();
    }
  } finally {
    await leftFixture.stop();
  }
}
