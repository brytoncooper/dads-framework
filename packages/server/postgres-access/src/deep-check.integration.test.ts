import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";

import { PostgresAuthorization, relationshipSchemaMigration } from "./index.js";
import { makeChain } from "../test-support/benchmark-chain.js";

it("checks deep arrows without timing out under the ordinary query deadline", async () => {
  const postgres = await startUnmigratedTestPostgres();
  try {
    await postgres.pool.query(relationshipSchemaMigration.sql);
    const client = await postgres.pool.connect();
    try {
      await client.query("SET statement_timeout = '4900ms'");
      const { model, facts, check } = makeChain(16, 5_000);
      const authorization = new PostgresAuthorization({
        model,
        namespace: "deep_check",
        executor: client,
      });
      await authorization.writeRelationships(facts);

      const wrongActor = {
        ...check,
        subject: { ...check.subject, id: "other" },
      };
      const wrongLeaf = {
        ...check,
        resource: { ...check.resource, id: "missing" },
      };
      await expect(authorization.check(check)).resolves.toBe(true);
      await expect(authorization.check(wrongActor)).resolves.toBe(false);
      await expect(authorization.check(wrongLeaf)).resolves.toBe(false);
      await expect(authorization.checkMany([wrongActor, check, wrongLeaf, check])).resolves.toEqual([
        false,
        true,
        false,
        true,
      ]);
    } finally {
      client.release();
    }
  } finally {
    await postgres.stop();
  }
}, 30_000);
