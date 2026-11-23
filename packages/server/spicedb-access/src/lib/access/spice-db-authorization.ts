import { v1 } from "@authzed/authzed-node";

import type { AuthorizationReadFreshness } from "@dads-framework/core/runtime/request-work";

import {
  Authorization,
  authorizationConsistencyTokenOnThisRequest,
  recordWrittenAuthorizationConsistency,
  resolveReadConsistency,
  type DirectSubjectLookup,
  type PermissionCheckOutcome,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipPage,
  type RelationshipPageRequest,
  type RelationshipWrite,
  type ResourceLookup,
  type SpiceDbConsistencyToken,
  type SubjectRef,
} from "@dads-framework/access/runtime";
import { isEmptySchemaError } from "./logic/spice-db-empty-schema.js";
import {
  isRetryableSpiceDbWriteError,
  SPICE_DB_WRITE_ATTEMPTS,
  spiceDbWriteRetryDelayMs,
} from "./logic/spice-db-write-retry.js";
import { NewestWrittenToken } from "./newest-written-token.js";
import { OneWriteAtATime } from "./one-write-at-a-time.js";
import { connectSpiceDb } from "./spice-db-clients.js";
import { askedConsistency, enforcementRead, FULLY_CONSISTENT, toSpiceDbConsistency } from "./spice-db-consistency.js";
import {
  checkSpiceDbPermission,
  checkSpiceDbPermissions,
  denyingFailedItems,
  type SpiceDbPermissionClient,
  toSpiceDbSubjectReference,
} from "./spice-db-permission-checks.js";
import { relationshipFromSpiceDb } from "./spice-db-relationship-read.js";
import {
  RELATIONSHIP_WRITE_DEADLINE_MS,
  SCHEMA_WRITE_DEADLINE_MS,
  withinWriteDeadline,
} from "./spice-db-write-deadline.js";

export type SpiceDbAdapterOptions = {
  endpoint: string;
  presharedKey: string;
  /** allow plaintext gRPC for local/compose SpiceDB */
  insecure: boolean;
  /**
   * `fully-consistent` forces every read fully consistent (tests, so a check
   * sees a tuple written a millisecond earlier by any adapter).
   *
   * Otherwise permission checks and resource lookups are `at_least_as_fresh`
   * than the newest write this adapter made, and fully consistent while it
   * has no trusted token — so every grant or revocation this process wrote is
   * visible, and SpiceDB may still serve the read from its cache.
   * Relationship inspection and direct-subject display reads use
   * minimize-latency plus the request's write token; callers using
   * direct-subject reads for guards must request fully-consistent explicitly.
   */
  consistency?: "minimize-latency" | "fully-consistent";
  /**
   * Told the freshness of every check, bulk check and lookup as it is sent,
   * in the caller's async context — how request accounting counts cached
   * versus fully consistent reads without knowing SpiceDB.
   */
  onEnforcementRead?: (freshness: AuthorizationReadFreshness) => void;
  /** Told every bulk-check item SpiceDB answered with an error, to log it. */
  onCheckItemError?: (error: Error) => void;
  /** Deadline for one relationship write; defaults to RELATIONSHIP_WRITE_DEADLINE_MS. */
  relationshipWriteDeadlineMs?: number;
};

type SpiceDbClient = {
  readonly promises: SpiceDbPermissionClient &
    Pick<
      ReturnType<typeof v1.NewClient>["promises"],
      | "lookupResources"
      | "writeRelationships"
      | "deleteRelationships"
      | "readRelationships"
      | "readSchema"
      | "writeSchema"
    >;
};

/**
 * The SpiceDB adapter keeps the Authzed SDK behind the authorization port.
 * Enforcement reads are never older than this adapter's newest write;
 * display reads retain the separate SpiceDbAdapterOptions.consistency option.
 *
 * Relationship and schema writes run one at a time per adapter instance.
 * They are small and rare next to reads, and the newest token is trusted
 * only when the order writes finished in is the order they committed in;
 * two overlapping writes would leave no trusted token and turn the cache off.
 * Every queued write carries a deadline, so one that never answers is
 * abandoned, clears the token like any failed write, and frees the queue.
 */
export class SpiceDbAuthorization extends Authorization {
  private readonly client: SpiceDbClient;
  private readonly writeClient: SpiceDbClient;
  private readonly adapterConsistency: "minimize-latency" | "fully-consistent";
  private readonly onEnforcementRead: SpiceDbAdapterOptions["onEnforcementRead"];
  private readonly onCheckItemError: SpiceDbAdapterOptions["onCheckItemError"];
  private readonly newestWrite = new NewestWrittenToken();
  private readonly writes = new OneWriteAtATime();
  private readonly writeDeadlineMs: number;

  constructor(options: SpiceDbAdapterOptions, client?: SpiceDbClient) {
    super();
    this.writeDeadlineMs = options.relationshipWriteDeadlineMs ?? RELATIONSHIP_WRITE_DEADLINE_MS;
    const connected =
      client === undefined ? connectSpiceDb(options, this.writeDeadlineMs) : { reads: client, writes: client };
    this.client = connected.reads;
    this.writeClient = connected.writes;
    this.adapterConsistency = options.consistency === "fully-consistent" ? "fully-consistent" : "minimize-latency";
    this.onEnforcementRead = options.onEnforcementRead;
    this.onCheckItemError = options.onCheckItemError;
  }

  check(query: PermissionQuery): Promise<boolean> {
    return checkSpiceDbPermission(
      this.client.promises,
      query,
      askedConsistency([query], () => this.enforcementConsistency()),
    );
  }

  /** An item error denies that item, and is logged and noted on the request. */
  override async checkMany(queries: readonly PermissionQuery[]): Promise<readonly boolean[]> {
    return denyingFailedItems(queries, await this.checkEach(queries));
  }

  /** An item error is that item's `failed` outcome, and is logged. */
  override async checkEach(queries: readonly PermissionQuery[]): Promise<readonly PermissionCheckOutcome[]> {
    if (queries.length === 0) return [];
    return checkSpiceDbPermissions(
      this.client.promises,
      queries,
      askedConsistency(queries, () => this.enforcementConsistency()),
      this.onCheckItemError,
    );
  }

  async lookupResources(query: ResourceLookup): Promise<readonly string[]> {
    const responses = await this.client.promises.lookupResources(
      v1.LookupResourcesRequest.create({
        resourceObjectType: query.resourceType,
        permission: query.permission,
        subject: toSpiceDbSubjectReference(query.subject),
        consistency: this.enforcementConsistency(),
      }),
    );
    return responses
      .filter((item) => item.permissionship === v1.LookupPermissionship.HAS_PERMISSION)
      .map((item) => item.resourceObjectId);
  }

  async writeRelationships(writes: readonly RelationshipWrite[]): Promise<SpiceDbConsistencyToken> {
    const request = v1.WriteRelationshipsRequest.create({
      updates: writes.map((write) =>
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            resource: v1.ObjectReference.create({
              objectType: write.resource.type,
              objectId: write.resource.id,
            }),
            relation: write.relation,
            subject: toSpiceDbSubjectReference(write.subject),
          }),
        }),
      ),
    });
    const response = await this.trackedWrite(
      () => this.sendWrite(() => this.writeClient.promises.writeRelationships(request)),
      (written) => written.writtenAt?.token ?? "",
    );
    const token = response.writtenAt?.token ?? "";
    recordWrittenAuthorizationConsistency(token);
    return token;
  }

  async deleteRelationships(filter: RelationshipFilter): Promise<SpiceDbConsistencyToken> {
    const request = v1.DeleteRelationshipsRequest.create({
      relationshipFilter: v1.RelationshipFilter.create({
        resourceType: filter.resourceType,
        ...(filter.resourceId ? { optionalResourceId: filter.resourceId } : {}),
        ...(filter.relation ? { optionalRelation: filter.relation } : {}),
        ...(filter.subject
          ? {
              optionalSubjectFilter: v1.SubjectFilter.create({
                subjectType: filter.subject.type,
                ...(filter.subject.id.length > 0 ? { optionalSubjectId: filter.subject.id } : {}),
                ...(filter.subject.relation
                  ? {
                      optionalRelation: v1.SubjectFilter_RelationFilter.create({
                        relation: filter.subject.relation,
                      }),
                    }
                  : {}),
              }),
            }
          : {}),
      }),
    });
    const response = await this.trackedWrite(
      () => this.sendWrite(() => this.writeClient.promises.deleteRelationships(request)),
      (deleted) => deleted.deletedAt?.token ?? "",
    );
    const token = response.deletedAt?.token ?? "";
    recordWrittenAuthorizationConsistency(token);
    return token;
  }

  async relationshipExists(filter: { resourceType: string; resourceId: string; relation: string }): Promise<boolean> {
    const responses = await this.client.promises.readRelationships(
      v1.ReadRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType: filter.resourceType,
          optionalResourceId: filter.resourceId,
          optionalRelation: filter.relation,
        }),
        ...consistencyField(this.readConsistency()),
      }),
    );
    return responses.length > 0;
  }

  async listDirectSubjects(query: DirectSubjectLookup): Promise<readonly SubjectRef[]> {
    const responses = await this.client.promises.readRelationships(
      v1.ReadRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType: query.resource.type,
          optionalResourceId: query.resource.id,
          optionalRelation: query.relation,
        }),
        ...consistencyField(this.readConsistency(query.consistencyToken, query.consistency)),
      }),
    );
    const subjects: SubjectRef[] = [];
    for (const item of responses) {
      const object = item.relationship?.subject?.object;
      if (!object) continue;
      const optionalRelation = item.relationship?.subject?.optionalRelation;
      subjects.push({
        type: object.objectType,
        id: object.objectId,
        ...(optionalRelation ? { relation: optionalRelation } : {}),
      });
    }
    return subjects;
  }

  /** Maintenance-only exact retirement, including direct versus userset subject identity. */
  async deleteExactRelationship(fact: RelationshipWrite): Promise<SpiceDbConsistencyToken> {
    const request = v1.DeleteRelationshipsRequest.create({
      relationshipFilter: v1.RelationshipFilter.create({
        resourceType: fact.resource.type,
        optionalResourceId: fact.resource.id,
        optionalRelation: fact.relation,
        optionalSubjectFilter: v1.SubjectFilter.create({
          subjectType: fact.subject.type,
          optionalSubjectId: fact.subject.id,
          // An omitted filter means all relations; an explicit empty relation means direct-only.
          optionalRelation: v1.SubjectFilter_RelationFilter.create({
            relation: fact.subject.relation ?? "",
          }),
        }),
      }),
    });
    const response = await this.trackedWrite(
      () => this.sendWrite(() => this.writeClient.promises.deleteRelationships(request)),
      (deleted) => deleted.deletedAt?.token ?? "",
    );
    const token = response.deletedAt?.token ?? "";
    recordWrittenAuthorizationConsistency(token);
    return token;
  }

  /** Bounded maintenance inspection; deliberately not part of the business Authorization port. */
  async readRelationshipPage(query: RelationshipPageRequest): Promise<RelationshipPage> {
    const responses = await this.client.promises.readRelationships(
      v1.ReadRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType: query.resourceType,
        }),
        optionalLimit: 1000,
        ...(query.cursor === undefined ? {} : { optionalCursor: v1.Cursor.create({ token: query.cursor }) }),
        consistency: FULLY_CONSISTENT,
      }),
    );
    if (responses.some((item) => !item.afterResultCursor?.token)) {
      throw new Error("Incomplete relationship in authorization migration read");
    }
    return {
      relationships: responses.map(relationshipFromSpiceDb),
      nextCursor: responses.at(-1)?.afterResultCursor?.token ?? null,
    };
  }

  /**
   * Checks and lookups: never older than this adapter's newest write, so
   * SpiceDB can answer from cache without missing a grant or revocation this
   * process made. No trusted token (fresh process, overlapping or failed
   * writes) means fully consistent, exactly as before.
   */
  private enforcementConsistency(): v1.Consistency {
    const read = enforcementRead(this.adapterConsistency, this.newestWrite.current());
    this.onEnforcementRead?.(read.freshness);
    return read.consistency;
  }

  private readConsistency(
    queryToken?: SpiceDbConsistencyToken,
    queryConsistency?: "fully-consistent",
  ): v1.Consistency | undefined {
    return toSpiceDbConsistency(
      resolveReadConsistency({
        adapterConsistency: this.adapterConsistency,
        ...(queryConsistency === undefined ? {} : { queryConsistency }),
        ...(queryToken === undefined ? {} : { queryToken }),
        ...readRequestToken(),
      }),
    );
  }

  /** Reads the live schema text. Empty when SpiceDB has never received a schema. */
  async readSchema(): Promise<string> {
    try {
      const response = await this.client.promises.readSchema(v1.ReadSchemaRequest.create({}));
      return response.schemaText;
    } catch (error: unknown) {
      if (isEmptySchemaError(error)) {
        return "";
      }
      throw error;
    }
  }

  /** Writes the composed schema — used by tests and schema migrate. */
  async writeSchema(schema: string): Promise<void> {
    await this.writes.run(async () => {
      try {
        await withinWriteDeadline(
          () => this.client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema })),
          SCHEMA_WRITE_DEADLINE_MS,
        );
      } finally {
        // A schema change moves permissions without a relationship token.
        this.newestWrite.forget();
      }
    });
  }

  /** One write attempt policy: retried when it lost a race, abandoned past its deadline. */
  private sendWrite<T>(send: () => Promise<T>): Promise<T> {
    return sendWriteRetryingLostRaces(() => withinWriteDeadline(send, this.writeDeadlineMs));
  }

  /** One relationship write, queued behind the others, keeping its token. */
  private trackedWrite<T>(write: () => Promise<T>, tokenOf: (response: T) => SpiceDbConsistencyToken): Promise<T> {
    return this.writes.run(() => this.newestWrite.track(write, tokenOf));
  }
}

/**
 * Send one idempotent write, again if it lost a race inside SpiceDB — see
 * `logic/spice-db-write-retry.ts` for which failures count and why.
 */
async function sendWriteRetryingLostRaces<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= SPICE_DB_WRITE_ATTEMPTS || !isRetryableSpiceDbWriteError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, spiceDbWriteRetryDelayMs(attempt)));
    }
  }
}

/**
 * Binds the Authorization seam to SpiceDB — the plain-factory
 * form of AuthzModule.forRoot. Domains receive the seam and never see the
 * vendor; route-level enforcement lives in the HTTP kit.
 */
export function createSpiceDbAuthorization(options: SpiceDbAdapterOptions): Authorization {
  return new SpiceDbAuthorization(options);
}

/** A request's `consistency` field, absent when SpiceDB's default applies. */
function consistencyField(consistency: v1.Consistency | undefined): {
  consistency?: v1.Consistency;
} {
  return consistency === undefined ? {} : { consistency };
}

/** The consistency token this request carries, when it carries one. */
function readRequestToken(): { requestToken?: string } {
  const requestToken = authorizationConsistencyTokenOnThisRequest();
  return requestToken === undefined ? {} : { requestToken };
}
