import { emitZed } from "@dads-framework/access";
import {
  SpiceDbAuthorization,
  authorizationKinds,
  DEFAULT_AUTHORIZATION_GUARD_MARKS,
  GuardedAuthorization,
  RecordLookupRefusedError,
  accessChangesToWrite,
  type PermissionQuery,
  type RelationshipWrite,
} from "@dads-framework/authorization";
import { startTestSpiceDb } from "@dads-framework/authorization/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { createPostgresConnection } from "@dads-framework/postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresAuthorization,
  relationshipSchemaMigration,
  TransactionalAccessChanges,
} from "./index.js";
import { model, noteWorld } from "../test-support/parity-world.js";

function parseWorldLine(text: string): RelationshipWrite {
  const match = /^([^:]+):([^#]+)#([^@]+)@([^:]+):([^#]+)(?:#(.+))?$/.exec(
    text,
  );
  if (match === null) throw new Error(`Malformed world line ${text}`);
  const [
    ,
    resourceType,
    resourceId,
    relation,
    subjectType,
    subjectId,
    subjectRelation,
  ] = match;
  if (!resourceType || !resourceId || !relation || !subjectType || !subjectId)
    throw new Error("World line is incomplete");
  return {
    resource: { type: resourceType, id: resourceId },
    relation,
    subject: {
      type: subjectType,
      id: subjectId,
      ...(subjectRelation === undefined ? {} : { relation: subjectRelation }),
    },
  };
}

function question(line: string): PermissionQuery {
  const { relation, resource, subject } = parseWorldLine(line);
  return { permission: relation, resource, subject };
}

const decisions = [
  ...noteWorld.assertions.true.map((line) => ({
    query: question(line),
    allowed: true,
  })),
  ...noteWorld.assertions.false.map((line) => ({
    query: question(line),
    allowed: false,
  })),
];

describe("Postgres access model parity", () => {
  const disposers: (() => Promise<void>)[] = [];
  let postgres: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>;
  let spice: Awaited<ReturnType<typeof startTestSpiceDb>>;
  let adapter: PostgresAuthorization;
  let baseline: SpiceDbAuthorization;

  beforeAll(async () => {
    postgres = await startUnmigratedTestPostgres();
    disposers.push(postgres.stop);
    spice = await startTestSpiceDb();
    disposers.push(spice.stop);
    await postgres.pool.query(relationshipSchemaMigration.sql);
    adapter = new PostgresAuthorization({
      model,
      namespace: "parity",
      executor: postgres.pool,
    });
    baseline = new SpiceDbAuthorization({
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    });
    await baseline.writeSchema(emitZed(model));
    const facts = noteWorld.relationships.map(parseWorldLine);
    await adapter.writeRelationships(facts);
    await baseline.writeRelationships(facts);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(disposers.map((stop) => stop()));
  });

  it("matches world assertions, including negative checks", async () => {
    const queries = decisions.map(({ query }) => query);
    const expected = decisions.map(({ allowed }) => allowed);
    await expect(adapter.checkMany(queries)).resolves.toEqual(expected);
    await expect(baseline.checkMany(queries)).resolves.toEqual(expected);
    for (const { query, allowed } of decisions) {
      expect(await adapter.check(query)).toBe(allowed);
    }
  });

  it("agrees on discovery and verifies each result against the same checks", async () => {
    for (const { query, allowed } of decisions) {
      const lookup = {
        subject: query.subject,
        permission: query.permission,
        resourceType: query.resource.type,
      };
      const pg = await adapter.lookupResources(lookup);
      const vendor = await baseline.lookupResources(lookup);
      expect(pg).toEqual([...vendor].sort());
      expect(pg.includes(query.resource.id)).toBe(allowed);
    }
  });

  it("preserves the record lookup guard when composed with the Postgres adapter", async () => {
    const guarded = new GuardedAuthorization(
      adapter,
      DEFAULT_AUTHORIZATION_GUARD_MARKS,
      authorizationKinds(model),
    );
    const query = decisions[0]?.query;
    if (query === undefined) throw new Error("World is empty");
    await expect(guarded.check(query)).resolves.toBe(true);
    await expect(
      guarded.lookupResources({
        subject: query.subject,
        resourceType: query.resource.type,
        permission: query.permission,
      }),
    ).rejects.toBeInstanceOf(RecordLookupRefusedError);
  });

  it("rolls relationship facts and application writes back together", async () => {
    const client = await postgres.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TABLE parity_row(id text PRIMARY KEY)");
      await client.query("INSERT INTO parity_row VALUES ('note_rolled_back')");
      const bound = adapter.inTransaction(client);
      const scope = { type: "parity/note", id: "note_rolled_back" };
      const relation = {
        resource: scope,
        relation: "shared",
        subject: { type: "user", id: "*" },
      };
      await bound.writeRelationships([relation]);
      const query = {
        resourceType: scope.type,
        resourceId: scope.id,
        relation: relation.relation,
      };
      await expect(bound.relationshipExists(query)).resolves.toBe(true);
      await expect(adapter.relationshipExists(query)).resolves.toBe(false);
      await client.query("ROLLBACK");
      await expect(adapter.relationshipExists(query)).resolves.toBe(false);
      const table = await postgres.pool.query<{ table_name: string | null }>(
        "SELECT to_regclass('parity_row') AS table_name",
      );
      expect(table.rows[0]?.table_name).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("uses the writer's existing enqueue port to commit grants and roll back revokes", async () => {
    const connection = createPostgresConnection(
      { connectionString: postgres.connectionString, schema: {} },
      { error: () => undefined },
    );
    const changes = new TransactionalAccessChanges(adapter, connection.drizzle);
    const resource = { type: "parity/note", id: "note_enqueued" };
    const relation = "shared";
    const tuples = [{ resource, relation, subject: { type: "user", id: "*" } }];
    const writes = accessChangesToWrite(tuples, "create-note", null);
    const lookup = {
      resourceType: resource.type,
      resourceId: resource.id,
      relation,
    };

    try {
      expect(() => changes.enqueue(writes, connection.drizzle)).toThrow(
        "Postgres access changes require the caller's Drizzle transaction",
      );
      await connection.drizzle.execute(
        sql`CREATE TABLE parity_enqueued_note(id text PRIMARY KEY)`,
      );
      await connection.drizzle.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO parity_enqueued_note (id) VALUES (${resource.id})`,
        );
        await changes.enqueue(writes, tx);
        await expect(adapter.relationshipExists(lookup)).resolves.toBe(false);
      });
      await expect(adapter.relationshipExists(lookup)).resolves.toBe(true);

      await expect(
        connection.drizzle.transaction(async (tx) => {
          await tx.execute(
            sql`DELETE FROM parity_enqueued_note WHERE id = ${resource.id}`,
          );
          await changes.enqueue(
            writes.map((entry) => ({ ...entry, operation: "DELETE" })),
            tx,
          );
          throw new Error("abort transaction");
        }),
      ).rejects.toThrow("abort transaction");
      await expect(adapter.relationshipExists(lookup)).resolves.toBe(true);
      const stored = await connection.drizzle.execute(
        sql`SELECT id FROM parity_enqueued_note`,
      );
      expect(stored.rows).toEqual([{ id: resource.id }]);
    } finally {
      await connection.close();
    }
  });

  it("filters deletes by relation and subject without crossing namespaces", async () => {
    const facts = noteWorld.relationships.map(parseWorldLine);
    const isolated = new PostgresAuthorization({
      model,
      namespace: "isolated",
      executor: postgres.pool,
    });
    await isolated.writeRelationships(facts);
    const deleteFilter = {
      resourceType: "parity/team",
      relation: "member",
      subject: { type: "user", id: "alice" },
    };
    await adapter.deleteRelationships(deleteFilter);
    await baseline.deleteRelationships(deleteFilter);
    const query = decisions[0]?.query;
    if (query === undefined) throw new Error("World is empty");
    await expect(adapter.check(query)).resolves.toBe(false);
    await expect(baseline.check(query)).resolves.toBe(false);
    await expect(isolated.check(query)).resolves.toBe(true);
    const lookup = {
      resource: { type: "parity/team", id: "team1" },
      relation: "member",
    };
    await expect(adapter.listDirectSubjects(lookup)).resolves.toEqual([
      { type: "user", id: "bob" },
    ]);
  });
});
