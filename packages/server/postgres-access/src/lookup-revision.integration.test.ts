import { createPostgresConnection } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";
import { makeChain } from "../test-support/benchmark-chain.js";
import {
  lookupRevisionSchemaMigration,
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
} from "./index.js";

it("reuses immutable answers only for current committed facts under a restricted primary role", async () => {
  const owner = await startUnmigratedTestPostgres();
  let runtime: ReturnType<typeof createPostgresConnection> | undefined;
  let single: ReturnType<typeof createPostgresConnection> | undefined;
  try {
    await owner.pool.query(relationshipSchemaMigration.sql);
    await owner.pool.query(`
      CREATE ROLE lookup_runtime LOGIN PASSWORD 'lookup-test';
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.dad_authorization_relationship TO lookup_runtime;
    `);
    const runtimeUrl = new URL(owner.connectionString);
    runtimeUrl.username = "lookup_runtime";
    runtimeUrl.password = "lookup-test";
    runtime = createPostgresConnection(
      { schema: {}, connectionString: runtimeUrl.toString() },
      { error: () => undefined },
    );
    const { pool } = runtime;
    const { model, facts, check } = makeChain(2, 20);
    const [grant] = facts;
    if (grant === undefined) throw new Error("Missing fixture grant");
    const query = {
      permission: check.permission,
      resourceType: check.resource.type,
      subject: check.subject,
    };
    const uncached = new PostgresAuthorization({
      model,
      namespace: "first",
      executor: pool,
    });
    const first = new PostgresAuthorization({
      model,
      namespace: "first",
      executor: preparePostgresChecks(pool),
      reuseLookupResultsOn: pool,
    });
    const second = new PostgresAuthorization({
      model,
      namespace: "second",
      executor: pool,
      reuseLookupResultsOn: pool,
    });

    await uncached.writeRelationships(facts);
    const expected = await uncached.lookupResources(query);
    expect(expected).toHaveLength(20);
    await expect(first.lookupResources(query)).rejects.toThrow();
    await owner.pool.query(lookupRevisionSchemaMigration.sql);
    await owner.pool.query(lookupRevisionSchemaMigration.sql);
    await owner.pool.query(`
      GRANT USAGE ON SCHEMA dad_lookup_revision TO lookup_runtime;
      GRANT SELECT ON dad_lookup_revision.epoch, dad_lookup_revision.namespace TO lookup_runtime;
    `);
    await expect(pool.query("UPDATE dad_lookup_revision.epoch SET revision = 1")).rejects.toThrow();
    await expect(
      pool.query("ALTER TABLE public.dad_authorization_relationship DISABLE TRIGGER dad_lookup_revision_delete"),
    ).rejects.toThrow();

    single = createPostgresConnection(
      {
        schema: {},
        connectionString: runtimeUrl.toString(),
        maxConnections: 1,
      },
      { error: () => undefined },
    );
    const singleLookup = new PostgresAuthorization({
      model,
      namespace: "first",
      executor: single.pool,
      reuseLookupResultsOn: single.pool,
    });
    const leaked = await single.pool.connect();
    await leaked.query("BEGIN READ ONLY");
    leaked.release();
    await expect(singleLookup.lookupResources(query)).rejects.toThrow("idle pool connection");
    await expect(singleLookup.lookupResources(query)).resolves.toEqual(expected);

    const loaded = await first.lookupResources(query);
    expect(loaded).toEqual(expected);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(await first.lookupResources(query)).toBe(loaded);
    await owner.pool.query("REVOKE SELECT ON public.dad_authorization_relationship FROM lookup_runtime");
    await expect(first.lookupResources(query)).rejects.toThrow("restricted runtime role");
    await expect(uncached.lookupResources(query)).rejects.toThrow("permission denied");
    await owner.pool.query("GRANT SELECT ON public.dad_authorization_relationship TO lookup_runtime");
    const regranted = await first.lookupResources(query);
    expect(regranted).toEqual(expected);
    expect(regranted).not.toBe(loaded);

    await owner.pool.query(lookupRevisionSchemaMigration.sql);
    const reinstalled = await first.lookupResources(query);
    expect(reinstalled).toEqual(loaded);
    expect(reinstalled).not.toBe(regranted);
    await owner.pool.query(
      "UPDATE public.dad_authorization_relationship SET resource_id = resource_id WHERE namespace = 'first'",
    );
    const mutable = { ...query, subject: { ...query.subject } };
    const pending = first.lookupResources(mutable);
    mutable.subject.id = "outsider";
    const refreshed = await pending;
    expect(refreshed).toEqual(expected);
    await expect(first.lookupResources(mutable)).resolves.toEqual([]);
    const empty = await Promise.all([second.lookupResources(query), second.lookupResources(query)]);
    expect(empty).toEqual([[], []]);
    expect(empty[0]).toBe(empty[1]);

    const writer = await pool.connect();
    try {
      const changes = first.inTransaction(writer);
      await writer.query("BEGIN");
      await changes.deleteRelationships({
        resourceType: grant.resource.type,
        resourceId: grant.resource.id,
        relation: grant.relation,
        subject: grant.subject,
      });
      await expect(changes.lookupResources(query)).resolves.toEqual([]);
      expect(await first.lookupResources(query)).toBe(refreshed);
      await writer.query("ROLLBACK");
      expect(await first.lookupResources(query)).toBe(refreshed);
      await writer.query("BEGIN");
      await writer.query(
        "DELETE FROM public.dad_authorization_relationship WHERE namespace = $1 AND resource_kind = $2",
        ["first", grant.resource.type],
      );
      await writer.query("COMMIT");
      await expect(first.lookupResources(query)).resolves.toEqual([]);
    } finally {
      writer.release();
    }
    await second.writeRelationships(facts);
    const secondLoaded = await second.lookupResources(query);
    expect(secondLoaded).toEqual(expected);
    await owner.pool.query(
      "UPDATE public.dad_authorization_relationship SET namespace = $1 WHERE namespace = $2 AND resource_kind = $3",
      ["first", "second", grant.resource.type],
    );
    await expect(first.lookupResources(query)).resolves.toEqual(expected);
    await expect(second.lookupResources(query)).resolves.toEqual([]);
    await owner.pool.query("TRUNCATE public.dad_authorization_relationship");
    await expect(first.lookupResources(query)).resolves.toEqual([]);

    await owner.pool.query(
      "ALTER TABLE public.dad_authorization_relationship DISABLE TRIGGER dad_lookup_revision_delete",
    );
    await expect(first.lookupResources(query)).rejects.toThrow("restricted runtime role");
    await expect(uncached.lookupResources(query)).resolves.toEqual([]);
  } finally {
    await single?.close();
    await runtime?.close();
    await owner.stop();
  }
}, 45_000);
