import { actor } from "@dads-framework/access";
import { entityIdSchema } from "@dads-framework/contract";

/**
 * Journal marker type. Grants nothing; the runner records applied
 * entries as relationships on this type.
 */
export const MigrationVersion = actor("authz/migration_version", {
  id: entityIdSchema("AuthzMigrationVersionId", "Authz journal version id"),
});

export const migrationVersion = MigrationVersion;
