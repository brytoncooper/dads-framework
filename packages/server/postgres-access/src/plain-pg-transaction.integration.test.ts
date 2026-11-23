import { actor, compileAccess, resource } from "@dads-framework/access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_CONFLICT,
  PostgresAuthorization,
  PostgresSerializationConflict,
  readPostgresSerializationConflict,
  relationshipSchemaMigration,
  withProtectedPgTransaction,
  withProtectedPostgresTransaction,
  type PgClientLike,
  type ProtectedPgTransaction,
} from "./index.js";

const user = actor("user");
const group = resource("pg-transaction/group", {
  roles: { member: user },
  can: ({ member }) => ({ manage: member }),
});
const model = compileAccess([user, group]);

function membership(groupId: string, userId: string) {
  return {
    resource: { type: group.wireName, id: groupId },
    relation: "member",
    subject: { type: user.wireName, id: userId },
  };
}

function removal(groupId: string, userId: string) {
  const { resource, subject, relation } = membership(groupId, userId);
  return {
    resourceType: resource.type,
    resourceId: resource.id,
    relation,
    subject,
  };
}

function manage(groupId: string, userId: string) {
  const { resource, subject } = membership(groupId, userId);
  return { resource, subject, permission: "manage" };
}

describe("plain pg protected transaction", () => {
  let container: Awaited<ReturnType<typeof startUnmigratedTestPostgres>> | undefined;
  let pool: Pool | undefined;
  let authorization: PostgresAuthorization;

  beforeAll(async () => {
    container = await startUnmigratedTestPostgres();
    pool = new Pool({
      connectionString: container.connectionString,
      max: 4,
    });
    await pool.query(relationshipSchemaMigration.sql);
    await pool.query(
      "create table plain_pg_membership (group_id text not null, user_id text not null, primary key (group_id, user_id))",
    );
    authorization = new PostgresAuthorization({
      model,
      namespace: "test-plain-pg-transaction",
      executor: pool,
    });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  function requirePool(): Pool {
    if (pool === undefined) throw new Error("Missing test pg pool");
    return pool;
  }

  async function members(groupId: string, reader: Pick<PgClientLike, "query"> = requirePool()): Promise<string[]> {
    const result = await reader.query("select user_id from plain_pg_membership where group_id = $1 order by user_id", [
      groupId,
    ]);
    return result.rows.map((row) => {
      const value = row["user_id"];
      if (typeof value !== "string") {
        throw new Error("Expected string user_id");
      }
      return value;
    });
  }

  async function addMember(groupId: string, userId: string, scope: ProtectedPgTransaction): Promise<void> {
    await scope.client.query("insert into plain_pg_membership (group_id, user_id) values ($1, $2)", [groupId, userId]);
    await scope.authorization.writeRelationships([membership(groupId, userId)]);
  }

  it("commits application rows and relationship facts atomically on plain pg.Pool", async () => {
    const groupId = "plain-commit";
    const result = await withProtectedPgTransaction({ pool: requirePool(), authorization }, async (scope) => {
      await addMember(groupId, "alice", scope);
      expect(await scope.authorization.check(manage(groupId, "alice"))).toBe(true);
      return "committed";
    });

    expect(result).toBe("committed");
    expect(await members(groupId)).toEqual(["alice"]);
    expect(await authorization.check(manage(groupId, "alice"))).toBe(true);
  });

  it("supports plain pg.Pool through the unified withProtectedPostgresTransaction helper", async () => {
    const groupId = "unified-pool-commit";
    await withProtectedPostgresTransaction({ pool: requirePool(), authorization }, async (scope) => {
      await addMember(groupId, "bob", scope);
    });

    expect(await members(groupId)).toEqual(["bob"]);
    expect(await authorization.check(manage(groupId, "bob"))).toBe(true);
  });

  it("rolls back application data and authorization tuples together on callback failure", async () => {
    const groupId = "plain-rollback";
    const rejected = new Error("Application rejected write");

    await expect(
      withProtectedPgTransaction({ pool: requirePool(), authorization }, async (scope) => {
        await addMember(groupId, "alice", scope);
        expect(await scope.authorization.check(manage(groupId, "alice"))).toBe(true);
        throw rejected;
      }),
    ).rejects.toBe(rejected);

    expect(await members(groupId)).toEqual([]);
    expect(await authorization.check(manage(groupId, "alice"))).toBe(false);
  });

  it("prevents concurrent write skew under SERIALIZABLE isolation and wraps 40001 conflicts", async () => {
    const groupId = "plain-write-skew";
    const pgPool = requirePool();
    await pgPool.query("insert into plain_pg_membership (group_id, user_id) values ($1, 'alice'), ($1, 'bob')", [
      groupId,
    ]);
    await authorization.writeRelationships([membership(groupId, "alice"), membership(groupId, "bob")]);

    const rendezvous = twoReaders();
    const remove = vi.fn(async (scope: ProtectedPgTransaction, userId: string) => {
      expect(await scope.authorization.check(manage(groupId, userId))).toBe(true);
      expect(await members(groupId, scope.client)).toEqual(["alice", "bob"]);
      await rendezvous.wait();
      await scope.client.query("delete from plain_pg_membership where group_id = $1 and user_id = $2", [
        groupId,
        userId,
      ]);
      await scope.authorization.deleteRelationships(removal(groupId, userId));
    });

    function attempt(userId: string) {
      return withProtectedPgTransaction({ pool: pgPool, authorization }, (scope) => remove(scope, userId)).catch(
        (error: unknown) => {
          rendezvous.release();
          throw error;
        },
      );
    }

    const results = await Promise.allSettled([attempt("alice"), attempt("bob")]);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    const conflict: unknown = rejected[0]?.reason;
    expect(conflict).toBeInstanceOf(PostgresSerializationConflict);
    if (!(conflict instanceof PostgresSerializationConflict)) {
      throw new Error("Expected PostgresSerializationConflict");
    }
    expect(conflict).toMatchObject({
      code: POSTGRES_CONFLICT,
      retryable: true,
    });
    expect(readPostgresSerializationConflict(conflict.cause)?.cause).toBe(conflict.cause);

    const remaining = await members(groupId);
    expect(remaining).toHaveLength(1);
    const allowed = await authorization.checkMany([manage(groupId, "alice"), manage(groupId, "bob")]);
    expect(allowed).toEqual(["alice", "bob"].map((userId) => remaining.includes(userId)));
  });

  it("expires scoped authorization immediately after commit and blocks post-commit reuse", async () => {
    const groupId = "plain-expired";
    const pgPool = requirePool();
    const expired = await withProtectedPgTransaction({ pool: pgPool, authorization }, async (scope) => {
      await addMember(groupId, "alice", scope);
      return scope.authorization;
    });

    await expect(expired.check(manage(groupId, "alice"))).rejects.toThrow("scope has ended");
    await expect(expired.deleteRelationships(removal(groupId, "alice"))).rejects.toThrow("scope has ended");
    await expect(
      withProtectedPgTransaction({ pool: pgPool, authorization: expired }, () => Promise.resolve()),
    ).rejects.toThrow("scope has ended");
    expect(await authorization.check(manage(groupId, "alice"))).toBe(true);
  });

  it("binds PostgresAuthorization.inTransaction directly to a plain pg.PoolClient", async () => {
    const groupId = "plain-manual-client";
    const client = await requirePool().connect();
    try {
      await client.query("BEGIN");
      const bound = authorization.inTransaction(client);
      await bound.writeRelationships([membership(groupId, "carol")]);
      expect(await bound.check(manage(groupId, "carol"))).toBe(true);
      expect(await authorization.check(manage(groupId, "carol"))).toBe(false);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await authorization.check(manage(groupId, "carol"))).toBe(false);
  });
});

function twoReaders() {
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  let count = 0;
  return {
    wait() {
      count += 1;
      if (count === 2) release();
      return ready;
    },
    release: () => {
      release();
    },
  };
}
