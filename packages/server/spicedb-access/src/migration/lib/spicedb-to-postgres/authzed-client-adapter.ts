export type SpiceDbExportedTuple = {
  readonly resource: { readonly type: string; readonly id: string };
  readonly relation: string;
  readonly subject: {
    readonly type: string;
    readonly id: string;
    readonly relation?: string;
  };
  readonly expiresAt?: Date;
};

export type SpiceDbReadSchemaResult = {
  readonly schemaText: string;
  readonly zedToken?: string;
};

export type SpiceDbExportRelationshipsOptions = {
  readonly pageSize?: number;
  readonly zedToken?: string;
};

/**
 * Minimal structural source for SpiceDB -> Postgres migration. Satisfied by
 * `createAuthzedMigrationSource(v1.NewClient(...))` or an in-memory test double.
 */
export type SpiceDbMigrationSource = {
  readSchema(): Promise<SpiceDbReadSchemaResult>;
  exportRelationships(options?: SpiceDbExportRelationshipsOptions): AsyncIterable<readonly SpiceDbExportedTuple[]>;
};

export type AuthzedTimestampLike = {
  readonly seconds: string | number | bigint;
  readonly nanos?: number;
};

export type AuthzedRelationshipLike = {
  readonly resource?: {
    readonly objectType: string;
    readonly objectId: string;
  };
  readonly relation: string;
  readonly subject?: {
    readonly object?: {
      readonly objectType: string;
      readonly objectId: string;
    };
    readonly optionalRelation?: string;
  };
  readonly optionalCaveat?: { readonly caveatName: string };
  readonly optionalExpiresAt?: AuthzedTimestampLike;
};

export type AuthzedExportResponseLike = {
  readonly relationships?: readonly AuthzedRelationshipLike[];
  readonly afterResultCursor?: { readonly token?: string };
};

export type AuthzedExportBulkRequestLike = {
  consistency?: {
    requirement:
      | { oneofKind: "fullyConsistent"; fullyConsistent: boolean }
      | { oneofKind: "atExactSnapshot"; atExactSnapshot: { token: string } };
  };
  optionalLimit: number;
};

/**
 * Structural subset of `@authzed/authzed-node`'s `v1.ZedClientInterface`
 * (`v1.NewClient(...)`), avoiding a hard vendor dependency on this package.
 */
export type AuthzedV1ClientLike = {
  readonly promises: {
    readSchema(request: Record<string, never>): Promise<{
      readonly schemaText: string;
      readonly readAt?: { readonly token: string };
    }>;
  };
  exportBulkRelationships(request: AuthzedExportBulkRequestLike): AsyncIterable<AuthzedExportResponseLike>;
};

export function isAuthzedV1ClientLike(
  source: SpiceDbMigrationSource | AuthzedV1ClientLike,
): source is AuthzedV1ClientLike {
  const candidate: {
    readonly readSchema?: unknown;
    readonly promises?: unknown;
    readonly exportBulkRelationships?: unknown;
  } = source;
  return candidate.promises !== undefined && typeof candidate.exportBulkRelationships === "function";
}

/**
 * Adapt a real `@authzed/authzed-node` `v1.NewClient(...)` instance into a
 * `SpiceDbMigrationSource` using `ReadSchema` and streaming
 * `ExportBulkRelationships`.
 */
export function createAuthzedMigrationSource(client: AuthzedV1ClientLike): SpiceDbMigrationSource {
  return {
    async readSchema() {
      const response = await client.promises.readSchema({});
      const token = response.readAt?.token;
      return {
        schemaText: response.schemaText,
        ...(token !== undefined && token !== "" ? { zedToken: token } : {}),
      };
    },
    exportRelationships(options) {
      return streamAuthzedRelationships(client, options);
    },
  };
}

async function* streamAuthzedRelationships(
  client: AuthzedV1ClientLike,
  options?: SpiceDbExportRelationshipsOptions,
): AsyncGenerator<readonly SpiceDbExportedTuple[]> {
  const request: AuthzedExportBulkRequestLike = {
    optionalLimit: options?.pageSize ?? 1000,
    consistency: buildExportConsistency(options?.zedToken),
  };
  const stream = client.exportBulkRelationships(request);
  for await (const chunk of stream) {
    const items = chunk.relationships ?? [];
    if (items.length === 0) continue;
    yield items.map(convertAuthzedRelationship);
  }
}

function buildExportConsistency(
  zedToken: string | undefined,
): NonNullable<AuthzedExportBulkRequestLike["consistency"]> {
  if (zedToken !== undefined && zedToken !== "") {
    return {
      requirement: {
        oneofKind: "atExactSnapshot",
        atExactSnapshot: { token: zedToken },
      },
    };
  }
  return {
    requirement: {
      oneofKind: "fullyConsistent",
      fullyConsistent: true,
    },
  };
}

function convertAuthzedRelationship(item: AuthzedRelationshipLike): SpiceDbExportedTuple {
  const { resource, subjectObject } = requireRelationshipEndpoints(item);
  assertNoCaveat(item, resource);
  const subjectRelation = item.subject?.optionalRelation;
  const expiresAt = parseAuthzedTimestamp(item.optionalExpiresAt);
  return {
    resource: { type: resource.objectType, id: resource.objectId },
    relation: item.relation,
    subject: buildSubjectRef(subjectObject, subjectRelation),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function requireRelationshipEndpoints(item: AuthzedRelationshipLike): {
  readonly resource: { readonly objectType: string; readonly objectId: string };
  readonly subjectObject: {
    readonly objectType: string;
    readonly objectId: string;
  };
} {
  const resource = item.resource;
  const subjectObject = item.subject?.object;
  if (resource === undefined || subjectObject === undefined || !item.relation) {
    throw new Error("Incomplete relationship received from SpiceDB ExportBulkRelationships");
  }
  return { resource, subjectObject };
}

function assertNoCaveat(
  item: AuthzedRelationshipLike,
  resource: { readonly objectType: string; readonly objectId: string },
): void {
  const caveatName = item.optionalCaveat?.caveatName;
  if (caveatName !== undefined && caveatName !== "") {
    throw new Error(
      `Unsupported caveated relationship ${resource.objectType}:${resource.objectId}#${item.relation} (caveat "${caveatName}") cannot be migrated to Postgres`,
    );
  }
}

function buildSubjectRef(
  subjectObject: { readonly objectType: string; readonly objectId: string },
  subjectRelation: string | undefined,
): SpiceDbExportedTuple["subject"] {
  if (subjectRelation !== undefined && subjectRelation !== "") {
    return {
      type: subjectObject.objectType,
      id: subjectObject.objectId,
      relation: subjectRelation,
    };
  }
  return { type: subjectObject.objectType, id: subjectObject.objectId };
}

function parseAuthzedTimestamp(timestamp: AuthzedTimestampLike | undefined): Date | undefined {
  if (timestamp === undefined) return undefined;
  const seconds = Number(timestamp.seconds);
  const nanos = timestamp.nanos ?? 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    throw new Error("Invalid optionalExpiresAt timestamp from SpiceDB");
  }
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
}
