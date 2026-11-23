import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AuthorizationMigration,
  LoadedAuthorizationMigration,
} from "./journal-entry.js";

/**
 * The journal definition every snapshot must contain — WriteSchema replaces
 * the whole schema, so a snapshot missing it would delete the journal and
 * orphan the applied markers.
 */
export const JOURNAL_DEFINITION = "authz/migration_journal";

const ENTRY_ID_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*$/;

/**
 * Joins the statically imported journal entries with their on-disk schema
 * snapshots and rejects every malformed shape loudly: bad ids, gaps,
 * duplicates, folders without registered entries, entries without folders,
 * and snapshots missing the journal definition.
 */
export async function loadJournal(
  journal: readonly AuthorizationMigration[],
  journalFolder: string,
): Promise<readonly LoadedAuthorizationMigration[]> {
  const folders = await listEntryFolders(journalFolder);

  const loaded = await Promise.all(
    journal.map(async (entry, index) => {
      const number = entryNumber(entry.id, index);
      if (!folders.includes(entry.id)) {
        throw new Error(
          `authorization journal entry "${entry.id}" has no folder under ${journalFolder}`,
        );
      }
      const schema = await readSnapshot(journalFolder, entry.id);
      return { ...entry, number, schema };
    }),
  );

  const registered = new Set(loaded.map((entry) => entry.id));
  const orphans = folders.filter((folder) => !registered.has(folder));
  if (orphans.length > 0) {
    throw new Error(
      `authorization journal folder(s) not registered in the journal index: ${orphans.join(", ")}`,
    );
  }

  return loaded;
}

function entryNumber(entryId: string, index: number): number {
  const match = ENTRY_ID_PATTERN.exec(entryId);
  if (!match) {
    throw new Error(
      `authorization journal entry "${entryId}" is not named NNNN_slug`,
    );
  }
  const number = Number(match[1]);
  if (number !== index + 1) {
    throw new Error(
      `authorization journal entry "${entryId}" is out of order: ` +
        `position ${String(index + 1)} must be numbered ${String(index + 1).padStart(4, "0")}`,
    );
  }
  return number;
}

/**
 * The entry ids this build ships, sorted — the `NNNN_slug` folders in the
 * journal folder, read without loading any entry. Throws when the folder is
 * missing: an absent journal is a misconfigured process, never "no entries".
 */
export async function listShippedAuthorizationMigrationIds(
  journalFolder: string,
): Promise<readonly string[]> {
  return listEntryFolders(journalFolder);
}

async function listEntryFolders(
  journalFolder: string,
): Promise<readonly string[]> {
  const entries = await readdir(journalFolder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ENTRY_ID_PATTERN.test(name))
    .sort();
}

async function readSnapshot(
  journalFolder: string,
  entryId: string,
): Promise<string> {
  const path = join(journalFolder, entryId, "schema.zed");
  const schema = await readFile(path, "utf8");
  if (schema.trim().length === 0) {
    throw new Error(`authorization schema snapshot ${path} is empty`);
  }
  if (!schema.includes(`definition ${JOURNAL_DEFINITION}`)) {
    throw new Error(
      `authorization schema snapshot ${path} is missing "definition ${JOURNAL_DEFINITION}" — ` +
        `writing it would delete the journal`,
    );
  }
  return schema;
}
