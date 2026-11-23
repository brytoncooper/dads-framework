export class NodePgMigrationJournalError extends Error {
  readonly code: string;
  readonly migrationId: string;

  constructor(code: string, migrationId: string, message: string) {
    super(message);
    this.name = "NodePgMigrationJournalError";
    this.code = code;
    this.migrationId = migrationId;
  }
}
