import { actor, compileAccess, resource } from "@dads-framework/access";
import { createPostgresConnection, type DrizzleHandle } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type ProtectedDrizzleTransaction, withProtectedDrizzleTransaction } from "./drizzle.js";
import {
  POSTGRES_CONFLICT,
  PostgresAuthorization,
  PostgresSerializationConflict,
  readPostgresSerializationConflict,
  relationshipSchemaMigration,
} from "./index.js";

const user = actor("user");
const group = resource("transaction/group", {
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

describe("protected Postgres transaction", () => {
  let container: Awaited<ReturnType<typeof startUnmigratedTestPostgres>> | undefined;
  let connection: ReturnType<typeof createPostgresConnection> | undefined;
  let database: DrizzleHandle;
  let authorization: PostgresAuthorization;

  beforeAll(async () => {
    container = await startUnmigratedTestPostgres();
    await container.pool.query(relationshipSchemaMigration.sql);
    await container.pool.query(
      "create table protected_membership (group_id text not null, user_id text not null, primary key (group_id, user_id))",
    );
    connection = createPostgresConnection(
      {
        connectionString: container.connectionString,
        schema: {},
        maxConnections: 4,
      },
      { error: () => undefined },
    );
    database = connection.drizzle;
    authorization = new PostgresAuthorization({
      model,
      namespace: "test-protected-transaction",
      executor: connection.pool,
    });
  }, 90_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  });

  async function members(groupId: string, reader = database): Promise<string[]> {
    const { rows } = await reader.execute<{ user_id: string }>(sql`
      select user_id from protected_membership
      where group_id = ${groupId} order by user_id
    `);
    return rows.map((row) => row.user_id);
  }

  async function addAlice(groupId: string, { tx, authorization: scoped }: ProtectedDrizzleTransaction): Promise<void> {
    await tx.execute(sql`insert into protected_membership values (${groupId}, 'alice')`);
    await scoped.writeRelationships([membership(groupId, "alice")]);
  }

  it("prevents concurrent removals from jointly removing the last manager", async () => {
    const groupId = "write-skew";
    await database.execute(sql`
      insert into protected_membership values (${groupId}, 'alice'), (${groupId}, 'bob')
    `);
    await authorization.writeRelationships([membership(groupId, "alice"), membership(groupId, "bob")]);

    const rendezvous = twoReaders();
    const remove = vi.fn(async (scope: ProtectedDrizzleTransaction<DrizzleHandle>, userId: string) => {
      expect(await scope.authorization.check(manage(groupId, userId))).toBe(true);
      expect(await members(groupId, scope.tx)).toEqual(["alice", "bob"]);
      await rendezvous.wait();
      await scope.tx.execute(sql`
        delete from protected_membership where group_id = ${groupId} and user_id = ${userId}
      `);
      await scope.authorization.deleteRelationships(removal(groupId, userId));
    });
    function attempt(userId: string) {
      return withProtectedDrizzleTransaction({ database, authorization }, (scope) => remove(scope, userId)).catch(
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
    if (!(conflict instanceof PostgresSerializationConflict)) throw new Error("Missing conflict");
    expect(conflict).toMatchObject({
      code: POSTGRES_CONFLICT,
      retryable: true,
    });
    expect(readPostgresSerializationConflict(conflict.cause)?.cause).toBe(conflict.cause);
    expect(readPostgresSerializationConflict(conflict)).toBe(conflict);

    const remaining = await members(groupId);
    expect(remaining).toHaveLength(1);
    const allowed = await authorization.checkMany([manage(groupId, "alice"), manage(groupId, "bob")]);
    expect(allowed).toEqual(["alice", "bob"].map((userId) => remaining.includes(userId)));
  });

  it("rolls back application data and the authorization tuple together", async () => {
    const groupId = "rollback";
    const refused = new Error("Application rejected the write");
    const callback = vi.fn(async (scope: ProtectedDrizzleTransaction) => {
      await addAlice(groupId, scope);
      expect(await scope.authorization.check(manage(groupId, "alice"))).toBe(true);
      throw refused;
    });

    await expect(withProtectedDrizzleTransaction({ database, authorization }, callback)).rejects.toBe(refused);
    expect(callback).toHaveBeenCalledOnce();
    expect(await members(groupId)).toEqual([]);
    expect(await authorization.check(manage(groupId, "alice"))).toBe(false);
  });

  it("joins the same serializable transaction and expires the inner authorization on exit", async () => {
    const groupId = "join";
    const refused = new Error("Outer owner rolls back");
    await expect(
      database.transaction(
        async (tx) => {
          const expired = await withProtectedDrizzleTransaction({ transaction: tx, authorization }, async (scope) => {
            expect(scope.tx).toBe(tx);
            await addAlice(groupId, scope);
            expect(await scope.authorization.check(manage(groupId, "alice"))).toBe(true);
            return scope.authorization;
          });
          await expect(expired.check(manage(groupId, "alice"))).rejects.toThrow("scope has ended");
          expect(await members(groupId, tx)).toEqual(["alice"]);
          throw refused;
        },
        { isolationLevel: "serializable" },
      ),
    ).rejects.toBe(refused);
    expect(await members(groupId)).toEqual([]);
    expect(await authorization.check(manage(groupId, "alice"))).toBe(false);
  });

  it.each(["read committed", "repeatable read"] as const)(
    "refuses a %s caller transaction before starting the callback",
    async (isolationLevel) => {
      const callback = vi.fn(() => Promise.resolve());
      await database.transaction(
        async (tx) => {
          await expect(withProtectedDrizzleTransaction({ transaction: tx, authorization }, callback)).rejects.toThrow(
            "require serializable isolation",
          );
          await expect(withProtectedDrizzleTransaction({ database: tx, authorization }, callback)).rejects.toThrow(
            "Pass an existing Postgres transaction",
          );
        },
        { isolationLevel },
      );
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it("takes a snapshot before the callback can lower isolation", async () => {
    await expect(
      withProtectedDrizzleTransaction({ database, authorization }, ({ tx }) =>
        tx.execute(sql`set transaction isolation level read committed`),
      ),
    ).rejects.toMatchObject({ cause: { code: "25001" } });
  });

  it("refuses to replay the callback even if a transaction wrapper tries", async () => {
    const replaying: Pick<DrizzleHandle, "transaction"> = {
      transaction(work, options) {
        return database.transaction(async (tx) => {
          await work(tx);
          return work(tx);
        }, options);
      },
    };
    const work = vi.fn(() => Promise.resolve());
    await expect(withProtectedDrizzleTransaction({ database: replaying, authorization }, work)).rejects.toThrow(
      "cannot be replayed",
    );
    expect(work).toHaveBeenCalledOnce();
  });

  it("does not mislabel an ordinary PostgreSQL error", async () => {
    const error = await withProtectedDrizzleTransaction({ database, authorization }, ({ tx }) =>
      tx.execute(sql`select 1 / 0`),
    ).catch((failure: unknown) => failure);
    expect(error).not.toBeInstanceOf(PostgresSerializationConflict);
    expect(error).toMatchObject({ cause: { code: "22012" } });
  });

  it("expires authorization after a successful owned transaction", async () => {
    const groupId = "owned";
    const expired = await withProtectedDrizzleTransaction({ database, authorization }, async (scope) => {
      await addAlice(groupId, scope);
      return scope.authorization;
    });
    const reuse = vi.fn(() => Promise.resolve());
    await expect(withProtectedDrizzleTransaction({ database, authorization: expired }, reuse)).rejects.toThrow(
      "scope has ended",
    );
    expect(reuse).not.toHaveBeenCalled();
    expect(await members(groupId)).toEqual(["alice"]);
    expect(await authorization.check(manage(groupId, "alice"))).toBe(true);
    await expect(expired.check(manage(groupId, "alice"))).rejects.toThrow("scope has ended");
    await expect(expired.deleteRelationships(removal(groupId, "alice"))).rejects.toThrow("scope has ended");
    expect(await authorization.check(manage(groupId, "alice"))).toBe(true);
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
