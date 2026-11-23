import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type AccessIrDefinition,
  type AccessIrRole,
  type AccessIrSubject,
  type AccessIrTerm,
  type AccessModel,
  compileAccessFromIr,
} from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/spicedb-access";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";

import { compileAccessPolicy } from "./compile-access-policy.js";
import { PostgresAuthorization, preparePostgresChecks, relationshipSchemaMigration } from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);
const DEFAULT_SCHEMAS = Number(process.env["LEAN_FUZZ_SCHEMAS"] ?? "15");

const USER_EXP: AccessIrSubject = {
  kind: "type",
  wireName: "user",
  expiration: true,
};
const WILD_EXP: AccessIrSubject = {
  kind: "wildcard",
  wireName: "user",
  expiration: true,
};
const GROUP_EXP: AccessIrSubject = {
  kind: "userset",
  wireName: "fuzz/group",
  relation: "member",
  expiration: true,
};
const typeSub = (wireName: string): AccessIrSubject => ({
  kind: "type",
  wireName,
});
const roleDef = (name: string, subjects: readonly AccessIrSubject[]): AccessIrRole => ({ name, subjects });
const roleTerm = (name: string): AccessIrTerm => ({ kind: "role", name });
const arrowTerm = (roleName: string, targetPermission: string): AccessIrTerm => ({
  kind: "through",
  roleName,
  targetPermission,
});

function makeRng(seed: number) {
  let state = seed >>> 0;
  return (bound: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % bound;
  };
}

function pickOne<Item>(pick: (bound: number) => number, items: readonly Item[], fallback: Item): Item {
  return items[pick(items.length)] ?? fallback;
}

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
    checks: parsed.checks.map((entry) => Boolean(entry)),
    lookups: parsed.lookups.map((list) => (Array.isArray(list) ? list.map(String) : [])),
  };
}

function randomExpr(
  pick: (bound: number) => number,
  atoms: readonly AccessIrTerm[],
  depth: number,
  allowExclude: boolean,
): AccessIrTerm {
  const fallback = atoms[0] ?? roleTerm("viewer");
  if (depth <= 0 || pick(3) === 0) return pickOne(pick, atoms, fallback);
  const operator = pick(allowExclude ? 4 : 3);
  const left = randomExpr(pick, atoms, depth - 1, allowExclude);
  const right = randomExpr(pick, atoms, depth - 1, allowExclude);
  if (operator === 0) return { kind: "or", terms: [left, right] };
  if (operator === 1) return { kind: "both", left, right };
  if (operator === 2) return { kind: "gated", term: left, condition: right };
  return { kind: "excluding", term: left, banned: right };
}

function buildRandomSchema(seed: number): {
  readonly model: AccessModel;
  readonly mutualRecursion: boolean;
} {
  const pick = makeRng(seed * 7_919 + 10_017);
  const mutualRecursion = pick(2) === 0;
  const parentSubjects = mutualRecursion
    ? [typeSub("fuzz/org"), typeSub("fuzz/node_a"), typeSub("fuzz/node_b")]
    : [typeSub("fuzz/org"), typeSub("fuzz/team"), typeSub("fuzz/folder")];
  const recursiveDefs: AccessIrDefinition[] = mutualRecursion
    ? [
        {
          wireName: "fuzz/node_a",
          roles: [roleDef("link", [typeSub("fuzz/org"), typeSub("fuzz/node_b")]), roleDef("viewer", [USER_EXP])],
          permissions: [
            {
              name: "view",
              terms: [
                {
                  kind: "or",
                  terms: [roleTerm("viewer"), arrowTerm("link", "view")],
                },
              ],
            },
          ],
        },
        {
          wireName: "fuzz/node_b",
          roles: [roleDef("link", [typeSub("fuzz/team"), typeSub("fuzz/node_a")]), roleDef("viewer", [USER_EXP])],
          permissions: [
            {
              name: "view",
              terms: [
                {
                  kind: "or",
                  terms: [roleTerm("viewer"), arrowTerm("link", "view")],
                },
              ],
            },
          ],
        },
      ]
    : [
        {
          wireName: "fuzz/folder",
          roles: [
            roleDef("parent", [typeSub("fuzz/org"), typeSub("fuzz/team"), typeSub("fuzz/folder")]),
            roleDef("viewer", [USER_EXP, GROUP_EXP]),
          ],
          permissions: [
            {
              name: "view",
              terms: [
                {
                  kind: "or",
                  terms: [roleTerm("viewer"), arrowTerm("parent", "view")],
                },
              ],
            },
          ],
        },
      ];
  const itemAtoms: AccessIrTerm[] = [
    roleTerm("viewer"),
    roleTerm("banned"),
    arrowTerm("parent", "view"),
    { kind: "through-all", roleName: "parent", targetPermission: "view" },
    arrowTerm("scope_org", "view"),
    arrowTerm("scope_team", "view"),
  ];
  const scopedBase: AccessIrTerm = {
    kind: "or",
    terms: [arrowTerm("scope_org", "view"), arrowTerm("scope_team", "view"), roleTerm("viewer")],
  };
  const definitions: AccessIrDefinition[] = [
    { wireName: "user", roles: [], permissions: [] },
    {
      wireName: "fuzz/group",
      roles: [roleDef("member", [USER_EXP, WILD_EXP, GROUP_EXP])],
      permissions: [{ name: "read", terms: [roleTerm("member")] }],
    },
    {
      wireName: "fuzz/org",
      roles: [roleDef("owner", [USER_EXP]), roleDef("member", [USER_EXP, GROUP_EXP]), roleDef("banned", [USER_EXP])],
      permissions: [
        {
          name: "view",
          terms: [
            {
              kind: "excluding",
              term: {
                kind: "or",
                terms: [roleTerm("owner"), roleTerm("member")],
              },
              banned: roleTerm("banned"),
            },
          ],
        },
      ],
    },
    {
      wireName: "fuzz/team",
      roles: [roleDef("org", [typeSub("fuzz/org")]), roleDef("lead", [USER_EXP]), roleDef("banned", [USER_EXP])],
      permissions: [
        {
          name: "view",
          terms: [
            {
              kind: "excluding",
              term: {
                kind: "or",
                terms: [roleTerm("lead"), arrowTerm("org", "view")],
              },
              banned: roleTerm("banned"),
            },
          ],
        },
      ],
    },
    ...recursiveDefs,
    {
      wireName: "fuzz/item",
      roles: [
        roleDef("parent", parentSubjects),
        roleDef("scope_org", [typeSub("fuzz/org")]),
        roleDef("scope_team", [typeSub("fuzz/team")]),
        roleDef("viewer", [USER_EXP, WILD_EXP]),
        roleDef("banned", [USER_EXP]),
      ],
      permissions: [
        { name: "p_compound", terms: [randomExpr(pick, itemAtoms, 3, true)] },
        {
          name: "p_scoped",
          terms: [{ kind: "excluding", term: scopedBase, banned: roleTerm("banned") }],
        },
        {
          name: "p_every",
          terms: [
            {
              kind: "through-all",
              roleName: "parent",
              targetPermission: "view",
            },
          ],
        },
      ],
    },
  ];
  return { model: compileAccessFromIr(definitions), mutualRecursion };
}

function generateWrites(seed: number, nowMs: number, mutualRecursion: boolean) {
  const pick = makeRng(seed * 31_337 + 9);
  const users = ["u0", "u1", "u2"];
  const groups = ["g0", "g1"];
  const orgs = ["o0", "o1"];
  const teams = ["t0", "t1"];
  const items = ["i0", "i1", "i2", "i3"];
  const maybeExpiry = (): { readonly expiresAt?: Date } => {
    const roll = pick(5);
    if (roll === 0) return { expiresAt: new Date(nowMs - 60_000) };
    if (roll === 1) return { expiresAt: new Date(nowMs + 3_600_000) };
    return {};
  };
  const writes: RelationshipWrite[] = [];
  for (const groupId of groups) {
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/group", id: groupId },
        relation: "member",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
        ...maybeExpiry(),
      });
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/group", id: groupId },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: pickOne(pick, groups, "g0"),
          relation: "member",
        },
      });
  }
  for (const orgId of orgs) {
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/org", id: orgId },
        relation: "owner",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
        ...maybeExpiry(),
      });
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/org", id: orgId },
        relation: "member",
        subject: {
          type: "fuzz/group",
          id: pickOne(pick, groups, "g0"),
          relation: "member",
        },
        ...maybeExpiry(),
      });
    if (pick(4) === 0)
      writes.push({
        resource: { type: "fuzz/org", id: orgId },
        relation: "banned",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
      });
  }
  for (const teamId of teams) {
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/team", id: teamId },
        relation: "org",
        subject: { type: "fuzz/org", id: pickOne(pick, orgs, "o0") },
      });
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/team", id: teamId },
        relation: "lead",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
      });
  }
  if (mutualRecursion) {
    writes.push(
      {
        resource: { type: "fuzz/node_a", id: "a0" },
        relation: "link",
        subject: { type: "fuzz/node_b", id: "b0" },
      },
      {
        resource: { type: "fuzz/node_b", id: "b0" },
        relation: "link",
        subject: { type: "fuzz/node_a", id: "a0" },
      },
      {
        resource: { type: "fuzz/node_b", id: "b0" },
        relation: "link",
        subject: { type: "fuzz/team", id: pickOne(pick, teams, "t0") },
      },
    );
  } else {
    writes.push(
      {
        resource: { type: "fuzz/folder", id: "f0" },
        relation: "parent",
        subject: { type: "fuzz/org", id: pickOne(pick, orgs, "o0") },
      },
      {
        resource: { type: "fuzz/folder", id: "f1" },
        relation: "parent",
        subject: { type: "fuzz/folder", id: "f0" },
      },
      {
        resource: { type: "fuzz/folder", id: "f0" },
        relation: "parent",
        subject: { type: "fuzz/folder", id: "f1" },
      },
    );
  }
  const rows: {
    readonly id: string;
    readonly orgId: string;
    readonly teamId: string;
  }[] = [];
  for (const itemId of items) {
    const orgId = pickOne(pick, orgs, "o0");
    const teamId = pickOne(pick, teams, "t0");
    rows.push({ id: itemId, orgId, teamId });
    writes.push(
      {
        resource: { type: "fuzz/item", id: itemId },
        relation: "scope_org",
        subject: { type: "fuzz/org", id: orgId },
      },
      {
        resource: { type: "fuzz/item", id: itemId },
        relation: "scope_team",
        subject: { type: "fuzz/team", id: teamId },
      },
    );
    if (pick(3) !== 0)
      writes.push({
        resource: { type: "fuzz/item", id: itemId },
        relation: "parent",
        subject: mutualRecursion ? { type: "fuzz/node_a", id: "a0" } : { type: "fuzz/folder", id: "f1" },
      });
    if (pick(2) === 0)
      writes.push({
        resource: { type: "fuzz/item", id: itemId },
        relation: "viewer",
        subject: {
          type: "user",
          id: pick(5) === 0 ? "*" : pickOne(pick, users, "u0"),
        },
        ...maybeExpiry(),
      });
    if (pick(4) === 0)
      writes.push({
        resource: { type: "fuzz/item", id: itemId },
        relation: "banned",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
      });
  }
  return { users, items, rows, writes };
}

it.runIf(existsSync(ORACLE_BIN))(
  "matches Lean 4 oracle across randomized schemas on live PostgreSQL (multi-scopeColumns & resolveFilter)",
  async () => {
    const postgres = await startUnmigratedTestPostgres({ attributed: false });
    try {
      const pool = postgres.pool;
      await pool.query(relationshipSchemaMigration.sql);
      await pool.query("CREATE TABLE fuzz_items (id text PRIMARY KEY, org_id text NOT NULL, team_id text NOT NULL);");
      const permNames = ["p_compound", "p_scoped", "p_every"] as const;

      for (let seed = 1; seed <= DEFAULT_SCHEMAS; seed += 1) {
        const nowMs = Date.now();
        const namespace = `pg_rand_${String(seed)}`;
        await pool.query("TRUNCATE dad_authorization_relationship, fuzz_items");
        const { model, mutualRecursion } = buildRandomSchema(seed);
        const lowered = compileAccessPolicy(model).model;
        const { users, items, rows, writes } = generateWrites(seed, nowMs, mutualRecursion);

        const pgAuth = new PostgresAuthorization({
          model,
          namespace,
          executor: preparePostgresChecks(pool),
        });
        await pgAuth.writeRelationships(writes);
        for (const row of rows) {
          await pool.query("INSERT INTO fuzz_items (id, org_id, team_id) VALUES ($1, $2, $3)", [
            row.id,
            row.orgId,
            row.teamId,
          ]);
        }

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
        const checkQueries: PermissionQuery[] = users.flatMap((userId) =>
          items.flatMap((itemId) =>
            permNames.map((permission) => ({
              subject: { type: "user", id: userId },
              resource: { type: "fuzz/item", id: itemId },
              permission,
            })),
          ),
        );
        const lookupSpecs = users.flatMap((userId) =>
          permNames.map((permission) => ({
            subjectKind: "user",
            subjectId: userId,
            resourceKind: "fuzz/item",
            permission,
            universe: items,
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
          checks: checkQueries.map((query) => ({
            subjectKind: query.subject.type,
            subjectId: query.subject.id,
            resourceKind: query.resource.type,
            resourceId: query.resource.id,
            permission: query.permission,
          })),
          lookups: lookupSpecs,
        });

        expect(await pgAuth.checkMany(checkQueries)).toEqual(oracle.checks);

        for (let index = 0; index < lookupSpecs.length; index += 1) {
          const spec = lookupSpecs[index];
          if (spec?.permission !== "p_scoped") continue;
          const resolved = await pgAuth.resolveFilter({
            subject: { type: spec.subjectKind, id: spec.subjectId },
            resourceType: spec.resourceKind,
            permission: spec.permission,
            idColumn: "item.id",
            scopeColumns: {
              scope_org: "item.org_id",
              scope_team: "item.team_id",
            },
          });
          const resolvedRows = await pool.query<{ id: string }>(
            `SELECT item.id FROM fuzz_items item WHERE ${resolved.sql} ORDER BY item.id`,
            [...resolved.values],
          );
          expect(resolvedRows.rows.map((entry) => entry.id)).toEqual([...(oracle.lookups[index] ?? [])].sort());
        }
      }
    } finally {
      await postgres.stop();
    }
  },
  120_000,
);
