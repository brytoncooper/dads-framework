import type { MigrationWorkspace } from "./migration-workspace.js";
import type { MigrationBuilder } from "node-pg-migrate";

export type DomainMigrationFunction = (
  pgm: MigrationBuilder,
) => void | Promise<void>;

export type DomainMigration = {
  id: string;
  owner: string;
  up: DomainMigrationFunction;
  down: DomainMigrationFunction | false;
  dependsOn?: readonly string[];
  /** Commit this file alone, so its locks end with it. Graph files only. */
  ownTransaction?: true;
  /**
   * Run this file alone and outside any transaction, so its indexes build
   * with `CONCURRENTLY` and a large live table keeps taking writes. Only
   * `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS` and
   * `DROP INDEX CONCURRENTLY IF EXISTS` are allowed; anything else is
   * refused before any SQL runs. Graph files only.
   */
  buildsIndexesConcurrently?: true;
};

export type DiscoveredDomainMigration = DomainMigration & {
  filePath: string;
  journalName: string;
};

/** One migration file this build ships, described without loading it. */
export type ShippedDatabaseMigrationFile = {
  /** File name without `.ts` — the name the applied journal records. */
  journalName: string;
  /** The owner its migration source names (a kit part, or the app). */
  owner: string;
  /** Path relative to the workspace root, POSIX separators. */
  file: string;
  /** SHA-256 of the file's bytes, as the runner checksums it. */
  sha256: string;
};

export type DiscoverDomainMigrationsInput = {
  workspace: MigrationWorkspace;
  appliedIds?: readonly string[];
};
