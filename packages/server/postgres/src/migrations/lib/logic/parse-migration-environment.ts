import { z } from "zod";

const migrationEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    WORKSPACE_ROOT: z.string().min(1).default("."),
  })
  .transform((environment) => ({
    databaseUrl: environment.DATABASE_URL,
    workspaceRoot: environment.WORKSPACE_ROOT,
  }));

export type MigrationEnvironment = z.infer<typeof migrationEnvironmentSchema>;

/** Parses the complete environment contract needed by the migration process. */
export function parseMigrationEnvironment(input: unknown): MigrationEnvironment {
  return migrationEnvironmentSchema.parse(input);
}
