// The journal loader is the runner's input validation: malformed ids, gaps,
// unregistered folders, missing snapshots, and snapshots that would delete
// the journal definition itself must all fail loudly before anything is
// applied.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthorizationMigration } from "./journal-entry.js";
import { listShippedAuthorizationMigrationIds, loadJournal } from "./load-journal.js";

const JOURNAL_SCHEMA_LINES =
  "definition authz/migration_journal { relation applied: authz/migration_version }\n" +
  "definition authz/migration_version {}\n";

function writeJournalFolder(entries: readonly { id: string; schema?: string }[]): string {
  const folder = mkdtempSync(join(tmpdir(), "authz-journal-"));
  for (const entry of entries) {
    mkdirSync(join(folder, entry.id));
    writeFileSync(join(folder, entry.id, "schema.zed"), entry.schema ?? `// ${entry.id}\n${JOURNAL_SCHEMA_LINES}`);
  }
  return folder;
}

function entry(id: string): AuthorizationMigration {
  return { id };
}

describe("loadJournal", () => {
  it("joins registered entries with their snapshots in order", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline" }, { id: "0002_split_roles" }]);

    const loaded = await loadJournal([entry("0001_baseline"), entry("0002_split_roles")], folder);

    expect(loaded.map((item) => item.number)).toEqual([1, 2]);
    expect(loaded[1]?.schema).toContain("// 0002_split_roles");
  });

  it("rejects an id that is not NNNN_slug", async () => {
    const folder = writeJournalFolder([]);
    await expect(loadJournal([entry("baseline")], folder)).rejects.toThrow(/not named NNNN_slug/);
  });

  it("rejects a numbering gap", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline" }, { id: "0003_late" }]);
    await expect(loadJournal([entry("0001_baseline"), entry("0003_late")], folder)).rejects.toThrow(
      /out of order.*0002/,
    );
  });

  it("rejects an entry with no folder", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline" }]);
    await expect(loadJournal([entry("0001_baseline"), entry("0002_missing")], folder)).rejects.toThrow(/no folder/);
  });

  it("rejects a folder not registered in the index", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline" }, { id: "0002_forgotten" }]);
    await expect(loadJournal([entry("0001_baseline")], folder)).rejects.toThrow(/not registered.*0002_forgotten/);
  });

  it("rejects a snapshot missing the journal definition", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline", schema: "definition user {}\n" }]);
    await expect(loadJournal([entry("0001_baseline")], folder)).rejects.toThrow(
      /missing "definition authz\/migration_journal"/,
    );
  });

  it("rejects an empty snapshot", async () => {
    const folder = writeJournalFolder([{ id: "0001_baseline", schema: "\n" }]);
    await expect(loadJournal([entry("0001_baseline")], folder)).rejects.toThrow(/is empty/);
  });
});

describe("listShippedAuthorizationMigrationIds", () => {
  it("lists only NNNN_slug folders, sorted, without reading snapshots", async () => {
    const folder = writeJournalFolder([{ id: "0002_split_roles", schema: "" }, { id: "0001_baseline" }]);
    mkdirSync(join(folder, "not-an-entry"));
    writeFileSync(join(folder, "0003_a_file_not_a_folder"), "");

    await expect(listShippedAuthorizationMigrationIds(folder)).resolves.toEqual(["0001_baseline", "0002_split_roles"]);
  });

  it("refuses a missing journal folder rather than reporting no entries", async () => {
    const folder = join(writeJournalFolder([]), "missing");

    await expect(listShippedAuthorizationMigrationIds(folder)).rejects.toThrow(/ENOENT/);
  });
});
