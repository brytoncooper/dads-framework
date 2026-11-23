import { describe, expect, it } from "vitest";

import { parseConcurrentIndexStatement } from "./parse-concurrent-index-statement.js";

describe("parseConcurrentIndexStatement", () => {
  it("accepts a concurrent create and names the index and table it builds", () => {
    expect(
      parseConcurrentIndexStatement(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_owner_idx" ON "audit_log" ("owner_id", "recorded_at");',
      ),
    ).toEqual({
      ok: true,
      statement: {
        kind: "create",
        sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_owner_idx" ON "audit_log" ("owner_id", "recorded_at")',
        indexName: "audit_log_owner_idx",
        tableReference: '"audit_log"',
      },
    });
  });

  it("accepts unique, partial and schema-qualified creates and folds unquoted names", () => {
    const parsed = parseConcurrentIndexStatement(
      "create unique index concurrently if not exists Widget_Code ON public.widgets USING btree (code) WHERE deleted_at IS NULL",
    );
    expect(parsed).toMatchObject({
      ok: true,
      statement: {
        kind: "create",
        indexName: "widget_code",
        tableReference: "public.widgets",
      },
    });
  });

  it("refuses an index name PostgreSQL would truncate, counting bytes not characters", () => {
    const longName = "a".repeat(64);
    expect(
      parseConcurrentIndexStatement(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${longName}" ON widgets (code)`),
    ).toMatchObject({ ok: false });
    const refused = parseConcurrentIndexStatement(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${longName}" ON widgets (code)`,
    );
    expect(refused.ok ? "" : refused.reason).toMatch(/longer than 63 bytes.*explicit.*name/);

    const multiByteName = "é".repeat(32);
    expect(multiByteName.length).toBe(32);
    expect(
      parseConcurrentIndexStatement(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${multiByteName}" ON widgets (code)`),
    ).toMatchObject({ ok: false });

    expect(
      parseConcurrentIndexStatement(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${"a".repeat(63)}" ON widgets (code)`),
    ).toMatchObject({ ok: true });
  });

  it("accepts a concurrent drop", () => {
    expect(parseConcurrentIndexStatement('DROP INDEX CONCURRENTLY IF EXISTS "public"."widget_code";')).toMatchObject({
      ok: true,
      statement: { kind: "drop" },
    });
  });

  it.each([
    ["a plain create", "CREATE INDEX IF NOT EXISTS widget_code ON widgets (code)"],
    ["a create without IF NOT EXISTS", "CREATE INDEX CONCURRENTLY widget_code ON widgets (code)"],
    ["a drop without IF EXISTS", "DROP INDEX CONCURRENTLY widget_code"],
    ["a cascading drop", "DROP INDEX CONCURRENTLY IF EXISTS widget_code CASCADE"],
    ["other DDL", "ALTER TABLE widgets ADD COLUMN code text"],
    ["a data change", "UPDATE widgets SET code = 'x'"],
    [
      "a second statement after an index",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_code ON widgets (code); DROP TABLE widgets",
    ],
    ["a comment", "CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_code ON widgets (code) -- note"],
  ])("refuses %s", (_label, sql) => {
    expect(parseConcurrentIndexStatement(sql)).toMatchObject({ ok: false });
  });
});
