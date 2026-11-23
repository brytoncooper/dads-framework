import type { SpiceDbExportedTuple } from "../spicedb-to-postgres/authzed-client-adapter.js";

export type SpiceDbWriteRelationshipsResult = {
  readonly zedToken?: string;
};

/**
 * Minimal structural target for Postgres -> SpiceDB migration. Satisfied by
 * `createAuthzedMigrationTarget(v1.NewClient(...))` or an in-memory test double.
 */
export type SpiceDbMigrationTarget = {
  writeSchema(schemaText: string): Promise<void>;
  writeRelationships(tuples: readonly SpiceDbExportedTuple[]): Promise<SpiceDbWriteRelationshipsResult>;
};

export type AuthzedWriteTimestampLike = {
  seconds: string;
  nanos: number;
};

export type AuthzedRelationshipUpdateLike = {
  operation: number;
  relationship: {
    resource: {
      objectType: string;
      objectId: string;
    };
    relation: string;
    subject: {
      object: {
        objectType: string;
        objectId: string;
      };
      optionalRelation: string;
    };
    optionalExpiresAt?: AuthzedWriteTimestampLike;
  };
};

/**
 * Structural subset of `@authzed/authzed-node`'s `v1.ZedClientInterface`
 * (`v1.NewClient(...)`) for schema and relationship writes, avoiding a hard
 * vendor dependency on this package.
 */
export type AuthzedWriteClientLike = {
  readonly promises: {
    writeSchema(request: { schema: string }): Promise<unknown>;
    writeRelationships(request: {
      updates: AuthzedRelationshipUpdateLike[];
      optionalPreconditions: never[];
    }): Promise<{ readonly writtenAt?: { readonly token: string } }>;
  };
};

// Matches `v1.RelationshipUpdate_Operation.TOUCH = 2` in AuthZed's protobuf schema.
const AUTHZED_OPERATION_TOUCH = 2;

export function isAuthzedWriteClientLike(
  target: SpiceDbMigrationTarget | AuthzedWriteClientLike,
): target is AuthzedWriteClientLike {
  // `@authzed/authzed-node` returns a JS Proxy without a `has` trap, so read
  // `promises` via property access (`Reflect.get`) rather than `"promises" in`.
  const promises: unknown = Reflect.get(target, "promises");
  return typeof promises === "object" && promises !== null;
}

/**
 * Adapt a real `@authzed/authzed-node` `v1.NewClient(...)` instance into an
 * idempotent `SpiceDbMigrationTarget` using `WriteSchema` and `TOUCH`
 * `WriteRelationships` calls (safe to re-run during live cutovers).
 */
export function createAuthzedMigrationTarget(client: AuthzedWriteClientLike): SpiceDbMigrationTarget {
  return {
    async writeSchema(schemaText: string): Promise<void> {
      await client.promises.writeSchema({ schema: schemaText });
    },
    async writeRelationships(tuples: readonly SpiceDbExportedTuple[]): Promise<SpiceDbWriteRelationshipsResult> {
      if (tuples.length === 0) return {};
      const response = await client.promises.writeRelationships({
        updates: tuples.map(toAuthzedTouchUpdate),
        optionalPreconditions: [],
      });
      const token = response.writtenAt?.token;
      return token !== undefined && token !== "" ? { zedToken: token } : {};
    },
  };
}

function toAuthzedTouchUpdate(tuple: SpiceDbExportedTuple): AuthzedRelationshipUpdateLike {
  const expiresAt = encodeAuthzedTimestamp(tuple.expiresAt);
  return {
    operation: AUTHZED_OPERATION_TOUCH,
    relationship: {
      resource: {
        objectType: tuple.resource.type,
        objectId: tuple.resource.id,
      },
      relation: tuple.relation,
      subject: {
        object: {
          objectType: tuple.subject.type,
          objectId: tuple.subject.id,
        },
        optionalRelation: tuple.subject.relation ?? "",
      },
      ...(expiresAt === undefined ? {} : { optionalExpiresAt: expiresAt }),
    },
  };
}

function encodeAuthzedTimestamp(expiresAt: Date | undefined): AuthzedWriteTimestampLike | undefined {
  if (expiresAt === undefined) return undefined;
  const millis = expiresAt.getTime();
  if (!Number.isFinite(millis)) {
    throw new Error("Relationship expiresAt must be a valid Date");
  }
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis - seconds * 1000) * 1_000_000;
  return { seconds: String(seconds), nanos };
}
