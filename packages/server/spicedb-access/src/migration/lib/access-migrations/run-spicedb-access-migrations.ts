import { emitZed } from "@dads-framework/access";
import type { RelationshipWrite } from "@dads-framework/access/runtime";

import type { AuthorizationMigrationClient, AuthorizationMigrationStore } from "../journal/journal-entry.js";
import { buildMigrationBridgeSchema } from "../scaffold/build-migration-bridge-schema.js";
import type { AccessMigrationStepOp, DefinedAccessMigration } from "./define-access-migration.js";

/**
 * Execute compiled `(from, to)` access migration step ops against a SpiceDB
 * `AuthorizationMigrationClient` using paginated reads, idempotent touches,
 * and filtered deletes.
 */
export async function applyAccessMigrationOpsToSpiceDb(
  client: AuthorizationMigrationClient,
  ops: readonly AccessMigrationStepOp[],
): Promise<void> {
  for (const op of ops) {
    if (op.kind === "copy-role") {
      await copyRoleInSpiceDb(client, op.from, op.to);
      continue;
    }
    await client.deleteRelationships({
      resourceType: op.target.resource,
      relation: op.target.role,
    });
  }
}

async function copyRoleInSpiceDb(
  client: AuthorizationMigrationClient,
  from: { readonly resource: string; readonly role: string },
  to: { readonly resource: string; readonly role: string },
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.readRelationshipPage({
      resourceType: from.resource,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const copied: RelationshipWrite[] = page.relationships
      .filter((rel) => rel.relation === from.role)
      .map((rel) => ({
        resource: { type: to.resource, id: rel.resource.id },
        relation: to.role,
        subject: rel.subject,
        ...(rel.expiresAt === undefined ? {} : { expiresAt: rel.expiresAt }),
      }));
    if (copied.length > 0) {
      await client.writeRelationships(copied);
    }
    if (page.nextCursor === null || page.relationships.length === 0) {
      return;
    }
    cursor = page.nextCursor;
  }
}

export type RunSpiceDbAccessMigrationsOptions = {
  readonly store: AuthorizationMigrationStore;
  readonly migrations: readonly DefinedAccessMigration[];
};

/**
 * Apply `(from, to)` access migrations in order against SpiceDB using the
 * expand-migrate-contract bridge schema pattern: write bridge schema, run
 * `copyRole` / `dropRole` ops, then write the target `to` schema.
 */
export async function runSpiceDbAccessMigrations(
  options: RunSpiceDbAccessMigrationsOptions,
): Promise<{ readonly applied: readonly string[] }> {
  const applied: string[] = [];
  for (const migration of options.migrations) {
    const fromZed = emitZed(migration.from);
    const toZed = emitZed(migration.to);
    if (migration.ops.length > 0) {
      const bridgeSchema = buildMigrationBridgeSchema(fromZed, toZed);
      await options.store.writeSchema(bridgeSchema);
      await applyAccessMigrationOpsToSpiceDb(options.store, migration.ops);
    }
    await options.store.writeSchema(toZed);
    applied.push(migration.id);
  }
  return { applied };
}
