import {
  actor,
  compileAccess,
  emitZed,
  resource,
} from "@dads-framework/access";
import {
  SpiceDbAuthorization,
  type Authorization,
  type RelationshipWrite,
} from "@dads-framework/authorization";
import { startTestSpiceDb } from "@dads-framework/authorization/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  PostgresAuthorization,
  preparePostgresChecks,
  relationshipSchemaMigration,
} from "./index.js";

const isBenchmark = process.env["VITEST_TIER"] === "benchmark";
const disposers: (() => Promise<void>)[] = [];
let pool: Pool;

async function startFreshSpiceDb() {
  const spice = await startTestSpiceDb();
  disposers.push(spice.stop);
  return {
    consistent: new SpiceDbAuthorization({
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "fully-consistent",
    }),
    minLatency: new SpiceDbAuthorization({
      endpoint: spice.endpoint,
      presharedKey: spice.presharedKey,
      insecure: true,
      consistency: "minimize-latency",
    }),
  };
}

beforeAll(async () => {
  if (!isBenchmark) return;
  const postgres = await startUnmigratedTestPostgres({
    attributed: false,
    maxConnections: 8,
  });
  disposers.push(postgres.stop);
  pool = postgres.pool;
  await pool.query(relationshipSchemaMigration.sql);
}, 90_000);

afterAll(async () => {
  await Promise.all(disposers.map((stop) => stop()));
});

async function sample(work: () => Promise<unknown>, trials = 11) {
  await work();
  const times: number[] = [];
  for (let index = 0; index < trials; index += 1) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  const p95 =
    times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? 0;
  return {
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
  };
}

async function writeSpiceBatches(
  spice: SpiceDbAuthorization,
  writes: readonly RelationshipWrite[],
) {
  for (let offset = 0; offset < writes.length; offset += 1_000) {
    await spice.writeRelationships(writes.slice(offset, offset + 1_000));
  }
}

async function explainPlan(sql: string, values: readonly unknown[]) {
  const result = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    [...values],
  );
  return result.rows.map((row) => row["QUERY PLAN"]).slice(0, 8);
}

it.runIf(isBenchmark)(
  "benchmarks 100k-row paginated compileFilter vs lookupResources (Postgres vs SpiceDB)",
  async () => {
    const user = actor("user");
    const workspace = resource("scale/workspace", {
      roles: { member: user },
      can: ({ member }) => ({ view: member }),
      children: {
        document: {
          inherit: "all",
          roles: { viewer: user },
          can: ({ viewer, parent }) => ({ view: [parent.view, viewer] }),
        },
      },
    });
    const model = compileAccess([workspace]);
    const docType = workspace.document.wireName;
    const wsType = workspace.wireName;
    const docParentRel = Object.keys(workspace.document.roles).find(
      (role) => role !== "viewer",
    );
    if (!docParentRel) throw new Error("Missing parent role on document");
    const namespace = "scale_100k";

    await pool.query("TRUNCATE dad_authorization_relationship");
    await pool.query(`
      DROP TABLE IF EXISTS bench_documents;
      CREATE TABLE bench_documents (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX bench_documents_updated_idx
        ON bench_documents (updated_at DESC, id);
    `);

    // 200 workspaces x 500 docs = 100,000 rows, spread across timestamps
    await pool.query(`
      INSERT INTO bench_documents (id, workspace_id, updated_at)
      SELECT
        'doc_' || g,
        'ws_' || ((g - 1) % 200),
        TIMESTAMPTZ '2026-01-01T00:00:00Z' + (g * INTERVAL '1 second')
      FROM generate_series(1, 100000) AS g
    `);
    await pool.query(
      `
      INSERT INTO dad_authorization_relationship
        (namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard)
      SELECT
        $1, $2, 'doc_' || g, $3, $4, 'ws_' || ((g - 1) % 200), '', false
      FROM generate_series(1, 100000) AS g
    `,
      [namespace, docType, docParentRel, wsType],
    );

    // Sparse user: member of ws_0 (500 visible out of 100,000 = 0.5%)
    // Super-sparse user: direct viewer on 20 docs out of 100,000 = 0.02%
    // Broad admin: member of ws_0..ws_159 (80,000 visible out of 100,000 = 80%)
    const memberWrites: RelationshipWrite[] = [
      {
        resource: { type: wsType, id: "ws_0" },
        relation: "member",
        subject: { type: "user", id: "sparse" },
      },
    ];
    for (let index = 0; index < 20; index += 1) {
      memberWrites.push({
        resource: {
          type: docType,
          id: `doc_${String((index + 1) * 4_500)}`,
        },
        relation: "viewer",
        subject: { type: "user", id: "super_sparse" },
      });
    }
    for (let index = 0; index < 160; index += 1) {
      memberWrites.push({
        resource: { type: wsType, id: `ws_${String(index)}` },
        relation: "member",
        subject: { type: "user", id: "broad_admin" },
      });
    }

    const pgAuth = new PostgresAuthorization({
      model,
      namespace,
      executor: pool,
    });
    await pgAuth.writeRelationships(memberWrites);
    await pool.query("VACUUM ANALYZE bench_documents");
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");

    // Seed matching 100k tuples into SpiceDB
    const spice = await startFreshSpiceDb();
    await spice.consistent.writeSchema(emitZed(model));
    const docWrites: RelationshipWrite[] = Array.from(
      { length: 100_000 },
      (_, index) => ({
        resource: { type: docType, id: `doc_${String(index + 1)}` },
        relation: docParentRel,
        subject: { type: wsType, id: `ws_${String(index % 200)}` },
      }),
    );
    await writeSpiceBatches(spice.consistent, [...docWrites, ...memberWrites]);

    const runPaginatedViaLookup = async (
      auth: Authorization,
      subjectId: string,
      expectedCount: number,
    ) => {
      const ids = await auth.lookupResources({
        resourceType: docType,
        permission: "view",
        subject: { type: "user", id: subjectId },
      });
      const page = await pool.query<{ id: string }>(
        `SELECT id FROM bench_documents WHERE id = ANY($1::text[]) ORDER BY updated_at DESC LIMIT 50`,
        [ids],
      );
      expect(page.rows).toHaveLength(expectedCount);
      return page.rows;
    };

    const runPaginatedViaCompileFilter = async (
      subjectId: string,
      expectedCount: number,
    ) => {
      const filter = pgAuth.compileFilter({
        subject: { type: "user", id: subjectId },
        permission: "view",
        resourceType: docType,
        idColumn: "d.id",
      });
      const sql = `SELECT d.id FROM bench_documents d WHERE ${filter.sql} ORDER BY d.updated_at DESC LIMIT 50`;
      const page = await pool.query<{ id: string }>(sql, [...filter.values]);
      expect(page.rows).toHaveLength(expectedCount);
      return { sql, values: filter.values };
    };

    for (const scenario of [
      { name: "sparse_500_of_100k", userId: "sparse", expectedPage: 50 },
      {
        name: "super_sparse_20_of_100k",
        userId: "super_sparse",
        expectedPage: 20,
      },
      {
        name: "broad_admin_80k_of_100k",
        userId: "broad_admin",
        expectedPage: 50,
      },
    ]) {
      const compiled = await runPaginatedViaCompileFilter(
        scenario.userId,
        scenario.expectedPage,
      );
      const pgCompileFilter = await sample(() =>
        runPaginatedViaCompileFilter(scenario.userId, scenario.expectedPage),
      );
      const pgLookupPlusSql = await sample(() =>
        runPaginatedViaLookup(pgAuth, scenario.userId, scenario.expectedPage),
      );
      const spiceConsistent = await sample(
        () =>
          runPaginatedViaLookup(
            spice.consistent,
            scenario.userId,
            scenario.expectedPage,
          ),
        scenario.userId === "broad_admin" ? 3 : 7,
      );
      const spiceMinLatency = await sample(
        () =>
          runPaginatedViaLookup(
            spice.minLatency,
            scenario.userId,
            scenario.expectedPage,
          ),
        scenario.userId === "broad_admin" ? 3 : 7,
      );
      const plan = await explainPlan(compiled.sql, compiled.values);
      console.log(
        JSON.stringify({
          benchmark: "100k_paginated_list",
          scenario: scenario.name,
          pgCompileFilter,
          pgLookupPlusSql,
          spiceConsistent,
          spiceMinLatency,
          planHead: plan,
        }),
      );
    }
  },
  180_000,
);

it.runIf(isBenchmark)(
  "benchmarks deep recursive folder trees (depth 25, 50, 100) and 20-level diamond DAG",
  async () => {
    const user = actor("user");
    const folder = resource("tree/folder", {
      recursive: true,
      roles: { viewer: user },
      can: ({ viewer }) => ({ view: viewer }),
      children: {
        file: {
          inherit: "all",
          roles: { viewer: user },
          can: ({ viewer, parent }) => ({ view: [parent.view, viewer] }),
        },
      },
    });
    const model = compileAccess([folder]);
    const folderType = folder.wireName;
    const fileType = folder.file.wireName;
    const fileParentRel = Object.keys(folder.file.roles).find(
      (role) => role !== "viewer",
    );
    if (!fileParentRel) throw new Error("Missing parent role on file");
    const spice = await startFreshSpiceDb();
    await spice.consistent.writeSchema(emitZed(model));

    for (const depth of [25, 50, 100]) {
      const namespace = `recursive_${String(depth)}`;
      await pool.query("TRUNCATE dad_authorization_relationship");
      const pgOrdinary = new PostgresAuthorization({
        model,
        namespace,
        executor: pool,
      });
      const pgPrepared = new PostgresAuthorization({
        model,
        namespace,
        executor: preparePostgresChecks(pool),
      });

      const writes: RelationshipWrite[] = [
        {
          resource: { type: folderType, id: `d${String(depth)}_f0` },
          relation: "viewer",
          subject: { type: "user", id: "alice" },
        },
      ];
      for (let level = 1; level <= depth; level += 1) {
        writes.push({
          resource: {
            type: folderType,
            id: `d${String(depth)}_f${String(level)}`,
          },
          relation: "parent",
          subject: {
            type: folderType,
            id: `d${String(depth)}_f${String(level - 1)}`,
          },
        });
      }
      for (let index = 0; index < 1_000; index += 1) {
        writes.push({
          resource: {
            type: fileType,
            id: `d${String(depth)}_file_${String(index)}`,
          },
          relation: fileParentRel,
          subject: {
            type: folderType,
            id: `d${String(depth)}_f${String(depth)}`,
          },
        });
      }

      await pgOrdinary.writeRelationships(writes);
      await pool.query("VACUUM ANALYZE dad_authorization_relationship");
      await writeSpiceBatches(spice.consistent, writes);

      const leafQuery = {
        resource: { type: fileType, id: `d${String(depth)}_file_0` },
        permission: "view",
        subject: { type: "user", id: "alice" },
      };

      const pgCheckOrdinary = await sample(async () => {
        expect(await pgOrdinary.check(leafQuery)).toBe(true);
      });
      const pgCheckPrepared = await sample(async () => {
        expect(await pgPrepared.check(leafQuery)).toBe(true);
      });
      const pgLookup = await sample(async () => {
        expect(
          await pgOrdinary.lookupResources({
            resourceType: fileType,
            permission: "view",
            subject: { type: "user", id: "alice" },
          }),
        ).toHaveLength(1_000);
      });

      const trySpice = async (auth: SpiceDbAuthorization) => {
        try {
          return await sample(async () => {
            expect(await auth.check(leafQuery)).toBe(true);
          });
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message.slice(0, 120)
                : String(error),
          };
        }
      };

      console.log(
        JSON.stringify({
          benchmark: "recursive_depth",
          depth,
          pgCheckOrdinary,
          pgCheckPrepared,
          pgLookup1kFiles: pgLookup,
          spiceConsistentCheck: await trySpice(spice.consistent),
          spiceMinLatencyCheck: await trySpice(spice.minLatency),
        }),
      );
    }

    // 20-level diamond DAG: 2^20 = 1,048,576 distinct paths through 42 folder nodes
    const dagNamespace = "diamond_dag_20";
    await pool.query("TRUNCATE dad_authorization_relationship");
    const pgDag = new PostgresAuthorization({
      model,
      namespace: dagNamespace,
      executor: preparePostgresChecks(pool),
    });
    const dagWrites: RelationshipWrite[] = [
      {
        resource: { type: "tree/folder", id: "dag_0_a" },
        relation: "viewer",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: "tree/folder", id: "dag_0_b" },
        relation: "viewer",
        subject: { type: "user", id: "alice" },
      },
    ];
    for (let level = 1; level <= 20; level += 1) {
      for (const branch of ["a", "b"]) {
        for (const parentBranch of ["a", "b"]) {
          dagWrites.push({
            resource: {
              type: "tree/folder",
              id: `dag_${String(level)}_${branch}`,
            },
            relation: "parent",
            subject: {
              type: "tree/folder",
              id: `dag_${String(level - 1)}_${parentBranch}`,
            },
          });
        }
      }
    }
    await pgDag.writeRelationships(dagWrites);
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");
    await writeSpiceBatches(spice.consistent, dagWrites);

    const dagQuery = {
      resource: { type: "tree/folder", id: "dag_20_a" },
      permission: "view",
      subject: { type: "user", id: "alice" },
    };
    const pgDagCheck = await sample(async () => {
      expect(await pgDag.check(dagQuery)).toBe(true);
    });
    const spiceDagConsistent = await sample(async () => {
      expect(await spice.consistent.check(dagQuery)).toBe(true);
    });
    const spiceDagMinLatency = await sample(async () => {
      expect(await spice.minLatency.check(dagQuery)).toBe(true);
    });
    console.log(
      JSON.stringify({
        benchmark: "diamond_dag_1M_paths",
        pgDagCheck,
        spiceDagConsistent,
        spiceDagMinLatency,
      }),
    );
  },
  180_000,
);

it.runIf(isBenchmark)(
  "benchmarks high-volume batch checkMany (100 and 1,000 items)",
  async () => {
    const user = actor("user");
    const workspace = resource("batch/workspace", {
      roles: { member: user },
      can: ({ member }) => ({ view: member }),
      children: {
        item: { inherit: "all" },
      },
    });
    const model = compileAccess([workspace]);
    const wsType = workspace.wireName;
    const itemType = workspace.item.wireName;
    const itemParentRel = Object.keys(workspace.item.roles)[0];
    if (!itemParentRel) throw new Error("Missing parent role on item");
    const namespace = "batch_check_many";
    await pool.query("TRUNCATE dad_authorization_relationship");
    const spice = await startFreshSpiceDb();
    await spice.consistent.writeSchema(emitZed(model));

    const writes: RelationshipWrite[] = [
      {
        resource: { type: wsType, id: "ws_allowed" },
        relation: "member",
        subject: { type: "user", id: "alice" },
      },
    ];
    for (let index = 0; index < 1_000; index += 1) {
      writes.push({
        resource: { type: itemType, id: `item_${String(index)}` },
        relation: itemParentRel,
        subject: {
          type: wsType,
          id: index % 2 === 0 ? "ws_allowed" : "ws_denied",
        },
      });
    }
    const pgAuth = new PostgresAuthorization({
      model,
      namespace,
      executor: preparePostgresChecks(pool),
    });
    await pgAuth.writeRelationships(writes);
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");
    await writeSpiceBatches(spice.consistent, writes);

    for (const batchSize of [100, 1_000]) {
      const queries = Array.from({ length: batchSize }, (_, index) => ({
        resource: { type: itemType, id: `item_${String(index)}` },
        permission: "view",
        subject: { type: "user", id: "alice" },
      }));
      const pgBatch = await sample(async () => {
        const result = await pgAuth.checkMany(queries);
        expect(result).toHaveLength(batchSize);
        expect(result[0]).toBe(true);
        expect(result[1]).toBe(false);
      });
      const spiceBatchConsistent = await sample(async () => {
        const result = await spice.consistent.checkMany(queries);
        expect(result).toHaveLength(batchSize);
      });
      const spiceBatchMinLatency = await sample(async () => {
        const result = await spice.minLatency.checkMany(queries);
        expect(result).toHaveLength(batchSize);
      });
      console.log(
        JSON.stringify({
          benchmark: "batch_checkMany",
          batchSize,
          pgBatch,
          spiceBatchConsistent,
          spiceBatchMinLatency,
        }),
      );
    }
  },
  120_000,
);
