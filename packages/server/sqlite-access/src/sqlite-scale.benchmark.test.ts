import { DatabaseSync } from "node:sqlite";
import { actor, compileAccess, resource } from "@dads-framework/access";
import type { RelationshipWrite } from "@dads-framework/access/runtime";
import { expect, it } from "vitest";

import {
  createNodeSqliteExecutor,
  SqliteAuthorization,
  sqliteRelationshipSchemaMigration,
} from "./index.js";

const isBenchmark = process.env["VITEST_TIER"] === "benchmark";

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

function openBenchDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA cache_size = -64000;");
  for (const statement of sqliteRelationshipSchemaMigration.statements) {
    db.exec(statement);
  }
  return db;
}

it.runIf(isBenchmark)(
  "benchmarks SQLite 100k-row paginated compileFilter, deep recursive trees, diamond DAG, and checkMany",
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
    const model = compileAccess([workspace, folder]);
    const wsType = workspace.wireName;
    const docType = workspace.document.wireName;
    const docParentRel = Object.keys(workspace.document.roles).find(
      (role) => role !== "viewer",
    );
    const folderType = folder.wireName;
    const fileType = folder.file.wireName;
    const fileParentRel = Object.keys(folder.file.roles).find(
      (role) => role !== "viewer",
    );
    if (!docParentRel || !fileParentRel) {
      throw new Error("Missing parent role on child resource");
    }
    const db = openBenchDatabase();

    try {
      // --- 1. 100k rows paginated compileFilter ---
      db.exec(`
        CREATE TABLE bench_documents (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX bench_documents_updated_idx
          ON bench_documents (updated_at DESC, id);
      `);
      const insertDoc = db.prepare(
        "INSERT INTO bench_documents (id, workspace_id, updated_at) VALUES (?, ?, ?)",
      );
      const insertRel = db.prepare(`
        INSERT INTO dad_authorization_relationship
          (namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard)
        VALUES (?, ?, ?, ?, ?, ?, '', 0)
      `);
      db.exec("BEGIN");
      for (let index = 1; index <= 100_000; index += 1) {
        const wsId = `ws_${String((index - 1) % 200)}`;
        const docId = `doc_${String(index)}`;
        insertDoc.run(docId, wsId, index);
        insertRel.run("scale_100k", docType, docId, docParentRel, wsType, wsId);
      }
      db.exec("COMMIT");

      const executor = createNodeSqliteExecutor(db);
      const auth = new SqliteAuthorization({
        model,
        namespace: "scale_100k",
        executor,
      });
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
      await auth.writeRelationships(memberWrites);
      db.exec("ANALYZE;");

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
        const filter = auth.compileFilter({
          subject: { type: "user", id: scenario.userId },
          permission: "view",
          resourceType: docType,
          idColumn: "d.id",
        });
        const sql = `SELECT d.id FROM bench_documents d WHERE ${filter.sql} ORDER BY d.updated_at DESC LIMIT 50`;
        const stmt = db.prepare(sql);
        const compileFilterResult = await sample(() => {
          const rows = stmt.all(...filter.values);
          expect(rows).toHaveLength(scenario.expectedPage);
          return Promise.resolve();
        });
        console.log(
          JSON.stringify({
            engine: "sqlite",
            benchmark: "100k_paginated_list",
            scenario: scenario.name,
            sqliteCompileFilter: compileFilterResult,
          }),
        );
      }

      // --- 2. Deep recursive trees (25, 50, 100) + 20-level diamond DAG ---
      for (const depth of [25, 50, 100]) {
        const treeAuth = new SqliteAuthorization({
          model,
          namespace: `recursive_${String(depth)}`,
          executor,
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
        await treeAuth.writeRelationships(writes);

        const leafQuery = {
          resource: { type: fileType, id: `d${String(depth)}_file_0` },
          permission: "view",
          subject: { type: "user", id: "alice" },
        };
        const checkMs = await sample(async () => {
          expect(await treeAuth.check(leafQuery)).toBe(true);
        });
        const lookupMs = await sample(async () => {
          expect(
            await treeAuth.lookupResources({
              resourceType: fileType,
              permission: "view",
              subject: { type: "user", id: "alice" },
            }),
          ).toHaveLength(1_000);
        });
        console.log(
          JSON.stringify({
            engine: "sqlite",
            benchmark: "recursive_depth",
            depth,
            checkMs,
            lookup1kFilesMs: lookupMs,
          }),
        );
      }

      const dagAuth = new SqliteAuthorization({
        model,
        namespace: "diamond_dag_20",
        executor,
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
      await dagAuth.writeRelationships(dagWrites);
      const dagCheckMs = await sample(async () => {
        expect(
          await dagAuth.check({
            resource: { type: folderType, id: "dag_20_a" },
            permission: "view",
            subject: { type: "user", id: "alice" },
          }),
        ).toBe(true);
      });
      console.log(
        JSON.stringify({
          engine: "sqlite",
          benchmark: "diamond_dag_1M_paths",
          dagCheckMs,
        }),
      );

      // --- 3. Batch checkMany (100 and 1,000 items) ---
      for (const batchSize of [100, 1_000]) {
        const queries = Array.from({ length: batchSize }, (_, index) => ({
          resource: { type: docType, id: `doc_${String(index + 1)}` },
          permission: "view",
          subject: { type: "user", id: "sparse" },
        }));
        const batchMs = await sample(async () => {
          const result = await auth.checkMany(queries);
          expect(result).toHaveLength(batchSize);
        });
        console.log(
          JSON.stringify({
            engine: "sqlite",
            benchmark: "batch_checkMany",
            batchSize,
            batchMs,
          }),
        );
      }
    } finally {
      db.close();
    }
  },
  120_000,
);
