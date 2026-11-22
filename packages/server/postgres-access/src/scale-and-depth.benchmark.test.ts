import {
  actor,
  compileAccess,
  emitZed,
  resource,
} from "@dads-framework/access";
import type { RelationshipWrite } from "@dads-framework/authorization";
import {
  createTunedSpiceDbClient,
  startTunedSpiceDb,
  type TunedSpiceDbClient,
  type TunedSpiceDbConsistency,
} from "@dads-framework/authorization/testing";
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

async function startSpice(): Promise<TunedSpiceDbClient> {
  const spice = await startTunedSpiceDb();
  disposers.push(spice.stop);
  return createTunedSpiceDbClient(spice.endpoint, spice.presharedKey);
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

it.runIf(isBenchmark)(
  "benchmarks 100k-row paginated lists (Postgres compileFilter + scopeColumns vs tuned SpiceDB)",
  async () => {
    const user = actor("user");
    const workspace = resource("scale/workspace", {
      roles: { member: user },
      can: ({ member }) => ({ view: member }),
      children: {
        document: {
          inherit: "all",
          roles: { viewer: user },
          can: ({ viewer, parent }) => ({
            view: [parent.view, viewer],
            direct_view: viewer,
          }),
        },
      },
    });
    const model = compileAccess([workspace]);
    const wsType = workspace.wireName;
    const docType = workspace.document.wireName;
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
      CREATE INDEX bench_documents_ws_updated_idx
        ON bench_documents (workspace_id, updated_at DESC, id);
    `);

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
      executor: preparePostgresChecks(pool),
    });
    await pgAuth.writeRelationships(memberWrites);
    await pool.query("VACUUM ANALYZE bench_documents");
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");

    const spice = await startSpice();
    await spice.writeSchema(emitZed(model));
    const docWrites: RelationshipWrite[] = Array.from(
      { length: 100_000 },
      (_, index) => ({
        resource: { type: docType, id: `doc_${String(index + 1)}` },
        relation: docParentRel,
        subject: { type: wsType, id: `ws_${String(index % 200)}` },
      }),
    );
    await spice.writeRelationships([...docWrites, ...memberWrites]);

    const runPgFilter = async (
      subjectId: string,
      expectedCount: number,
      mode: "plain" | "scoped" | "resolved",
    ) => {
      const q = {
        subject: { type: "user", id: subjectId },
        permission: "view",
        resourceType: docType,
        idColumn: "d.id",
        ...(mode === "plain"
          ? {}
          : { scopeColumns: { [docParentRel]: "d.workspace_id" } }),
      };
      const filter =
        mode === "resolved"
          ? await pgAuth.resolveFilter(q)
          : pgAuth.compileFilter(q);
      const sql = `SELECT d.id FROM bench_documents d WHERE ${filter.sql} ORDER BY d.updated_at DESC LIMIT 50`;
      const page = await pool.query<{ id: string }>(sql, [...filter.values]);
      expect(page.rows).toHaveLength(expectedCount);
    };

    const runSpiceDirectLookup = async (
      subjectId: string,
      expectedCount: number,
      mode: TunedSpiceDbConsistency,
    ) => {
      const ids = await spice.lookupResources(
        {
          resourceType: docType,
          permission: "view",
          subject: { type: "user", id: subjectId },
        },
        mode,
      );
      const page = await pool.query<{ id: string }>(
        `SELECT id FROM bench_documents WHERE id = ANY($1::text[]) ORDER BY updated_at DESC LIMIT 50`,
        [ids],
      );
      expect(page.rows).toHaveLength(expectedCount);
    };

    const runSpiceScopedBestPractice = async (
      subjectId: string,
      expectedCount: number,
      mode: TunedSpiceDbConsistency,
    ) => {
      const [wsIds, directDocIds] = await Promise.all([
        spice.lookupResources(
          {
            resourceType: wsType,
            permission: "view",
            subject: { type: "user", id: subjectId },
          },
          mode,
        ),
        spice.lookupResources(
          {
            resourceType: docType,
            permission: "direct_view",
            subject: { type: "user", id: subjectId },
          },
          mode,
        ),
      ]);
      const page = await pool.query<{ id: string }>(
        `SELECT id FROM bench_documents WHERE workspace_id = ANY($1::text[]) OR id = ANY($2::text[]) ORDER BY updated_at DESC LIMIT 50`,
        [wsIds, directDocIds],
      );
      expect(page.rows).toHaveLength(expectedCount);
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
      const directTrials = scenario.userId === "broad_admin" ? 3 : 7;
      console.log(
        JSON.stringify({
          benchmark: "100k_paginated_list",
          scenario: scenario.name,
          pgFilter: await sample(() =>
            runPgFilter(scenario.userId, scenario.expectedPage, "plain"),
          ),
          pgFilterScoped: await sample(() =>
            runPgFilter(scenario.userId, scenario.expectedPage, "scoped"),
          ),
          pgResolveFilter: await sample(() =>
            runPgFilter(scenario.userId, scenario.expectedPage, "resolved"),
          ),
          spiceDirectConsistent: await sample(
            () =>
              runSpiceDirectLookup(
                scenario.userId,
                scenario.expectedPage,
                "fully-consistent",
              ),
            directTrials,
          ),
          spiceDirectCached: await sample(
            () =>
              runSpiceDirectLookup(
                scenario.userId,
                scenario.expectedPage,
                "minimize-latency",
              ),
            directTrials,
          ),
          spiceScopedConsistent: await sample(() =>
            runSpiceScopedBestPractice(
              scenario.userId,
              scenario.expectedPage,
              "fully-consistent",
            ),
          ),
          spiceScopedCached: await sample(() =>
            runSpiceScopedBestPractice(
              scenario.userId,
              scenario.expectedPage,
              "minimize-latency",
            ),
          ),
        }),
      );
    }
  },
  180_000,
);

it.runIf(isBenchmark)(
  "benchmarks deep recursive folder trees (depth 25, 50, 100) and 20-level diamond DAG (tuned SpiceDB max-depth=128)",
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
    const spice = await startSpice();
    await spice.writeSchema(emitZed(model));

    for (const depth of [25, 50, 100]) {
      const namespace = `recursive_${String(depth)}`;
      const subjectId = `alice_d${String(depth)}`;
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
          subject: { type: "user", id: subjectId },
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
      await spice.writeRelationships(writes);

      const leafQuery = {
        resource: { type: fileType, id: `d${String(depth)}_file_0` },
        permission: "view",
        subject: { type: "user", id: subjectId },
      };

      const pgCheckPrepared = await sample(async () => {
        expect(await pgPrepared.check(leafQuery)).toBe(true);
      });
      const pgLookup1kFiles = await sample(async () => {
        expect(
          await pgOrdinary.lookupResources({
            resourceType: fileType,
            permission: "view",
            subject: { type: "user", id: subjectId },
          }),
        ).toHaveLength(1_000);
      });
      const spiceConsistentCheck = await sample(async () => {
        expect(await spice.check(leafQuery, "fully-consistent")).toBe(true);
      });
      const spiceCachedCheck = await sample(async () => {
        expect(await spice.check(leafQuery, "minimize-latency")).toBe(true);
      });
      const spiceLookup1kCached = await sample(async () => {
        expect(
          await spice.lookupResources(
            {
              resourceType: fileType,
              permission: "view",
              subject: { type: "user", id: subjectId },
            },
            "minimize-latency",
          ),
        ).toHaveLength(1_000);
      });

      console.log(
        JSON.stringify({
          benchmark: "recursive_depth",
          depth,
          pgCheckPrepared,
          pgLookup1kFiles,
          spiceConsistentCheck,
          spiceCachedCheck,
          spiceLookup1kCached,
        }),
      );
    }

    const dagNamespace = "diamond_dag_20";
    await pool.query("TRUNCATE dad_authorization_relationship");
    const pgDag = new PostgresAuthorization({
      model,
      namespace: dagNamespace,
      executor: preparePostgresChecks(pool),
    });
    const dagWrites: RelationshipWrite[] = [
      {
        resource: { type: folderType, id: "dag_0_a" },
        relation: "viewer",
        subject: { type: "user", id: "alice" },
      },
      {
        resource: { type: folderType, id: "dag_0_b" },
        relation: "viewer",
        subject: { type: "user", id: "alice" },
      },
    ];
    for (let level = 1; level <= 20; level += 1) {
      for (const branch of ["a", "b"]) {
        for (const parentBranch of ["a", "b"]) {
          dagWrites.push({
            resource: {
              type: folderType,
              id: `dag_${String(level)}_${branch}`,
            },
            relation: "parent",
            subject: {
              type: folderType,
              id: `dag_${String(level - 1)}_${parentBranch}`,
            },
          });
        }
      }
    }
    await pgDag.writeRelationships(dagWrites);
    await pool.query("VACUUM ANALYZE dad_authorization_relationship");
    await spice.writeRelationships(dagWrites);

    const dagQuery = {
      resource: { type: folderType, id: "dag_20_a" },
      permission: "view",
      subject: { type: "user", id: "alice" },
    };
    const pgDagCheck = await sample(async () => {
      expect(await pgDag.check(dagQuery)).toBe(true);
    });
    const spiceDagConsistent = await sample(async () => {
      expect(await spice.check(dagQuery, "fully-consistent")).toBe(true);
    });
    const spiceDagCached = await sample(async () => {
      expect(await spice.check(dagQuery, "minimize-latency")).toBe(true);
    });
    console.log(
      JSON.stringify({
        benchmark: "diamond_dag_1M_paths",
        pgDagCheck,
        spiceDagConsistent,
        spiceDagCached,
      }),
    );
  },
  180_000,
);

it.runIf(isBenchmark)(
  "benchmarks batch checkMany (100 and 1,000 items: Postgres vs single-RPC SpiceDB)",
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
    const spice = await startSpice();
    await spice.writeSchema(emitZed(model));

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
    await spice.writeRelationships(writes);

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
      const spiceSingleRpcConsistent = await sample(async () => {
        const result = await spice.checkManySingleRpc(
          queries,
          "fully-consistent",
        );
        expect(result).toHaveLength(batchSize);
        expect(result[0]).toBe(true);
        expect(result[1]).toBe(false);
      });
      const spiceSingleRpcCached = await sample(async () => {
        const result = await spice.checkManySingleRpc(
          queries,
          "minimize-latency",
        );
        expect(result).toHaveLength(batchSize);
        expect(result[0]).toBe(true);
        expect(result[1]).toBe(false);
      });
      console.log(
        JSON.stringify({
          benchmark: "batch_checkMany",
          batchSize,
          pgBatch,
          spiceSingleRpcConsistent,
          spiceSingleRpcCached,
        }),
      );
    }
  },
  120_000,
);
