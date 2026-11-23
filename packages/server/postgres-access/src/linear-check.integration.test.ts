import { emitZed } from "@dads-framework/access";
import {
  SpiceDbAuthorization,
  type Authorization,
  type PermissionQuery,
  type RelationshipWrite,
} from "@dads-framework/spicedb-access";
import { startTestSpiceDb } from "@dads-framework/spicedb-access/testing";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";
import { makeChain } from "../test-support/benchmark-chain.js";
import { PostgresAuthorization, preparePostgresChecks, relationshipSchemaMigration } from "./index.js";

it("checks linear policies against wide, duplicate, wildcard and cyclic data", async () => {
  const postgres = await startUnmigratedTestPostgres({ attributed: false });
  try {
    const spice = await startTestSpiceDb();
    try {
      const { model, facts, check } = makeChain(8, 1, "usersets");
      const fixture = branchingFacts(facts);
      const client = await postgres.pool.connect();
      try {
        await client.query("SET statement_timeout = '4900ms'");
        await client.query(relationshipSchemaMigration.sql);
        const prepared = preparePostgresChecks(client);
        const queryCheck = prepared.queryCheck?.bind(prepared);
        if (queryCheck === undefined) throw new Error("Expected named checks");
        let preparedChecks = 0;
        let unnamedChecks = 0;
        const native = new PostgresAuthorization({
          model,
          namespace: "linear",
          executor: {
            query(query) {
              if ("kind" in query && query.kind === "check") unnamedChecks += 1;
              return prepared.query(query);
            },
            queryCheck(query) {
              preparedChecks += 1;
              return queryCheck(query);
            },
          },
        });
        const baseline = new SpiceDbAuthorization({
          endpoint: spice.endpoint,
          presharedKey: spice.presharedKey,
          insecure: true,
          consistency: "fully-consistent",
        });
        await baseline.writeSchema(emitZed(model));
        for (const engine of [native, baseline]) {
          await install(engine, fixture);
        }

        const request = (id: string, actor = "actor"): PermissionQuery => ({
          ...check,
          resource: { ...check.resource, id },
          subject: { ...check.subject, id: actor },
        });
        await expect(native.check(request("wide", "private"))).resolves.toBe(false);
        expect(preparedChecks).toBe(1);
        expect(unnamedChecks).toBe(1);
        await expect(native.check(request("public", "public-user"))).resolves.toBe(true);
        expect(preparedChecks).toBe(2);
        expect(unnamedChecks).toBe(1);
        const queries = [
          request("wide", "private"),
          request("wide"),
          request("diamond"),
          request("public", "public-user"),
          request("missing"),
          request("wide"),
        ];
        await prove(native, queries, [false, true, true, true, false, true]);
        await prove(baseline, queries, [false, true, true, true, false, true]);

        const member = facts[0];
        if (member === undefined) throw new Error("Expected terminal membership");
        const terminal = {
          ...check,
          resource: { ...member.resource, id: "nested" },
        };
        await expect(
          native.checkMany([terminal, ...queries, { ...terminal, subject: { ...terminal.subject, id: "private" } }]),
        ).resolves.toEqual([true, false, true, true, true, false, true, false]);
        await native.writeRelationships(cyclicFacts(member));
        for (const engine of [native, baseline]) {
          const filter = {
            resourceType: member.resource.type,
            resourceId: "nested",
            relation: member.relation,
            subjectId: "actor",
          };
          await engine.deleteRelationships(filter);
          await prove(
            engine,
            [request("wide"), request("parent"), request("public", "public-user")],
            [false, false, true],
          );
          await engine.writeRelationships([{ ...member, resource: { ...member.resource, id: "nested" } }]);
          await prove(engine, [request("wide"), request("diamond")], [true, true]);
        }
      } finally {
        client.release();
      }
    } finally {
      await spice.stop();
    }
  } finally {
    await postgres.stop();
  }
}, 60_000);

async function prove(engine: Authorization, queries: readonly PermissionQuery[], expected: readonly boolean[]) {
  const points = [];
  for (const query of queries) points.push(await engine.check(query));
  expect(points).toEqual(expected);
  if (!engine.checkMany) throw new Error("Benchmark engine omitted batch checks");
  expect(await engine.checkMany(queries)).toEqual(expected);
}

function branchingFacts(chain: readonly RelationshipWrite[]): readonly RelationshipWrite[] {
  const first = chain[0];
  const root = chain.at(-1);
  const parent = chain.at(-2);
  if (!first || !root || !parent) throw new Error("Expected a chain fixture");
  const group = first.resource.type;
  return [
    ...chain.slice(1),
    { ...first, resource: { type: group, id: "nested" } },
    {
      ...first,
      subject: { type: group, id: "nested", relation: first.relation },
    },
    {
      ...first,
      resource: { type: group, id: "public" },
      subject: { ...first.subject, id: "*" },
    },
    ...chain.slice(1).map((edge) => ({
      ...edge,
      resource: { ...edge.resource, id: "public" },
      subject: { ...edge.subject, id: "public" },
    })),
    { ...root, resource: { ...root.resource, id: "diamond" } },
    {
      ...root,
      resource: { ...root.resource, id: "diamond" },
      subject: { ...root.subject, id: "duplicate-parent" },
    },
    { ...parent, resource: { ...parent.resource, id: "duplicate-parent" } },
    ...Array.from({ length: 5_000 }, (_, index) => ({
      ...root,
      resource: { ...root.resource, id: "wide" },
      subject: { ...root.subject, id: `missing_${String(index)}` },
    })),
    {
      ...root,
      resource: { ...root.resource, id: "wide" },
      subject: { ...root.subject, id: "zz-last" },
    },
    { ...parent, resource: { ...parent.resource, id: "zz-last" } },
  ];
}

function cyclicFacts(member: RelationshipWrite): readonly RelationshipWrite[] {
  const type = member.resource.type;
  const relation = member.relation;
  return [
    { ...member, subject: { type, id: "cycle-a", relation } },
    {
      ...member,
      resource: { type, id: "cycle-a" },
      subject: { type, id: "cycle-b", relation },
    },
    {
      ...member,
      resource: { type, id: "cycle-b" },
      subject: { type, id: "cycle-a", relation },
    },
  ];
}

async function install(engine: Authorization, rows: readonly RelationshipWrite[]) {
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    await engine.writeRelationships(rows.slice(offset, offset + 1_000));
  }
}
