import { resource } from "@dads-framework/access";
import { entityIdSchema } from "@dads-framework/contract";
import { MigrationVersion } from "./migration-version.access.js";

/**
 * SpiceDB-side journal. One `applied` fact per successful entry so a
 * restored backup carries its own version marker.
 */
export const migrationJournal = resource("authz/migration_journal", {
  id: entityIdSchema("AuthzMigrationJournalId", "Authz journal id"),
  roles: {
    applied: MigrationVersion,
  },
  can: () => ({}),
});

export const MigrationJournal = migrationJournal;
