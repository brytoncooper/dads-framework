import { connectPostgresClient } from "@dads-framework/postgres";
import { discoverDomainMigrations } from "./discover-domain-migrations.js";
import { relationExists } from "./node-pg-journal.js";
import { readValidatedMigrationPlan } from "./read-validated-migration-plan.js";
import type { NodePgMigrationRunnerInput } from "./run-node-pg-migrations.js";

/** A consistent read-only snapshot, using the migrator's own history checks. */
export async function inspectNodePgMigrations(
  input: NodePgMigrationRunnerInput,
): Promise<"legacy-pending" | "node-pg-pending" | "current"> {
  const discovered = await discoverDomainMigrations({
    workspace: input.workspace,
  });
  const client = await connectPostgresClient(input.databaseUrl);
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    if (await relationExists(client, "drizzle", "__drizzle_migrations"))
      return "legacy-pending";
    const { pending } = await readValidatedMigrationPlan(client, discovered);
    return pending.length === 0 ? "current" : "node-pg-pending";
  } finally {
    await client.end();
  }
}
