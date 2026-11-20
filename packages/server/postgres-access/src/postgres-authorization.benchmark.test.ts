import { emitZed } from "@dads-framework/access";
import {
  SpiceDbAuthorization,
  type Authorization,
  type PermissionQuery,
} from "@dads-framework/authorization";
import { startTestSpiceDb } from "@dads-framework/authorization/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresAuthorization, relationshipSchemaMigration } from "./index.js";
import { makeChain } from "../test-support/benchmark-chain.js";

const disposers: (() => Promise<void>)[] = [];
let client: Awaited<ReturnType<typeof preparePostgres>>;
let spice: Awaited<ReturnType<typeof startTestSpiceDb>>;

beforeAll(async () => {
  client = await preparePostgres();
  spice = await startTestSpiceDb();
  disposers.push(spice.stop);
}, 90_000);

async function preparePostgres() {
  const postgres = await startUnmigratedTestPostgres();
  disposers.push(postgres.stop);
  await postgres.pool.query(relationshipSchemaMigration.sql);
  const connected = await postgres.pool.connect();
  disposers.unshift(() => {
    connected.release();
    return Promise.resolve();
  });
  await connected.query("SET statement_timeout = '4900ms'");
  return connected;
}

afterAll(async () => {
  await Promise.all(disposers.map((stop) => stop()));
});

it.runIf(process.env["VITEST_TIER"] === "benchmark")(
  "measures chain checks and large ID lookups",
  async () => {
    for (const [depth, size] of [
      [2, 500],
      [8, 5_000],
      [16, 5_000],
    ]) {
      if (depth === undefined || size === undefined)
        throw new Error("Benchmark scenario is incomplete");
      const { model, facts, check } = makeChain(depth, size);
      const adapter = new PostgresAuthorization({
        model,
        namespace: `benchmark_${depth}`,
        executor: client,
      });
      const vendor = new SpiceDbAuthorization({
        endpoint: spice.endpoint,
        presharedKey: spice.presharedKey,
        insecure: true,
        consistency: "fully-consistent",
      });
      await vendor.writeSchema(emitZed(model));
      await adapter.writeRelationships(facts);
      for (let offset = 0; offset < facts.length; offset += 1_000) {
        await vendor.writeRelationships(facts.slice(offset, offset + 1_000));
      }
      const result = {
        depth,
        size,
        postgres: await measure(adapter, check, size),
        spiceDb: await measure(vendor, check, size),
      };
      console.log(JSON.stringify(result));
    }
  },
  120_000,
);

async function measure(
  authorization: Authorization,
  check: PermissionQuery,
  size: number,
) {
  const lookup = {
    resourceType: check.resource.type,
    permission: check.permission,
    subject: check.subject,
  };
  return {
    checkMs: await measured(async () => {
      expect(await authorization.check(check)).toBe(true);
    }),
    lookupMs: await measured(async () => {
      expect(await authorization.lookupResources(lookup)).toHaveLength(size);
    }),
  };
}

async function measured(work: () => Promise<unknown>) {
  try {
    await work();
    return await sample(work);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      ![
        "Query read timeout",
        "canceling statement due to statement timeout",
      ].includes(error.message)
    )
      throw error;
    return { timedOut: true };
  }
}

async function sample(work: () => Promise<unknown>) {
  const times: number[] = [];
  for (let trial = 0; trial < 15; trial += 1) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return { median: times[7], p95: times[14] };
}
