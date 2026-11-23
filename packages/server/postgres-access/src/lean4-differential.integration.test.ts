import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { actor, allOf, anyOf, compileAccess, every, resource, roleToken } from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/spicedb-access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";

import { compileAccessPolicy } from "./compile-access-policy.js";
import { PostgresAuthorization, preparePostgresChecks, relationshipSchemaMigration } from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);

type OracleOutput = {
  readonly checks: readonly boolean[];
  readonly lookups: readonly (readonly string[])[];
};

function callLeanOracle(payload: unknown): OracleOutput {
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

function generateWorld(seed: number, nowMs: number) {
  const pick = makeRng(seed);
  const users = ["u0", "u1", "u2", "u3"];
  const groups = ["g0", "g1", "g2"];
  const workspaces = ["w0", "w1", "w2"];
  const folders = ["f0", "f1", "f2", "f3"];
  const docs = ["d0", "d1", "d2", "d3", "d4", "d5"];
  const docWorkspace = new Map<string, string>();
  const writes: RelationshipWrite[] = [];

  const maybeExpiry = (): { readonly expiresAt?: Date } => {
    const r = pick(5);
    if (r === 0) return { expiresAt: new Date(nowMs - 60_000) }; // expired
    if (r === 1) return { expiresAt: new Date(nowMs + 3_600_000) }; // active future
    return {};
  };
  const pushWrite = (w: RelationshipWrite) => {
    writes.push(w);
  };

  // Random group memberships including cycles (g0 -> g1 -> g0)
  for (const g of groups) {
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/group", id: g },
        relation: "member",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/group", id: g },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: groups[pick(groups.length)] ?? "g0",
          relation: "member",
        },
      });
    }
    if (pick(6) === 0) {
      pushWrite({
        resource: { type: "fuzz/group", id: g },
        relation: "member",
        subject: { type: "user", id: "*" },
        ...maybeExpiry(),
      });
    }
  }

  // Random workspace owners, members (direct + group + wildcard), bans
  for (const w of workspaces) {
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/workspace", id: w },
        relation: "owner",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/workspace", id: w },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: groups[pick(groups.length)] ?? "g0",
          relation: "member",
        },
        ...maybeExpiry(),
      });
    }
    if (pick(5) === 0) {
      pushWrite({
        resource: { type: "fuzz/workspace", id: w },
        relation: "banned",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
  }

  // Random recursive folder graph (intentionally permits cycles & diamonds!)
  for (const f of folders) {
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/folder", id: f },
        relation: "parent",
        subject: {
          type: "fuzz/workspace",
          id: workspaces[pick(workspaces.length)] ?? "w0",
        },
      });
    }
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/folder", id: f },
        relation: "parent",
        subject: {
          type: "fuzz/folder",
          id: folders[pick(folders.length)] ?? "f0",
        },
      });
    }
    if (pick(3) === 0) {
      pushWrite({
        resource: { type: "fuzz/folder", id: f },
        relation: "viewer",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
  }

  // Documents with unique scope_ws FK + polymorphic parents + direct viewer/approver/banned
  for (const d of docs) {
    const ws = workspaces[pick(workspaces.length)] ?? "w0";
    docWorkspace.set(d, ws);
    pushWrite({
      resource: { type: "fuzz/document", id: d },
      relation: "scope_ws",
      subject: { type: "fuzz/workspace", id: ws },
    });
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/document", id: d },
        relation: "parent",
        subject: { type: "fuzz/workspace", id: ws },
      });
    }
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/document", id: d },
        relation: "parent",
        subject: {
          type: "fuzz/folder",
          id: folders[pick(folders.length)] ?? "f0",
        },
      });
    }
    if (pick(2) === 0) {
      pushWrite({
        resource: { type: "fuzz/document", id: d },
        relation: "viewer",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
        ...maybeExpiry(),
      });
    }
    if (pick(3) === 0) {
      pushWrite({
        resource: { type: "fuzz/document", id: d },
        relation: "approver",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
    if (pick(4) === 0) {
      pushWrite({
        resource: { type: "fuzz/document", id: d },
        relation: "banned",
        subject: { type: "user", id: users[pick(users.length)] ?? "u0" },
      });
    }
  }

  return { users, docs, docWorkspace, writes };
}

it.runIf(existsSync(ORACLE_BIN))(
  "matches formally verified Lean 4 oracle across 15 randomized cyclic worlds on live PostgreSQL",
  async () => {
    const model = buildAdversarialSchema();
    const lowered = compileAccessPolicy(model).model;
    const postgres = await startUnmigratedTestPostgres({ attributed: false });
    try {
      const pool = postgres.pool;
      await pool.query(relationshipSchemaMigration.sql);
      await pool.query(`
        CREATE TABLE fuzz_docs (
          id text PRIMARY KEY,
          workspace_id text NOT NULL
        );
      `);

      const perms = ["view", "strict_view", "publish", "scoped_view"] as const;
      let totalQueriesChecked = 0;

      for (let seed = 1; seed <= 15; seed += 1) {
        const nowMs = Date.now();
        const namespace = `lean_fuzz_${String(seed)}`;
        await pool.query("TRUNCATE dad_authorization_relationship, fuzz_docs");
        const { users, docs, docWorkspace, writes } = generateWorld(seed, nowMs);

        const pgAuth = new PostgresAuthorization({
          model,
          namespace,
          executor: preparePostgresChecks(pool),
        });
        await pgAuth.writeRelationships(writes);
        for (const [docId, wsId] of docWorkspace) {
          await pool.query("INSERT INTO fuzz_docs (id, workspace_id) VALUES ($1, $2)", [docId, wsId]);
        }

        // Read back deduplicated stored tuples from Postgres so Lean sees the exact
        // post-upsert table state (including resolved expiresAt timestamps).
        const storedRows = await pool.query<{
          resource_kind: string;
          resource_id: string;
          relation: string;
          subject_kind: string;
          subject_id: string;
          subject_relation: string;
          subject_is_wildcard: boolean;
          expires_at_ms: string | null;
        }>(
          `SELECT resource_kind, resource_id, relation, subject_kind, subject_id,
                  subject_relation, subject_is_wildcard,
                  CASE WHEN expires_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000)::bigint::text END AS expires_at_ms
           FROM dad_authorization_relationship WHERE namespace = $1`,
          [namespace],
        );

        const pgNowRow = await pool.query<{ now_ms: string }>(
          "SELECT FLOOR(EXTRACT(EPOCH FROM now()) * 1000)::bigint::text AS now_ms",
        );
        const oracleNow = Number(pgNowRow.rows[0]?.now_ms ?? String(nowMs));

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
            permissions: lowered.permissions,
          },
          tuples: storedRows.rows.map((row) => ({
            resourceKind: row.resource_kind,
            resourceId: row.resource_id,
            relation: row.relation,
            subjectKind: row.subject_kind,
            subjectId: row.subject_id,
            subjectRelation: row.subject_relation,
            subjectIsWildcard: row.subject_is_wildcard,
            expiresAt: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
          })),
          now: oracleNow,
          checks: checkQueries.map((q) => ({
            subjectKind: q.subject.type,
            subjectId: q.subject.id,
            resourceKind: q.resource.type,
            resourceId: q.resource.id,
            permission: q.permission,
          })),
          lookups: lookupSpecs,
        });

        // 1. Compare checkMany against Lean 4 oracle
        const pgBatch = await pgAuth.checkMany(checkQueries);
        expect(pgBatch).toEqual(oracle.checks);
        totalQueriesChecked += pgBatch.length;

        // 2. Compare individual check (spot-check every 3rd query for speed)
        for (let i = 0; i < checkQueries.length; i += 3) {
          const q = checkQueries[i];
          if (!q) continue;
          const single = await pgAuth.check(q);
          expect(single).toBe(oracle.checks[i]);
          totalQueriesChecked += 1;
        }

        // 3. Compare lookupResources, compileFilter, scopeColumns, and resolveFilter
        for (let i = 0; i < lookupSpecs.length; i += 1) {
          const spec = lookupSpecs[i];
          const expectedIds = [...(oracle.lookups[i] ?? [])].sort();
          if (!spec) continue;
          const pgLookup = [
            ...(await pgAuth.lookupResources({
              subject: { type: spec.subjectKind, id: spec.subjectId },
              resourceType: spec.resourceKind,
              permission: spec.permission,
            })),
          ].sort();
          expect(pgLookup).toEqual(expectedIds);

          const plainFilter = pgAuth.compileFilter({
            subject: { type: spec.subjectKind, id: spec.subjectId },
            resourceType: spec.resourceKind,
            permission: spec.permission,
            idColumn: "d.id",
          });
          const plainRows = await pool.query<{ id: string }>(
            `SELECT d.id FROM fuzz_docs d WHERE ${plainFilter.sql} ORDER BY d.id`,
            [...plainFilter.values],
          );
          expect(plainRows.rows.map((r) => r.id)).toEqual(expectedIds);

          if (spec.permission === "scoped_view") {
            const scopedFilter = pgAuth.compileFilter({
              subject: { type: spec.subjectKind, id: spec.subjectId },
              resourceType: spec.resourceKind,
              permission: spec.permission,
              idColumn: "d.id",
              scopeColumns: { scope_ws: "d.workspace_id" },
            });
            const scopedRows = await pool.query<{ id: string }>(
              `SELECT d.id FROM fuzz_docs d WHERE ${scopedFilter.sql} ORDER BY d.id`,
              [...scopedFilter.values],
            );
            expect(scopedRows.rows.map((r) => r.id)).toEqual(expectedIds);

            const resolvedFilter = await pgAuth.resolveFilter({
              subject: { type: spec.subjectKind, id: spec.subjectId },
              resourceType: spec.resourceKind,
              permission: spec.permission,
              idColumn: "d.id",
              scopeColumns: { scope_ws: "d.workspace_id" },
            });
            const resolvedRows = await pool.query<{ id: string }>(
              `SELECT d.id FROM fuzz_docs d WHERE ${resolvedFilter.sql} ORDER BY d.id`,
              [...resolvedFilter.values],
            );
            expect(resolvedRows.rows.map((r) => r.id)).toEqual(expectedIds);
          }
          totalQueriesChecked += 2;
        }
      }

      console.log(
        JSON.stringify({
          lean4DifferentialOracle: "postgres",
          worlds: 15,
          totalQueriesVerified: totalQueriesChecked,
          mismatches: 0,
        }),
      );
    } finally {
      await postgres.stop();
    }
  },
  90_000,
);
