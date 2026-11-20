/**
 * createPostgresConnection close() ends the pool and is safe to call twice;
 * session settings become the pool's startup options, and anything but a
 * plain word is refused.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { DrizzleHandle } from "../drizzle.js";
import type { DrizzleHandle as RootHandle } from "../index.js";
import { createPostgresConnection } from "./create-postgres-connection.js";

describe("createPostgresConnection", () => {
  it("preserves the query type and infers a configured schema", async () => {
    const schema = { notes: pgTable("notes", { name: text().notNull() }) };
    const connection = createPostgresConnection(
      { schema, connectionString: "postgres://nobody:nope@127.0.0.1:1/void" },
      { error: vi.fn() },
    );
    expectTypeOf<DrizzleHandle>().toEqualTypeOf<
      NodePgDatabase<Record<string, unknown>>
    >();
    expectTypeOf<RootHandle>().toEqualTypeOf<DrizzleHandle>();
    expectTypeOf<DrizzleHandle<typeof schema>>().toEqualTypeOf<
      NodePgDatabase<typeof schema>
    >();
    expectTypeOf(connection.drizzle).toExtend<DrizzleHandle<typeof schema>>();
    expect(connection.drizzle.$client).toBe(connection.pool);
    await connection.close();
  });

  it("close ends the pool and a second close is a no-op", async () => {
    const postgres = createPostgresConnection(
      {
        schema: {},
        connectionString: "postgres://nobody:nope@127.0.0.1:1/void",
      },
      { error: vi.fn() },
    );
    expect(postgres.drizzle).toBeDefined();
    await expect(postgres.close()).resolves.toBeUndefined();
    await expect(postgres.close()).resolves.toBeUndefined();
    expect(postgres.pool.ended).toBe(true);
  });

  it("caps the pool at maxConnections, attributed or not, and keeps pg's 10 otherwise", async () => {
    const connectionString = "postgres://nobody:nope@127.0.0.1:1/void";
    const log = { error: vi.fn() };
    const capped = createPostgresConnection(
      { schema: {}, connectionString, maxConnections: 4 },
      log,
    );
    const attributed = createPostgresConnection(
      {
        schema: {},
        connectionString,
        maxConnections: 3,
        auditActorSource: () => undefined,
      },
      log,
    );
    const uncapped = createPostgresConnection(
      { schema: {}, connectionString },
      log,
    );

    expect(capped.pool.options.max).toBe(4);
    expect(attributed.pool.options.max).toBe(3);
    expect(uncapped.pool.options.max).toBe(10);
    await Promise.all([capped.close(), attributed.close(), uncapped.close()]);
  });

  it("sends session settings as startup options, attributed or not, and none when omitted", async () => {
    const connectionString = "postgres://nobody:nope@127.0.0.1:1/void";
    const log = { error: vi.fn() };
    const plain = createPostgresConnection(
      {
        schema: {},
        connectionString,
        sessionSettings: { "app.one": "on", "app.two": "off" },
      },
      log,
    );
    const attributed = createPostgresConnection(
      {
        schema: {},
        connectionString,
        auditActorSource: () => undefined,
        sessionSettings: { "app.one": "on" },
      },
      log,
    );
    const none = createPostgresConnection(
      { schema: {}, connectionString },
      log,
    );

    expect(plain.pool.options.options).toBe("-c app.one=on -c app.two=off");
    expect(attributed.pool.options.options).toBe("-c app.one=on");
    expect(none.pool.options.options).toBeUndefined();
    await Promise.all([plain.close(), attributed.close(), none.close()]);
  });

  it("refuses a session setting name or value that is not a plain word", () => {
    const connectionString = "postgres://nobody:nope@127.0.0.1:1/void";
    const log = { error: vi.fn() };
    const refusedSettings: readonly Readonly<Record<string, string>>[] = [
      { "app.one": "on -c other=on" },
      { "app one": "on" },
      { "app.one": "" },
    ];
    for (const sessionSettings of refusedSettings) {
      expect(() =>
        createPostgresConnection(
          { schema: {}, connectionString, sessionSettings },
          log,
        ),
      ).toThrow(/not a plain word/);
    }
  });
});
