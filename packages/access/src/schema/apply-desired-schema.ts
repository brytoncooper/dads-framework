import type { RelationshipFilter } from "../runtime/authorization.js";
import {
  type AuthorizationSchemaStore,
  SCHEMA_REWRITE_STEPS,
  type SchemaRewriteStep,
} from "./authorization-schema-store.js";
import { parseWriteSchemaBlocker } from "./logic/parse-write-schema-blocker.js";
import { parseZedSchemaSurface } from "./logic/parse-zed-schema-surface.js";
import type { ZedRelation } from "./logic/parse-zed-schema-surface.js";
import {
  contractionPlanIsEmpty,
  planSchemaContraction,
  type SchemaContractionPlan,
} from "./logic/plan-schema-contraction.js";

const MAX_WRITE_SCHEMA_ATTEMPTS = 8;

export type ApplyAuthorizationSchemaLog = {
  info(context: object, message: string): void;
};

export type ApplyAuthorizationSchemaReport = {
  removedTypes: readonly string[];
  removedRelations: readonly ZedRelation[];
  wroteSchema: boolean;
  snapshot: "cloned" | "skipped" | "not-needed";
};

/** Deletes leftover tuples for removed definitions/relations, then WriteSchema. */
export async function applyDesiredAuthorizationSchema(input: {
  store: AuthorizationSchemaStore;
  desiredSchema: string;
  rewriteSteps?: readonly SchemaRewriteStep[];
  snapshotDatastore?: () => Promise<"cloned" | "skipped">;
  log?: ApplyAuthorizationSchemaLog;
}): Promise<ApplyAuthorizationSchemaReport> {
  const store = input.store;
  const log = input.log;
  const rewriteSteps = input.rewriteSteps ?? SCHEMA_REWRITE_STEPS;

  for (const step of rewriteSteps) {
    await step.apply(store);
  }

  const liveSchema = await store.readSchema();
  const plan = planSchemaContraction(parseZedSchemaSurface(liveSchema), parseZedSchemaSurface(input.desiredSchema));
  const snapshot = await maybeSnapshot(plan, input.snapshotDatastore, log);
  await deleteLeftoverRelationships(store, plan, log);
  await writeDesiredSchema(store, input.desiredSchema);

  return {
    removedTypes: plan.removedTypes,
    removedRelations: plan.removedRelations,
    wroteSchema: true,
    snapshot,
  };
}

async function maybeSnapshot(
  plan: SchemaContractionPlan,
  snapshotDatastore: (() => Promise<"cloned" | "skipped">) | undefined,
  log: ApplyAuthorizationSchemaLog | undefined,
): Promise<"cloned" | "skipped" | "not-needed"> {
  if (contractionPlanIsEmpty(plan)) {
    return "not-needed";
  }
  if (snapshotDatastore === undefined) {
    log?.info(
      {
        event: "authorization.schema.snapshot.skipped",
        code: "AUTHORIZATION_SCHEMA_SNAPSHOT_SKIPPED",
      },
      "no SpiceDB datastore Postgres URL; continuing without a rolling clone",
    );
    return "skipped";
  }
  return snapshotDatastore();
}

async function deleteLeftoverRelationships(
  store: AuthorizationSchemaStore,
  plan: SchemaContractionPlan,
  log: ApplyAuthorizationSchemaLog | undefined,
): Promise<void> {
  for (const resourceType of plan.removedTypes) {
    await store.deleteRelationships({ resourceType });
    log?.info(
      {
        event: "authorization.schema.tuples.deleted",
        code: "AUTHORIZATION_SCHEMA_TUPLES_DELETED",
        resourceType,
      },
      "deleted leftover tuples for a removed definition",
    );
  }
  for (const entry of plan.removedRelations) {
    await store.deleteRelationships({
      resourceType: entry.resourceType,
      relation: entry.relation,
    });
    log?.info(
      {
        event: "authorization.schema.tuples.deleted",
        code: "AUTHORIZATION_SCHEMA_TUPLES_DELETED",
        resourceType: entry.resourceType,
        relation: entry.relation,
      },
      "deleted leftover tuples for a removed relation",
    );
  }
}

async function writeDesiredSchema(store: AuthorizationSchemaStore, desiredSchema: string): Promise<void> {
  let attempt = 0;
  while (attempt < MAX_WRITE_SCHEMA_ATTEMPTS) {
    attempt += 1;
    try {
      await store.writeSchema(desiredSchema);
      return;
    } catch (error: unknown) {
      const blocker = parseWriteSchemaBlocker(collectErrorText(error));
      if (blocker === undefined || attempt === MAX_WRITE_SCHEMA_ATTEMPTS) {
        throw error;
      }
      await store.deleteRelationships(filterForBlocker(blocker));
    }
  }
}

function filterForBlocker(blocker: NonNullable<ReturnType<typeof parseWriteSchemaBlocker>>): RelationshipFilter {
  if (blocker.kind === "removed-type") {
    return { resourceType: blocker.resourceType };
  }
  if (blocker.kind === "removed-relation") {
    return {
      resourceType: blocker.resourceType,
      relation: blocker.relation,
    };
  }
  return {
    resourceType: blocker.resourceType,
    relation: blocker.relation,
    subject: {
      type: blocker.subjectType,
      id: "",
      ...(blocker.subjectRelation === undefined ? {} : { relation: blocker.subjectRelation }),
    },
  };
}

function collectErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}
