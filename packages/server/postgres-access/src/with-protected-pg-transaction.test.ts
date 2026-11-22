import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { access, accessModel, entityHandle } from "@dads-framework/access";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  POSTGRES_CONFLICT,
  PostgresAuthorization,
  PostgresSerializationConflict,
  withProtectedPgTransaction,
  withProtectedPostgresTransaction,
  type PgClientLike,
  type PgPoolLike,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresValue,
} from "./index.js";

const idSchema = z.string();
const user = entityHandle({ wireName: "user", idSchema });
const doc = entityHandle({ wireName: "doc", kind: "record", idSchema });
const model = accessModel([
  access(user, { roles: {}, permissions: () => ({}) }),
  access(doc, {
    roles: { editor: user },
    permissions: (roles) => ({ edit: [roles.editor] }),
  }),
]);

type RecordedQuery = {
  readonly text: string;
  readonly values: readonly PostgresValue[] | undefined;
};

type FakePoolOptions = {
  readonly onQuery?: (
    text: string,
    values: readonly PostgresValue[] | undefined,
  ) => PostgresQueryResult | Promise<PostgresQueryResult>;
  readonly trackTransactionStatus?: boolean;
};

function createFakePgPool(options: FakePoolOptions = {}) {
  const poolQueries: RecordedQuery[] = [];
  const clientQueries: RecordedQuery[] = [];
  const releases: (Error | boolean | undefined)[] = [];
  let connectCount = 0;
  let txStatus: "I" | "T" | "E" = "I";

  const client: PgClientLike = {
    async query(
      query: string | PostgresQuery,
      values?: PostgresValue[],
    ): Promise<PostgresQueryResult> {
      const text = typeof query === "string" ? query : query.text;
      const boundValues = typeof query === "string" ? values : query.values;
      clientQueries.push({ text, values: boundValues });
      if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE") txStatus = "T";
      if (text === "COMMIT" || text === "ROLLBACK") txStatus = "I";
      if (options.onQuery !== undefined) {
        try {
          return await options.onQuery(text, boundValues);
        } catch (error) {
          if (text === "COMMIT") {
            txStatus = "I";
          } else if (txStatus === "T") {
            txStatus = "E";
          }
          throw error;
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release(destroy?: Error | boolean) {
      releases.push(destroy);
    },
    ...(options.trackTransactionStatus === false
      ? {}
      : { getTransactionStatus: () => txStatus }),
  };

  const pool: PgPoolLike = {
    query(
      query: string | PostgresQuery,
      values?: PostgresValue[],
    ): Promise<PostgresQueryResult> {
      const text = typeof query === "string" ? query : query.text;
      const boundValues = typeof query === "string" ? values : query.values;
      poolQueries.push({ text, values: boundValues });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect() {
      connectCount += 1;
      return Promise.resolve(client);
    },
  };

  return {
    pool,
    client,
    poolQueries,
    clientQueries,
    releases,
    getConnectCount: () => connectCount,
  };
}

function createAuth(pool: PgPoolLike): PostgresAuthorization {
  return new PostgresAuthorization({
    model,
    namespace: "unit-pg-tx",
    executor: pool,
  });
}

function editCheck(docId: string, userId: string) {
  return {
    resource: { type: doc.wireName, id: docId },
    subject: { type: user.wireName, id: userId },
    permission: "edit",
  };
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("withProtectedPgTransaction", () => {
  it("commits application SQL and scoped authorization on the same checked-out client", async () => {
    const fake = createFakePgPool({
      onQuery(text) {
        if (text.includes("allowed")) {
          return { rows: [{ allowed: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);

    const outcome = await withProtectedPgTransaction(
      { pool: fake.pool, authorization },
      async ({ client, authorization: scoped }) => {
        expect(client).toBe(fake.client);
        const allowed = await scoped.check(editCheck("doc-1", "alice"));
        expect(allowed).toBe(true);
        await client.query("INSERT INTO docs (id) VALUES ($1)", ["doc-1"]);
        return "saved";
      },
    );

    expect(outcome).toBe("saved");
    expect(fake.poolQueries).toEqual([]);
    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      expect.stringContaining("allowed"),
      "INSERT INTO docs (id) VALUES ($1)",
      "COMMIT",
    ]);
    expect(fake.releases).toEqual([undefined]);
  });

  it("rolls back and rethrows application errors cleanly", async () => {
    const fake = createFakePgPool();
    const authorization = createAuth(fake.pool);
    const failure = new Error("application validation failed");

    await expect(
      withProtectedPgTransaction(
        { pool: fake.pool, authorization },
        async ({ client }) => {
          await client.query("INSERT INTO docs (id) VALUES ($1)", ["doc-2"]);
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "INSERT INTO docs (id) VALUES ($1)",
      "ROLLBACK",
    ]);
    expect(fake.releases).toEqual([undefined]);
  });

  it("destroys the checked-out client if ROLLBACK fails while preserving the original error", async () => {
    const fake = createFakePgPool({
      onQuery(text) {
        if (text === "ROLLBACK") throw new Error("socket closed");
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);
    const original = new Error("original write error");

    await expect(
      withProtectedPgTransaction({ pool: fake.pool, authorization }, () =>
        Promise.reject(original),
      ),
    ).rejects.toBe(original);

    expect(fake.releases).toEqual([true]);
  });

  it("destroys the client if BEGIN fails without issuing ROLLBACK", async () => {
    const beginFailure = new Error("connection terminated");
    const fake = createFakePgPool({
      onQuery(text) {
        if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE") throw beginFailure;
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);
    const work = vi.fn(() => Promise.resolve());

    await expect(
      withProtectedPgTransaction({ pool: fake.pool, authorization }, work),
    ).rejects.toBe(beginFailure);

    expect(work).not.toHaveBeenCalled();
    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
    ]);
    expect(fake.releases).toEqual([true]);
  });

  it("wraps 40001 serialization failures thrown inside the callback", async () => {
    const sqlState = pgError("40001", "could not serialize access");
    const fake = createFakePgPool({
      onQuery(text) {
        if (text.startsWith("UPDATE")) throw sqlState;
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);

    const thrown = await withProtectedPgTransaction(
      { pool: fake.pool, authorization },
      ({ client }) => client.query("UPDATE docs SET title = 'v2'"),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PostgresSerializationConflict);
    if (!(thrown instanceof PostgresSerializationConflict)) {
      throw new Error("Expected PostgresSerializationConflict");
    }
    expect(thrown.code).toBe(POSTGRES_CONFLICT);
    expect(thrown.retryable).toBe(true);
    expect(thrown.cause).toBe(sqlState);
    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "UPDATE docs SET title = 'v2'",
      "ROLLBACK",
    ]);
    expect(fake.releases).toEqual([undefined]);
  });

  it("wraps 40001 serialization failures deferred until COMMIT", async () => {
    const commitConflict = pgError("40001", "could not serialize on commit");
    const fake = createFakePgPool({
      onQuery(text) {
        if (text === "COMMIT") throw commitConflict;
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);

    const thrown = await withProtectedPgTransaction(
      { pool: fake.pool, authorization },
      async ({ client }) => {
        await client.query("UPDATE docs SET title = 'v3'");
      },
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PostgresSerializationConflict);
    if (!(thrown instanceof PostgresSerializationConflict)) {
      throw new Error("Expected PostgresSerializationConflict");
    }
    expect(thrown.code).toBe(POSTGRES_CONFLICT);
    expect(thrown.retryable).toBe(true);
    expect(thrown.cause).toBe(commitConflict);
    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "UPDATE docs SET title = 'v3'",
      "COMMIT",
    ]);
    expect(fake.releases).toEqual([undefined]);
  });

  it("does not mislabel non-40001 PostgreSQL errors as serialization conflicts", async () => {
    const divisionByZero = pgError("22012", "division by zero");
    const fake = createFakePgPool({
      onQuery(text) {
        if (text === "SELECT 1 / 0") throw divisionByZero;
        return { rows: [], rowCount: 0 };
      },
    });
    const authorization = createAuth(fake.pool);

    await expect(
      withProtectedPgTransaction(
        { pool: fake.pool, authorization },
        ({ client }) => client.query("SELECT 1 / 0"),
      ),
    ).rejects.toBe(divisionByZero);
  });

  it("closes scoped authorization after commit and blocks leaked post-commit use", async () => {
    const fake = createFakePgPool();
    const authorization = createAuth(fake.pool);

    const leaked = await withProtectedPgTransaction(
      { pool: fake.pool, authorization },
      ({ authorization: scoped }) => Promise.resolve(scoped),
    );

    await expect(leaked.check(editCheck("doc-1", "alice"))).rejects.toThrow(
      "scope has ended",
    );
    await expect(
      leaked.writeRelationships([
        {
          resource: { type: doc.wireName, id: "doc-1" },
          relation: "editor",
          subject: { type: user.wireName, id: "alice" },
        },
      ]),
    ).rejects.toThrow("scope has ended");
    await expect(
      leaked.deleteRelationships({ resourceType: doc.wireName }),
    ).rejects.toThrow("scope has ended");
    expect(() => leaked.inTransaction(fake.client)).toThrow("scope has ended");

    const beforeConnects = fake.getConnectCount();
    await expect(
      withProtectedPgTransaction(
        { pool: fake.pool, authorization: leaked },
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("scope has ended");
    expect(fake.getConnectCount()).toBe(beforeConnects);
  });

  it("refuses passing an active scoped authorization into another pool transaction", async () => {
    const fake = createFakePgPool();
    const authorization = createAuth(fake.pool);

    await withProtectedPgTransaction(
      { pool: fake.pool, authorization },
      async ({ authorization: scoped }) => {
        const beforeConnects = fake.getConnectCount();
        await expect(
          withProtectedPgTransaction(
            { pool: fake.pool, authorization: scoped },
            () => Promise.resolve(),
          ),
        ).rejects.toThrow("can only join its own Postgres transaction");
        expect(fake.getConnectCount()).toBe(beforeConnects);
      },
    );
  });

  it("dispatches withProtectedPostgresTransaction({ pool, authorization }) to plain pg", async () => {
    const fake = createFakePgPool();
    const authorization = createAuth(fake.pool);

    const leaked = await withProtectedPostgresTransaction(
      { pool: fake.pool, authorization },
      async ({ client, authorization: scoped }) => {
        expect(client).toBe(fake.client);
        await client.query("SELECT 1");
        return scoped;
      },
    );

    expect(fake.clientQueries.map((entry) => entry.text)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT 1",
      "COMMIT",
    ]);
    await expect(leaked.check(editCheck("doc-1", "alice"))).rejects.toThrow(
      "scope has ended",
    );
  });

  it("keeps core modules free of drizzle-orm and @dads-framework/postgres imports", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const coreFiles = [
      "index.ts",
      "postgres-authorization.ts",
      "lookup-primary-pool.ts",
      "prepared-check-executor.ts",
      "revisioned-lookup.ts",
      "postgres-types.ts",
      "drizzle-structural.ts",
      "protected-authorization-scope.ts",
      "transactional-access-changes.ts",
      "with-protected-pg-transaction.ts",
      "with-protected-postgres-transaction.ts",
    ];
    for (const file of coreFiles) {
      const source = readFileSync(join(srcDir, file), "utf8");
      expect(source, `${file} must not import drizzle-orm`).not.toMatch(
        /from\s+["']drizzle-orm/,
      );
      expect(
        source,
        `${file} must not import @dads-framework/postgres`,
      ).not.toMatch(/from\s+["']@dads-framework\/postgres/);
    }
  });
});
