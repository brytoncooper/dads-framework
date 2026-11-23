import { emitZed } from "@dads-framework/access";
import {
  SpiceDbAuthorization,
  type Authorization,
  type PermissionQuery,
} from "@dads-framework/spicedb-access";
import { startTestSpiceDb } from "@dads-framework/spicedb-access/testing";
import { createPostgresConnection } from "@dads-framework/postgres";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { it } from "vitest";
import { makeChain } from "../test-support/benchmark-chain.js";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
} from "./index.js";

const samplesPerRound = 1_280;
const rounds = 3;
const leaves = 5_000;

it("compares point checks on matching PostgreSQL and SpiceDB graphs", async () => {
  const postgres = await startUnmigratedTestPostgres({
    attributed: false,
    maxConnections: 1,
  });
  try {
    await postgres.pool.query(relationshipSchemaMigration.sql);
    for (const depth of [2, 8, 16]) {
      await compareDepth(depth, postgres);
    }
  } finally {
    await postgres.stop();
  }
}, 120_000);

async function compareDepth(
  depth: number,
  setup: Awaited<ReturnType<typeof startUnmigratedTestPostgres>>,
) {
  const spice = await startTestSpiceDb();
  const postgres = createPostgresConnection(
    { schema: {}, connectionString: setup.connectionString, maxConnections: 8 },
    {
      error: () => {
        throw new Error("Benchmark PostgreSQL connection failed");
      },
    },
  );
  try {
    const { model, facts, check } = makeChain(depth, leaves);
    const namespace = `bench_${String(depth)}`;
    const membership = facts[0];
    if (!membership) throw new Error("Benchmark graph omitted its membership");
    const postgresWriter = new PostgresAuthorization({
      model,
      namespace,
      executor: setup.pool,
    });
    const options = {
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    } as const;
    const spiceWriter = new SpiceDbAuthorization(options);
    await setup.pool.query("TRUNCATE dad_authorization_relationship");
    await postgresWriter.writeRelationships(facts);
    await setup.pool.query("VACUUM ANALYZE dad_authorization_relationship");
    await spiceWriter.writeSchema(emitZed(model));
    for (let offset = 0; offset < facts.length; offset += 1_000) {
      await spiceWriter.writeRelationships(facts.slice(offset, offset + 1_000));
    }

    const engines = {
      postgres: new PostgresAuthorization({
        model,
        namespace,
        executor: preparePostgresChecks(postgres.pool),
      }),
      spice: new SpiceDbAuthorization(options),
    };
    const names = ["postgres", "spice"] as const;
    const coldOrder = depth === 8 ? [...names].reverse() : names;
    for (const name of coldOrder) {
      console.log(
        JSON.stringify({
          depth,
          name,
          firstCheckMs: await timedCheck(engines[name], check, true),
        }),
      );
    }
    for (const concurrency of [1, 8]) {
      for (let round = 0; round < rounds; round += 1) {
        const order = round % 2 === 0 ? names : [...names].reverse();
        for (const name of order) {
          const result = await sample(engines[name], check, concurrency, round);
          console.log(
            JSON.stringify({ depth, name, concurrency, round, ...result }),
          );
        }
      }
    }

    for (const [writer, reader] of [
      [postgresWriter, engines.postgres],
      [spiceWriter, engines.spice],
    ] as const) {
      await writer.deleteRelationships({
        resourceType: membership.resource.type,
        resourceId: membership.resource.id,
        relation: membership.relation,
      });
      await timedCheck(reader, check, false);
      await writer.writeRelationships([membership]);
      await timedCheck(reader, check, true);
    }
  } finally {
    await Promise.all([postgres.close(), spice.stop()]);
  }
}

async function sample(
  engine: Authorization,
  check: PermissionQuery,
  concurrency: number,
  round: number,
) {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let warmup = 0; warmup < 30; warmup += 1) {
        await timedCheck(engine, check, true);
      }
    }),
  );
  const started = performance.now();
  const timings = await Promise.all(
    Array.from({ length: concurrency }, async (_, lane) => {
      const samples: number[] = [];
      for (let index = lane; index < samplesPerRound; index += concurrency) {
        const offset = round * samplesPerRound + index;
        const allowed = (offset + Math.floor(offset / 8)) % 4 !== 0;
        const query = {
          ...check,
          subject: {
            ...check.subject,
            id: allowed ? check.subject.id : `denied_${String(offset)}`,
          },
          resource: {
            ...check.resource,
            id: `node_${String((offset % (leaves - 1)) + 1)}`,
          },
        };
        samples.push(await timedCheck(engine, query, allowed));
      }
      return samples;
    }),
  );
  const elapsed = performance.now() - started;
  const sorted = timings.flat().sort((left, right) => left - right);
  return {
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    checksPerSecond: (samplesPerRound * 1_000) / elapsed,
  };
}

async function timedCheck(
  engine: Authorization,
  query: PermissionQuery,
  expected: boolean,
) {
  const start = performance.now();
  const decision = await engine.check(query);
  const elapsed = performance.now() - start;
  if (decision !== expected) throw new Error("Unexpected permission decision");
  return elapsed;
}
