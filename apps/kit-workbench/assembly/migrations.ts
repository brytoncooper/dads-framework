import { fileURLToPath } from "node:url";
import { runNodePgMigrations, type MigrationSource } from "@dads-framework/postgres/migrations";
// dad:add imports

const sources: readonly MigrationSource[] = [
  {
    root: "migrations",
    owner: "starter",
    files: /^migrations\/[^/]+\.migration\.ts$/,
    required: true,
  },
  // dad:add migrations
];

export function migrate(databaseUrl: string) {
  return runNodePgMigrations({
    databaseUrl,
    workspace: {
      root: fileURLToPath(new URL("..", import.meta.url)),
      sources,
      moduleAliases: {
        "@dads-framework/feature-flags-postgres": "migrations/support/feature-flags.ts",
      },
    },
  });
}
