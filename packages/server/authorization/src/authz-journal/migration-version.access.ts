import { access, entityHandle } from "@dads-framework/access";
import { entityIdSchema } from "@dads-framework/contract";

/**
 * Journal marker type. Grants nothing; the runner records applied
 * entries as relationships on this type.
 */
export const MigrationVersion = entityHandle({
  wireName: "authz/migration_version",
  idSchema: entityIdSchema(
    "AuthzMigrationVersionId",
    "Authz journal version id",
  ),
  kind: "catalog",
});

export const migrationVersion = access(MigrationVersion, {
  roles: {},
  permissions: () => ({}),
});
