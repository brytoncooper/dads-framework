import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { actor, allOf, anyOf, compileAccess, every, resource, roleToken } from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/access/runtime";
import { expect, it } from "vitest";

import { compileAccessPolicy } from "./policy/compile-access-policy.js";
import { createNodeSqliteExecutor, SqliteAuthorization, sqliteRelationshipSchemaMigration } from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);

function callLeanOracle(payload: unknown): {
  readonly checks: readonly boolean[];
  readonly lookups: readonly (readonly string[])[];
} {
  const stdout = execFileSync(ORACLE_BIN, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("checks" in parsed) ||
    !("lookups" in parsed) ||
    !Array.isArray(parsed.checks) ||
    !Array.isArray(parsed.lookups)
  ) {
    throw new Error("Unexpected Lean 4 oracle output shape");
  }
  return {
    checks: parsed.checks.map((v) => Boolean(v)),
    lookups: parsed.lookups.map((arr) => (Array.isArray(arr) ? arr.map(String) : [])),
  };
}

function makeRng(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
}

function buildAdversarialSchema() {
  const user = actor("user");
  const groupMemberRef = roleToken("fuzz/group", "member", user.handle);
  const group = resource("fuzz/group", {
    roles: {
      member: [user.expiring, user.anyone.expiring, groupMemberRef],
    },
    can: ({ member }) => ({ read: member }),
  });
  const workspace = resource("fuzz/workspace", {
    roles: {
      owner: user.expiring,
      member: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
      banned: user,
    },
    can: ({ owner, member, banned }) => ({
      view: anyOf(owner, member).unless(banned),
    }),
  });
  const folder = resource("fuzz/folder", {
    parents: [workspace],
    recursive: true,
    roles: {
      viewer: [user.expiring, group.roles.member.expiring],
    },
    can: ({ parents, viewer }) => ({
      view: anyOf(viewer, parents.view),
    }),
  });
  const document = resource("fuzz/document", {
    parents: [workspace, folder],
    roles: {
      scope_ws: workspace,
      viewer: [user.expiring, group.roles.member.expiring, user.anyone.expiring],
      approver: user,
      banned: user,
    },
    can: ({ parents, scope_ws, viewer, approver, banned }) => ({
      view: anyOf(parents.view, viewer).unless(banned),
      strict_view: every(parents).view,
      publish: allOf(viewer, approver).unless(banned),
      scoped_view: anyOf(scope_ws.view, viewer).unless(banned),
    }),
  });
  return compileAccess([user, group, workspace, folder, document]);
}

function serializeExpr(expr: unknown): unknown {
  return expr;
}

it.runIf(existsSync(ORACLE_BIN))(
  "matches formally verified Lean 4 oracle across 25 randomized cyclic worlds on SQLite",
  async () => {
    const model = buildAdversarialSchema();
    const lowered = compileAccessPolicy(model).model;
    const nowMs = 1_700_000_000_000;
    const users = ["u0", "u1", "u2", "u3"];
    const groups = ["g0", "g1", "g2"];
    const workspaces = ["w0", "w1", "w2"];
    const folders = ["f0", "f1", "f2", "f3"];
    const docs = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const perms = ["view", "strict_view", "publish", "scoped_view"] as const;
    let totalQueriesChecked = 0;

    for (let seed = 1; seed <= 25; seed += 1) {
      const pick = makeRng(seed * 97);
      const db = new DatabaseSync(":memory:");
      try {
        for (const stmt of sqliteRelationshipSchemaMigration.statements) {
          db.exec(stmt);
        }
        db.exec("CREATE TABLE fuzz_docs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);");
        const auth = new SqliteAuthorization({
          model,
          namespace: `sqlite_fuzz_${String(seed)}`,
          executor: createNodeSqliteExecutor(db),
          now: () => new Date(nowMs),
        });

        const maybeExpiry = (): { readonly expiresAt?: Date } => {
          const r = pick(5);
          if (r === 0) return { expiresAt: new Date(nowMs - 60_000) };
          if (r === 1) return { expiresAt: new Date(nowMs + 3_600_000) };
          return {};
        };
        const writes: RelationshipWrite[] = [];
        for (const g of groups) {
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/group", id: g },
              relation: "member",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
              ...maybeExpiry(),
            });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/group", id: g },
              relation: "member",
              subject: {
                type: "fuzz/group",
                id: groups[pick(groups.length)] ?? "g0",
                relation: "member",
              },
            });
          if (pick(6) === 0)
            writes.push({
              resource: { type: "fuzz/group", id: g },
              relation: "member",
              subject: { type: "user", id: "*" },
              ...maybeExpiry(),
            });
        }
        for (const w of workspaces) {
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/workspace", id: w },
              relation: "owner",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
              ...maybeExpiry(),
            });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/workspace", id: w },
              relation: "member",
              subject: {
                type: "fuzz/group",
                id: groups[pick(groups.length)] ?? "g0",
                relation: "member",
              },
              ...maybeExpiry(),
            });
          if (pick(5) === 0)
            writes.push({
              resource: { type: "fuzz/workspace", id: w },
              relation: "banned",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
            });
        }
        for (const f of folders) {
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/folder", id: f },
              relation: "parent",
              subject: {
                type: "fuzz/workspace",
                id: workspaces[pick(workspaces.length)] ?? "w0",
              },
            });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/folder", id: f },
              relation: "parent",
              subject: {
                type: "fuzz/folder",
                id: folders[pick(folders.length)] ?? "f0",
              },
            });
          if (pick(3) === 0)
            writes.push({
              resource: { type: "fuzz/folder", id: f },
              relation: "viewer",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
              ...maybeExpiry(),
            });
        }
        const insDoc = db.prepare("INSERT INTO fuzz_docs (id, workspace_id) VALUES (?, ?)");
        for (const d of docs) {
          const ws = workspaces[pick(workspaces.length)] ?? "w0";
          insDoc.run(d, ws);
          writes.push({
            resource: { type: "fuzz/document", id: d },
            relation: "scope_ws",
            subject: { type: "fuzz/workspace", id: ws },
          });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/document", id: d },
              relation: "parent",
              subject: { type: "fuzz/workspace", id: ws },
            });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/document", id: d },
              relation: "parent",
              subject: {
                type: "fuzz/folder",
                id: folders[pick(folders.length)] ?? "f0",
              },
            });
          if (pick(2) === 0)
            writes.push({
              resource: { type: "fuzz/document", id: d },
              relation: "viewer",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
              ...maybeExpiry(),
            });
          if (pick(3) === 0)
            writes.push({
              resource: { type: "fuzz/document", id: d },
              relation: "approver",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
            });
          if (pick(4) === 0)
            writes.push({
              resource: { type: "fuzz/document", id: d },
              relation: "banned",
              subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
            });
        }
        await auth.writeRelationships(writes);

        const storedRows = db
          .prepare(
            "SELECT resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at FROM dad_authorization_relationship",
          )
          .all();

        const checkQueries: PermissionQuery[] = [];
        for (const u of users) {
          for (const d of docs) {
            for (const p of perms) {
              checkQueries.push({
                subject: { type: "user", id: u },
                resource: { type: "fuzz/document", id: d },
                permission: p,
              });
            }
          }
        }
        const lookupSpecs = users.flatMap((u) =>
          perms.map((p) => ({
            subjectKind: "user",
            subjectId: u,
            resourceKind: "fuzz/document",
            permission: p,
            universe: docs,
          })),
        );

        const oracle = callLeanOracle({
          model: {
            relations: lowered.relations,
            permissions: lowered.permissions.map((p) => ({
              entity: p.entity,
              wireName: p.wireName,
              expression: serializeExpr(p.expression),
            })),
          },
          tuples: storedRows.map((row) => ({
            resourceKind: String(row["resource_kind"] ?? ""),
            resourceId: String(row["resource_id"] ?? ""),
            relation: String(row["relation"] ?? ""),
            subjectKind: String(row["subject_kind"] ?? ""),
            subjectId: String(row["subject_id"] ?? ""),
            subjectRelation: String(row["subject_relation"] ?? ""),
            subjectIsWildcard: Number(row["subject_is_wildcard"] ?? 0) === 1,
            expiresAt: row["expires_at"] === null || row["expires_at"] === undefined ? null : Number(row["expires_at"]),
          })),
          now: nowMs,
          checks: checkQueries.map((q) => ({
            subjectKind: q.subject.type,
            subjectId: q.subject.id,
            resourceKind: q.resource.type,
            resourceId: q.resource.id,
            permission: q.permission,
          })),
          lookups: lookupSpecs,
        });

        const sqliteBatch = await auth.checkMany(checkQueries);
        expect(sqliteBatch).toEqual(oracle.checks);
        totalQueriesChecked += sqliteBatch.length;

        for (let i = 0; i < lookupSpecs.length; i += 1) {
          const spec = lookupSpecs[i];
          const expectedIds = [...(oracle.lookups[i] ?? [])].sort();
          if (!spec) continue;
          const lookup = [
            ...(await auth.lookupResources({
              subject: { type: spec.subjectKind, id: spec.subjectId },
              resourceType: spec.resourceKind,
              permission: spec.permission,
            })),
          ].sort();
          expect(lookup).toEqual(expectedIds);

          const plain = auth.compileFilter({
            subject: { type: spec.subjectKind, id: spec.subjectId },
            resourceType: spec.resourceKind,
            permission: spec.permission,
            idColumn: "d.id",
          });
          const plainRows = db
            .prepare(`SELECT d.id FROM fuzz_docs d WHERE ${plain.sql} ORDER BY d.id`)
            .all(...plain.values);
          expect(plainRows.map((r) => String(r["id"] ?? ""))).toEqual(expectedIds);

          if (spec.permission === "scoped_view") {
            const scoped = auth.compileFilter({
              subject: { type: spec.subjectKind, id: spec.subjectId },
              resourceType: spec.resourceKind,
              permission: spec.permission,
              idColumn: "d.id",
              scopeColumns: { scope_ws: "d.workspace_id" },
            });
            const scopedRows = db
              .prepare(`SELECT d.id FROM fuzz_docs d WHERE ${scoped.sql} ORDER BY d.id`)
              .all(...scoped.values);
            expect(scopedRows.map((r) => String(r["id"] ?? ""))).toEqual(expectedIds);
          }
          totalQueriesChecked += 2;
        }
      } finally {
        db.close();
      }
    }

    console.log(
      JSON.stringify({
        lean4DifferentialOracle: "sqlite",
        worlds: 25,
        totalQueriesVerified: totalQueriesChecked,
        mismatches: 0,
      }),
    );
  },
  60_000,
);
