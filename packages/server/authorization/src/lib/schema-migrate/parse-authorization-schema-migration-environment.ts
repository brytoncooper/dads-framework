import { z } from "zod";

const authorizationSchemaMigrationEnvironmentSchema = z
  .object({
    SPICEDB_ENDPOINT: z.string().min(1).default("localhost:50051"),
    SPICEDB_PRESHARED_KEY: z.string().min(1).default("spicedb-local-dev-key"),
    SPICEDB_INSECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    AUTHZ_JOURNAL_FOLDER: z.string().min(1).default("/app/authz-journal"),
    SPICEDB_DATASTORE_CONN_URI: z.string().min(1).optional(),
    SPICEDB_DATASTORE_ADMIN_URL: z.string().min(1).optional(),
  })
  .transform((environment) => ({
    endpoint: environment.SPICEDB_ENDPOINT,
    presharedKey: environment.SPICEDB_PRESHARED_KEY,
    insecure: environment.SPICEDB_INSECURE,
    journalFolder: environment.AUTHZ_JOURNAL_FOLDER,
    datastorePostgresUrl: environment.SPICEDB_DATASTORE_CONN_URI,
    datastoreAdminUrl: environment.SPICEDB_DATASTORE_ADMIN_URL,
  }));

export type AuthorizationSchemaMigrationEnvironment = z.infer<
  typeof authorizationSchemaMigrationEnvironmentSchema
>;

/** Parses SpiceDB schema-migrate settings for the database-migration process. */
export function parseAuthorizationSchemaMigrationEnvironment(
  input: unknown,
): AuthorizationSchemaMigrationEnvironment {
  return authorizationSchemaMigrationEnvironmentSchema.parse(input);
}
