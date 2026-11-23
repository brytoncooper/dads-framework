import { randomUUID } from "node:crypto";
import { v1 } from "@authzed/authzed-node";
import type {
  PermissionQuery,
  RelationshipWrite,
  ResourceLookup,
} from "@dads-framework/access/runtime";
import {
  testSpiceDbMemoryLimitGb,
  type TestSpiceDb,
} from "./start-test-spice-db.js";

const SPICE_DB_IMAGE = "authzed/spicedb:v1.57.0";
const SPICE_DB_GRPC_PORT = 50051;

export type TunedSpiceDbConsistency = "fully-consistent" | "minimize-latency";

export type TunedSpiceDbClient = {
  readonly writeSchema: (zed: string) => Promise<void>;
  readonly writeRelationships: (
    writes: readonly RelationshipWrite[],
  ) => Promise<void>;
  readonly check: (
    query: PermissionQuery,
    consistency: TunedSpiceDbConsistency,
  ) => Promise<boolean>;
  readonly checkManySingleRpc: (
    queries: readonly PermissionQuery[],
    consistency: TunedSpiceDbConsistency,
  ) => Promise<readonly boolean[]>;
  readonly lookupResources: (
    query: ResourceLookup,
    consistency: TunedSpiceDbConsistency,
  ) => Promise<readonly string[]>;
};

/**
 * Starts a production-configured SpiceDB container (`serve`, not `serve-testing`)
 * with in-memory datastore, 50% dispatch cache, 5s quantization window, and
 * `--dispatch-max-depth=128` for fair head-to-head benchmarks.
 */
export async function startTunedSpiceDb(): Promise<TestSpiceDb> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const presharedKey = `dads-bench-${randomUUID()}`;
  const container = await new GenericContainer(SPICE_DB_IMAGE)
    .withCommand([
      "serve",
      "--datastore-engine=memory",
      `--grpc-preshared-key=${presharedKey}`,
      "--dispatch-cache-enabled=true",
      "--dispatch-cache-max-cost=50%",
      "--dispatch-max-depth=128",
      "--ns-cache-enabled=true",
      "--datastore-revision-quantization-interval=5s",
      "--http-enabled=false",
    ])
    .withExposedPorts(SPICE_DB_GRPC_PORT)
    .withResourcesQuota({ memory: testSpiceDbMemoryLimitGb() })
    .withWaitStrategy(Wait.forLogMessage(/grpc server started serving/))
    .start();
  return {
    endpoint: `${container.getHost()}:${String(container.getMappedPort(SPICE_DB_GRPC_PORT))}`,
    presharedKey,
    stop: () => container.stop().then(() => undefined),
  };
}

/**
 * Raw v1 gRPC benchmark client supporting true `minimize_latency` reads and
 * single-RPC `CheckBulkPermissions` so SpiceDB runs without client-side limits.
 */
export function createTunedSpiceDbClient(
  endpoint: string,
  presharedKey: string,
): TunedSpiceDbClient {
  const client = v1.NewClient(
    presharedKey,
    endpoint,
    v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
  );
  let latestToken: v1.ZedToken | undefined;
  const toConsistency = (mode: TunedSpiceDbConsistency): v1.Consistency =>
    mode === "fully-consistent"
      ? v1.Consistency.create({
          requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
        })
      : latestToken !== undefined
        ? v1.Consistency.create({
            requirement: {
              oneofKind: "atLeastAsFresh",
              atLeastAsFresh: latestToken,
            },
          })
        : v1.Consistency.create({
            requirement: {
              oneofKind: "minimizeLatency",
              minimizeLatency: true,
            },
          });

  return {
    async writeSchema(zed: string): Promise<void> {
      const response = await client.promises.writeSchema(
        v1.WriteSchemaRequest.create({ schema: zed }),
      );
      if (response.writtenAt !== undefined) latestToken = response.writtenAt;
    },
    async writeRelationships(
      writes: readonly RelationshipWrite[],
    ): Promise<void> {
      for (let offset = 0; offset < writes.length; offset += 1_000) {
        const slice = writes.slice(offset, offset + 1_000);
        const response = await client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: slice.map((entry) =>
              v1.RelationshipUpdate.create({
                operation: v1.RelationshipUpdate_Operation.TOUCH,
                relationship: v1.Relationship.create({
                  resource: v1.ObjectReference.create({
                    objectType: entry.resource.type,
                    objectId: entry.resource.id,
                  }),
                  relation: entry.relation,
                  subject: v1.SubjectReference.create({
                    object: v1.ObjectReference.create({
                      objectType: entry.subject.type,
                      objectId: entry.subject.id,
                    }),
                    optionalRelation: entry.subject.relation ?? "",
                  }),
                }),
              }),
            ),
          }),
        );
        if (response.writtenAt !== undefined) latestToken = response.writtenAt;
      }
    },
    async check(query, consistency): Promise<boolean> {
      const response = await client.promises.checkPermission(
        v1.CheckPermissionRequest.create({
          resource: v1.ObjectReference.create({
            objectType: query.resource.type,
            objectId: query.resource.id,
          }),
          permission: query.permission,
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectType: query.subject.type,
              objectId: query.subject.id,
            }),
            optionalRelation: query.subject.relation ?? "",
          }),
          consistency: toConsistency(consistency),
        }),
      );
      return (
        response.permissionship ===
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
      );
    },
    async checkManySingleRpc(
      queries,
      consistency,
    ): Promise<readonly boolean[]> {
      const response = await client.promises.checkBulkPermissions(
        v1.CheckBulkPermissionsRequest.create({
          consistency: toConsistency(consistency),
          items: queries.map((query) =>
            v1.CheckBulkPermissionsRequestItem.create({
              resource: v1.ObjectReference.create({
                objectType: query.resource.type,
                objectId: query.resource.id,
              }),
              permission: query.permission,
              subject: v1.SubjectReference.create({
                object: v1.ObjectReference.create({
                  objectType: query.subject.type,
                  objectId: query.subject.id,
                }),
                optionalRelation: query.subject.relation ?? "",
              }),
            }),
          ),
        }),
      );
      return response.pairs.map(
        (pair) =>
          pair.response.oneofKind === "item" &&
          pair.response.item.permissionship ===
            v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      );
    },
    async lookupResources(query, consistency): Promise<readonly string[]> {
      const responses = await client.promises.lookupResources(
        v1.LookupResourcesRequest.create({
          resourceObjectType: query.resourceType,
          permission: query.permission,
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({
              objectType: query.subject.type,
              objectId: query.subject.id,
            }),
            optionalRelation: query.subject.relation ?? "",
          }),
          consistency: toConsistency(consistency),
        }),
      );
      return responses.map((item) => item.resourceObjectId);
    },
  };
}
