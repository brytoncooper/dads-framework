import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";
import { makeChain } from "../test-support/benchmark-chain.js";
import {
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
  type PostgresAccessExecutor,
} from "./index.js";

const samplesPerRun = 1_280;
const runs = 3;

// The hosted runner needed two minutes for seven of eight workloads. This
// test timeout covers setup, warmups, and sampling. Query deadlines are separate.
it("measures warm single checks with ordinary and named Postgres statements", async () => {
  const postgres = await startUnmigratedTestPostgres({
    attributed: false,
    maxConnections: 8,
  });
  try {
    const pool = postgres.pool;
    await pool.query(relationshipSchemaMigration.sql);
    const executor = preparePostgresChecks(pool);
    const worlds = [];
    for (const depth of [0, 2, 8, 16]) {
      const world = await seed(depth, pool, executor);
      worlds.push(world);
    }
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");
    for (const world of worlds) {
      await proveFreshness(world);
      for (const concurrency of [1, 8]) {
        await compare(world, concurrency);
      }
    }
  } finally {
    await postgres.stop();
  }
}, 240_000);

async function seed(
  depth: number,
  pool: PostgresAccessExecutor,
  executor: PostgresAccessExecutor,
) {
  const { model, facts, check } = makeChain(depth, depth === 0 ? 1 : 5_000);
  const namespace = `bench_${String(depth)}`;
  const baseline = new PostgresAuthorization({
    model,
    namespace,
    executor: pool,
  });
  const prepared = new PostgresAuthorization({ model, namespace, executor });
  const isolated = new PostgresAuthorization({
    model,
    namespace: `${namespace}_other`,
    executor,
  });
  await baseline.writeRelationships(facts);
  await isolated.writeRelationships(facts.slice(1, 1_000));
  return { depth, check, baseline, prepared, isolated, revoke: facts[0] };
}

type World = Awaited<ReturnType<typeof seed>>;

async function proveFreshness({
  baseline,
  prepared,
  isolated,
  check,
  revoke,
}: World) {
  if (!revoke) throw new Error("Benchmark fixture omitted a membership tuple");
  for (let warm = 0; warm < 30; warm += 1) {
    expect(await prepared.check(check)).toBe(true);
  }
  expect(await isolated.check(check)).toBe(false);
  expect(
    await prepared.check({
      ...check,
      subject: { ...check.subject, type: "other" },
    }),
  ).toBe(false);
  await baseline.deleteRelationships({
    resourceType: revoke.resource.type,
    resourceId: revoke.resource.id,
    relation: revoke.relation,
  });
  expect(await prepared.check(check)).toBe(false);
  await baseline.writeRelationships([revoke]);
  expect(await prepared.check(check)).toBe(true);
}

async function compare(world: World, concurrency: number) {
  const modes = ["baseline", "prepared"] as const;
  const results: Record<(typeof modes)[number], ReturnType<typeof summary>[]> =
    {
      baseline: [],
      prepared: [],
    };
  for (let run = 0; run < runs; run += 1) {
    const order = run % 2 === 0 ? modes : [...modes].reverse();
    for (const mode of order) {
      const samples = await Promise.all(
        Array.from({ length: concurrency }, (_, lane) =>
          measureLane(world, world[mode], concurrency, run, lane),
        ),
      );
      results[mode].push(summary(samples.flat()));
    }
  }
  console.log(JSON.stringify({ depth: world.depth, concurrency, ...results }));
}

async function measureLane(
  { depth, check }: World,
  backend: PostgresAuthorization,
  concurrency: number,
  run: number,
  lane: number,
) {
  const times: number[] = [];
  for (let sample = -30; sample < samplesPerRun / concurrency; sample += 1) {
    const index = run * samplesPerRun + (sample + 30) * concurrency + lane;
    const allowed = index % 4 !== 0;
    const query = {
      ...check,
      subject: {
        type: index % 8 === 0 ? "other" : check.subject.type,
        id: allowed ? check.subject.id : `denied_${String(index)}`,
      },
      resource: {
        ...check.resource,
        id:
          depth === 0 || index % 4 === 1
            ? check.resource.id
            : `node_${String((index % 4_999) + 1)}`,
      },
    };
    const start = performance.now();
    const decision = await backend.check(query);
    const elapsed = performance.now() - start;
    if (decision !== allowed)
      throw new Error("Unexpected benchmark permission decision");
    if (sample >= 0) times.push(elapsed);
  }
  return times;
}

function summary(samples: number[]) {
  samples.sort((left, right) => left - right);
  return {
    p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  };
}
