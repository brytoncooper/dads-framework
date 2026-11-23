import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";
import { model } from "../test-support/parity-world.js";
import { compileAccessPolicy } from "./compile-access-policy.js";
import { relationshipSchemaMigration } from "./index.js";
import { readDecisionFlag } from "./postgres-response.js";
import { compilePostgresCheck } from "./policy/compile-postgres-policy.js";
import { compileSharedPointCheck } from "./policy/compile-shared-point-check.js";
import type { NormalizedPermissionCheck } from "./policy/policy-model.js";

const noteKind = "parity/note";
const folderKind = "parity/folder";
const teamKind = "parity/team";
const userKind = "user";
type Edge = readonly [string, string, string, string, string, string?, boolean?];

it("matches forward checks on varying graphs, raw edges, and revocations", async () => {
  const postgres = await startUnmigratedTestPostgres({ attributed: false });
  try {
    const client = await postgres.pool.connect();
    const { model: policy } = compileAccessPolicy(model);
    try {
      await client.query("SET statement_timeout = '4900ms'");
      await client.query(relationshipSchemaMigration.sql);
      for (const seed of [7, 19, 33, 57, 71, 97]) {
        const namespace = `random_${String(seed)}`;
        for (const edge of randomEdges(seed)) {
          await insert(namespace, edge);
        }
        for (const id of ["node_0", "node_1", "node_2", "node_3", "missing"]) {
          for (const actor of ["actor_0", "actor_1", "unrelated"]) {
            await compare(namespace, check(id, actor));
          }
        }
      }

      const namespace = "raw";
      for (const edge of rawEdges) await insert(namespace, edge);
      const point = check("target", "actor_0");
      expect(await compare(namespace, point)).toBe(true);
      await insert(namespace, [noteKind, "target", "restricted", userKind, "actor_0"]);
      expect(await compare(namespace, point)).toBe(false);
      await client.query(
        "DELETE FROM dad_authorization_relationship WHERE namespace = $1 AND relation = 'restricted'",
        [namespace],
      );
      expect(await compare(namespace, point)).toBe(true);
      await client.query(
        "DELETE FROM dad_authorization_relationship WHERE namespace = $1 AND relation = 'member' AND subject_kind = 'user'",
        [namespace],
      );
      expect(await compare(namespace, point)).toBe(false);
      await insert(namespace, ["raw_team", "same", "member", userKind, "actor_0"]);
      expect(await compare(namespace, point)).toBe(true);

      const definition = policy.permissions.find(
        (permission) => permission.entity === noteKind && permission.wireName === "view",
      );
      if (!definition) throw new Error("Missing test permission");
      const wide = {
        ...policy,
        permissions: [
          ...policy.permissions,
          {
            ...definition,
            wireName: "wide",
            expression: {
              kind: "any-of" as const,
              expressions: Array.from({ length: 80 }, () => definition.expression),
            },
          },
        ],
      };
      const dispatched = compilePostgresCheck(wide, namespace, {
        ...point,
        permission: "wide",
      });
      expect(dispatched.canPrepare).toBe(false);
      expect(dispatched.text).toContain("point_policy_");
      expect(Buffer.byteLength(dispatched.text)).toBeLessThan(10_000);
      expect(readDecisionFlag((await client.query<{ allowed: unknown }>(dispatched)).rows[0])).toBe(true);
    } finally {
      client.release();
    }

    async function insert(
      namespace: string,
      [kind, id, relation, subjectKind, subjectId, subjectRelation = "", wildcard = false]: Edge,
    ) {
      await client.query(
        `INSERT INTO dad_authorization_relationship
          (namespace, resource_kind, resource_id, relation, subject_kind, subject_id, subject_relation, subject_is_wildcard)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING`,
        [namespace, kind, id, relation, subjectKind, subjectId, subjectRelation, wildcard],
      );
    }

    async function compare(namespace: string, request: NormalizedPermissionCheck) {
      const ordinary = compilePostgresCheck(policy, namespace, request);
      const compact = compileSharedPointCheck(policy, namespace, request);
      expect(ordinary.text).not.toContain("point_policy_");
      const expected = readDecisionFlag((await client.query<{ allowed: unknown }>(ordinary)).rows[0]);
      const actual = readDecisionFlag((await client.query<{ allowed: unknown }>(compact)).rows[0]);
      expect(actual).toBe(expected);
      return actual;
    }
  } finally {
    await postgres.stop();
  }
}, 30_000);

function check(id: string, actor: string): NormalizedPermissionCheck {
  return {
    resource: { type: noteKind, id },
    subject: { type: userKind, id: actor },
    permission: "view",
  };
}

const rawEdges: readonly Edge[] = [
  [noteKind, "target", "folder", "raw_folder", "same"],
  [noteKind, "target", "shared", userKind, "", "", true],
  ["raw_folder", "same", "team", "raw_team", "head"],
  ["raw_team", "head", "member", "raw_team", "same", "member"],
  ["raw_team", "same", "member", "raw_team", "head", "member"],
  ["raw_team", "same", "member", userKind, "actor_0"],
  [folderKind, "same", "team", teamKind, "same"],
  [teamKind, "same", "member", userKind, "unrelated"],
];

function randomEdges(seed: number): readonly Edge[] {
  let state = seed;
  function choose(bound: number) {
    state = (state * 48_271) % 2_147_483_647;
    return state % bound;
  }
  const node = (index: number) => `node_${String(index)}`;
  const result: Edge[] = [];
  for (let index = 0; index < 4; index += 1) {
    const id = node(index);
    result.push(
      [teamKind, id, "member", userKind, `actor_${String(choose(2))}`],
      [folderKind, id, "team", teamKind, node(choose(4))],
      [folderKind, id, "viewer", teamKind, node(choose(4)), "member"],
      [noteKind, id, "folder", folderKind, node(choose(4))],
      [noteKind, id, "folder", folderKind, node(choose(4))],
    );
    if (choose(3) !== 0) result.push([noteKind, id, "shared", userKind, "", "", true]);
    if (choose(3) === 0) result.push([noteKind, id, "restricted", userKind, "actor_0"]);
  }
  return result;
}
