import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "../testing/start-test-postgres.js";
import {
  checkGeneratedTableFiles,
  introspectAndGenerateTables,
  writeGeneratedTableFiles,
} from "./generate-database-tables.js";
import { introspectPostgresCatalog } from "./introspect-database.js";

let postgres: TestPostgres;
let tempRoot: string;

beforeAll(async () => {
  postgres = await startTestPostgres();
  tempRoot = mkdtempSync(join(tmpdir(), "dads-schema-generate-int-"));
  await postgres.pool.query(`
    CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'done');

    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE tasks (
      id uuid NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status task_status NOT NULL DEFAULT 'open',
      title text NOT NULL CHECK (char_length(title) > 0),
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      archived_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    );

    CREATE UNIQUE INDEX tasks_active_title_idx
      ON tasks (workspace_id, lower(title))
      WHERE archived_at IS NULL;
  `);
}, 180_000);

afterAll(async () => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  await postgres.stop();
});

describe("introspectPostgresCatalog (real PostgreSQL driver)", () => {
  it("returns real string arrays for enums, constraints, and indexes and passes drift check", async () => {
    const catalog = await introspectPostgresCatalog(postgres.pool, { schemas: ["public"] });

    expect(catalog.enums).toEqual([{ schema: "public", name: "task_status", labels: ["open", "in_progress", "done"] }]);

    const tasks = catalog.tables.find((table) => table.name === "tasks");
    expect(tasks).toBeDefined();

    const pk = tasks?.constraints.find((constraint) => constraint.kind === "primary_key");
    expect(pk?.columns).toEqual(["workspace_id", "id"]);

    const fk = tasks?.constraints.find((constraint) => constraint.kind === "foreign_key");
    expect(fk?.columns).toEqual(["workspace_id"]);
    expect(fk?.referencedTable).toBe("workspaces");
    expect(fk?.referencedColumns).toEqual(["id"]);

    const activeIdx = tasks?.indexes.find((index) => index.name === "tasks_active_title_idx");
    expect(activeIdx?.isUnique).toBe(true);
    expect(activeIdx?.columns).toEqual(["workspace_id"]);
    expect(activeIdx?.expressions).toHaveLength(2);
    expect(activeIdx?.wherePredicate).toContain("archived_at IS NULL");

    const generated = await introspectAndGenerateTables(postgres.pool, {
      schemas: ["public"],
      defaultOutputDir: "db/generated",
    });
    expect(generated.map((file) => file.outputFile)).toEqual(
      expect.arrayContaining(["db/generated/tasks.tables.ts", "db/generated/workspaces.tables.ts"]),
    );

    await writeGeneratedTableFiles(generated, tempRoot);
    const drift = await checkGeneratedTableFiles(generated, tempRoot);
    expect(drift).toEqual({ ok: true, drifted: [], missing: [] });
  });
});
