import { access, entityHandle } from "@dads-framework/access";
import { entityIdSchema } from "@dads-framework/contract";
import { MigrationVersion } from "./migration-version.access.js";

/**
 * SpiceDB-side journal. One `applied` fact per successful entry so a
 * restored backup carries its own version marker.
 */
export const MigrationJournal = entityHandle({
  wireName: "authz/migration_journal",
  idSchema: entityIdSchema("AuthzMigrationJournalId", "Authz journal id"),
  kind: "catalog",
});

export const migrationJournal = access(MigrationJournal, {
  roles: {
    applied: MigrationVersion,
  },
  permissions: () => ({}),
});
