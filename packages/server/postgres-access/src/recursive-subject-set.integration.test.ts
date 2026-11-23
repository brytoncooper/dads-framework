import { actor, compileAccess, resource, roleToken } from "@dads-framework/access";
import type { PermissionQuery, RelationshipWrite } from "@dads-framework/access/runtime";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { expect, it } from "vitest";

import { PostgresAuthorization, relationshipSchemaMigration } from "./index.js";

const depths = [32, 128, 1_024, 10_000];
const user = actor("user");
const member = roleToken("soak/group", "member", user.handle);
const group = resource("soak/group", {
  roles: { member: [user, member] },
});
const document = resource("soak/document", {
  roles: { viewer: group.roles.member },
  can: ({ viewer }) => ({ view: viewer }),
});
const model = compileAccess([user, group, document]);
const subjectActor = { type: user.wireName, id: "actor" };
const outsider = { type: user.wireName, id: "outsider" };
const docResource = { type: document.wireName, id: "document" };
const permission = document.can.view.permissionName;

it.skipIf(process.env["POSTGRES_ACCESS_DEEP_SOAK"] !== "1").each([
  { statistics: "before ANALYZE", refreshStatistics: false },
  { statistics: "after ANALYZE", refreshStatistics: true },
])(
  "checks and discovers access through up to 10,000 nested group memberships $statistics",
  async ({ statistics, refreshStatistics }) => {
    const postgres = await startUnmigratedTestPostgres();
    try {
      await postgres.pool.query(relationshipSchemaMigration.sql);
      await postgres.pool.query("ALTER TABLE dad_authorization_relationship SET (autovacuum_enabled = false)");
      const client = await postgres.pool.connect();
      try {
        await client.query("SET statement_timeout = '4900ms'");
        for (const depth of depths) {
          const adapter = new PostgresAuthorization({
            model,
            namespace: `recursive_subject_set_${String(depth)}`,
            executor: client,
          });
          const started = performance.now();
          const midpoint = await seedChain(adapter, depth);
          if (refreshStatistics) await client.query("ANALYZE dad_authorization_relationship");
          await proveChain(adapter, depth, midpoint);
          console.log(
            JSON.stringify({
              statistics,
              depth,
              totalMs: performance.now() - started,
            }),
          );
        }
      } finally {
        client.release();
      }
    } finally {
      await postgres.stop();
    }
  },
  90_000,
);

async function seedChain(adapter: PostgresAuthorization, depth: number) {
  const links = Array.from({ length: depth }, (_, index) => ({
    resource: groupResource(index + 1),
    relation: member.roleName,
    subject: groupMembership(index),
  }));
  const midpoint = links[Math.floor(depth / 2)];
  if (midpoint === undefined) throw new Error("Expected a midpoint membership");
  await adapter.writeRelationships([
    {
      resource: groupResource(0),
      relation: member.roleName,
      subject: subjectActor,
    },
    ...links,
    {
      resource: docResource,
      relation: document.roles.viewer.roleName,
      subject: groupMembership(depth),
    },
  ]);
  return midpoint;
}

async function proveChain(adapter: PostgresAuthorization, depth: number, midpoint: RelationshipWrite) {
  const check: PermissionQuery = {
    resource: docResource,
    permission,
    subject: subjectActor,
  };
  const denied = { ...check, subject: outsider };
  const lookup = {
    resourceType: docResource.type,
    permission,
    subject: subjectActor,
  };
  await expect(adapter.check(check), `allow at depth ${String(depth)}`).resolves.toBe(true);
  await expect(adapter.checkMany([denied, check, denied]), `batch at depth ${String(depth)}`).resolves.toEqual([
    false,
    true,
    false,
  ]);
  await expect(adapter.lookupResources(lookup), `lookup at depth ${String(depth)}`).resolves.toEqual([docResource.id]);
  await adapter.deleteRelationships({
    resourceType: midpoint.resource.type,
    resourceId: midpoint.resource.id,
    relation: midpoint.relation,
    subject: midpoint.subject,
  });
  await expect(adapter.check(check), `revoke at depth ${String(depth)}`).resolves.toBe(false);
  await expect(adapter.checkMany([denied, check, denied]), `revoked batch at depth ${String(depth)}`).resolves.toEqual([
    false,
    false,
    false,
  ]);
  await expect(adapter.lookupResources(lookup), `revoked lookup at depth ${String(depth)}`).resolves.toEqual([]);
  await adapter.writeRelationships([midpoint]);
  await expect(adapter.check(check), `restore at depth ${String(depth)}`).resolves.toBe(true);
  await expect(adapter.lookupResources(lookup), `restored lookup at depth ${String(depth)}`).resolves.toEqual([
    docResource.id,
  ]);
}

function groupResource(index: number): RelationshipWrite["resource"] {
  return { type: group.wireName, id: `group_${String(index)}` };
}

function groupMembership(index: number): RelationshipWrite["subject"] {
  return { ...groupResource(index), relation: member.roleName };
}
