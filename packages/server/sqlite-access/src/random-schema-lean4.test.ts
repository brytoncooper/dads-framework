import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AccessIrDefinition,
  type AccessIrRole,
  type AccessIrSubject,
  type AccessIrTerm,
  type AccessModel,
  compileAccessFromIr,
} from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/access/runtime";
import { InMemoryAuthorization } from "@dads-framework/access/testing";
import { expect, it } from "vitest";

import { compileAccessPolicy } from "./policy/compile-access-policy.js";
import { createNodeSqliteExecutor, SqliteAuthorization, sqliteRelationshipSchemaMigration } from "./index.js";

const ORACLE_BIN = path.resolve(
  import.meta.dirname,
  "../../../../formal/access-proofs/.lake/build/bin/dads-access-oracle",
);
const DEFAULT_SCHEMAS = Number(process.env["LEAN_FUZZ_SCHEMAS"] ?? "25");

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

function generateRandomSchema(seed: number): {
  readonly model: AccessModel;
  readonly mutualRecursion: boolean;
} {
  const pick = makeRng(seed * 7_919 + 17);
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
    roleTerm("editor"),
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
      roles: [
        roleDef("owner", [USER_EXP]),
        roleDef("member", [USER_EXP, GROUP_EXP, WILD_EXP]),
        roleDef("banned", [USER_EXP]),
      ],
      permissions: [
        {
          name: "view",
          terms: [
            {
              kind: "excluding",
              term: randomExpr(pick, [roleTerm("owner"), roleTerm("member")], 2, false),
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
              term: randomExpr(pick, [roleTerm("lead"), arrowTerm("org", "view")], 2, false),
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
        roleDef("viewer", [USER_EXP, GROUP_EXP, WILD_EXP]),
        roleDef("editor", [USER_EXP]),
        roleDef("banned", [USER_EXP]),
      ],
      permissions: [
        { name: "p_compound", terms: [randomExpr(pick, itemAtoms, 3, true)] },
        {
          name: "p_scoped",
          terms: [
            pick(3) === 0
              ? scopedBase
              : {
                  kind: "excluding",
                  term: scopedBase,
                  banned: roleTerm("banned"),
                },
          ],
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

function generateWorldWrites(seed: number, nowMs: number, mutualRecursion: boolean) {
  const pick = makeRng(seed * 31_337 + 5);
  const users = ["u0", "u1", "u2"];
  const groups = ["g0", "g1"];
  const orgs = ["o0", "o1"];
  const teams = ["t0", "t1"];
  const items = ["i0", "i1", "i2", "i3"];
  const maybeExpiry = (): { readonly expiresAt?: Date } => {
    const roll = pick(6);
    if (roll === 0) return { expiresAt: new Date(nowMs) };
    if (roll === 1) return { expiresAt: new Date(nowMs - 1) };
    if (roll === 2) return { expiresAt: new Date(nowMs + 1) };
    if (roll === 3) return { expiresAt: new Date(nowMs + 60_000) };
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
        ...maybeExpiry(),
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
        ...maybeExpiry(),
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
        ...maybeExpiry(),
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
    if (pick(3) === 0)
      writes.push({
        resource: { type: "fuzz/item", id: itemId },
        relation: "banned",
        subject: { type: "user", id: pickOne(pick, users, "u0") },
        ...maybeExpiry(),
      });
  }
  return { users, items, rows, writes };
}

it.runIf(existsSync(ORACLE_BIN))(
  "matches Lean 4 oracle across randomized schemas (mutual recursion, multi-scopeColumns, boundary expiry)",
  async () => {
    const nowMs = 1_700_000_000_000;
    const permNames = ["p_compound", "p_scoped", "p_every"] as const;

    for (let seed = 1; seed <= DEFAULT_SCHEMAS; seed += 1) {
      const { model, mutualRecursion } = generateRandomSchema(seed);
      const lowered = compileAccessPolicy(model).model;
      const { users, items, rows, writes } = generateWorldWrites(seed, nowMs, mutualRecursion);

      const db = new DatabaseSync(":memory:");
      try {
        for (const stmt of sqliteRelationshipSchemaMigration.statements) db.exec(stmt);
        db.exec("CREATE TABLE fuzz_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, team_id TEXT NOT NULL);");
        const insertItem = db.prepare("INSERT INTO fuzz_items (id, org_id, team_id) VALUES (?, ?, ?)");
        for (const row of rows) insertItem.run(row.id, row.orgId, row.teamId);

        const sqliteAuth = new SqliteAuthorization({
          model,
          namespace: `rand_${String(seed)}`,
          executor: createNodeSqliteExecutor(db),
          now: () => new Date(nowMs),
        });
        const memoryAuth = new InMemoryAuthorization(model, {
          startTime: nowMs,
        });
        await sqliteAuth.writeRelationships(writes);
        memoryAuth.writeRelationshipsSync(writes);

        const storedRows = db
          .prepare(
            "SELECT resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard, expires_at FROM dad_authorization_relationship",
          )
          .all();
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
          checks: checkQueries.map((query) => ({
            subjectKind: query.subject.type,
            subjectId: query.subject.id,
            resourceKind: query.resource.type,
            resourceId: query.resource.id,
            permission: query.permission,
          })),
          lookups: lookupSpecs,
        });

        expect(memoryAuth.checkManySync(checkQueries)).toEqual(oracle.checks);
        expect(await sqliteAuth.checkMany(checkQueries)).toEqual(oracle.checks);

        for (let index = 0; index < lookupSpecs.length; index += 1) {
          const spec = lookupSpecs[index];
          if (spec?.permission !== "p_scoped") continue;
          const scoped = sqliteAuth.compileFilter({
            subject: { type: spec.subjectKind, id: spec.subjectId },
            resourceType: spec.resourceKind,
            permission: spec.permission,
            idColumn: "item.id",
            scopeColumns: {
              scope_org: "item.org_id",
              scope_team: "item.team_id",
            },
          });
          const filtered = db
            .prepare(`SELECT item.id FROM fuzz_items item WHERE ${scoped.sql} ORDER BY item.id`)
            .all(...scoped.values);
          expect(filtered.map((entry) => String(entry["id"] ?? ""))).toEqual([...(oracle.lookups[index] ?? [])].sort());
        }
      } finally {
        db.close();
      }
    }
  },
  120_000,
);
