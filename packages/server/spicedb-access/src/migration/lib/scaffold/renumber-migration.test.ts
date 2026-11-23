// Renumbering is how a branch whose journal entry collided with main's gets
// back in line: only the branch's own entry moves, refusals fire before any
// write, the migration.ts body survives under the new id, and a changed
// additive/destructive verdict stops for review.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planRenumber,
  renumberMigration,
  rewriteMigrationId,
} from "./renumber-migration.js";

const JOURNAL_DEFINITIONS =
  "definition authz/migration_journal { relation applied: authz/migration_version }\n" +
  "definition authz/migration_version {}\n";

const BASE = `${JOURNAL_DEFINITIONS}definition user {}
definition test/document {
  relation owner: user
  relation editor: user
}
`;

/** Main's own second entry: adds folders. */
const MAIN_FOLDERS = `${BASE}definition test/folder {
  relation owner: user
}
`;

/** The branch's change authored on BASE: adds tags. */
const BRANCH_TAGS = `${BASE}definition test/tag {
  relation owner: user
}
`;

/** The branch's change recomposed on main: folders and tags. */
const COMPOSED_FOLDERS_AND_TAGS = `${MAIN_FOLDERS}definition test/tag {
  relation owner: user
}
`;

const BRANCH_MIGRATION = `import type { AuthorizationMigration } from "../../index.js";

/** Tags are new; nothing to move. */
export const migration: AuthorizationMigration = {
  id: "0002_add_tags",
};
`;

function writeEntry(
  folder: string,
  id: string,
  schema: string,
  migration?: string,
): void {
  mkdirSync(join(folder, id));
  writeFileSync(join(folder, id, "schema.zed"), schema);
  writeFileSync(
    join(folder, id, "migration.ts"),
    migration ?? `export const migration = { id: "${id}" };\n`,
  );
}

/** A journal rebased on main (0001, 0002_add_folders) carrying the branch's colliding 0002_add_tags. */
function collidingJournal(): string {
  const folder = mkdtempSync(join(tmpdir(), "authz-renumber-"));
  writeEntry(folder, "0001_baseline", BASE);
  writeEntry(folder, "0002_add_folders", MAIN_FOLDERS);
  writeEntry(folder, "0002_add_tags", BRANCH_TAGS, BRANCH_MIGRATION);
  return folder;
}

describe("planRenumber", () => {
  const main = ["0001_baseline", "0002_add_folders"];

  it("has nothing to do when the branch adds no entry", () => {
    expect(planRenumber({ mainEntryIds: main, headEntryIds: main })).toEqual({
      kind: "no-own-entry",
    });
  });

  it("finds the branch's own entry as the one main lacks", () => {
    expect(
      planRenumber({
        mainEntryIds: main,
        headEntryIds: ["0001_baseline", "0002_add_folders", "0002_add_tags"],
      }),
    ).toEqual({ kind: "renumber", entryId: "0002_add_tags" });
  });

  it("leaves an entry that already has the next number alone", () => {
    expect(
      planRenumber({
        mainEntryIds: main,
        headEntryIds: [...main, "0003_add_tags"],
      }),
    ).toEqual({ kind: "already-next", entryId: "0003_add_tags" });
  });

  it("refuses two own entries and says to fold them into one", () => {
    expect(() =>
      planRenumber({
        mainEntryIds: main,
        headEntryIds: [...main, "0002_add_tags", "0003_add_labels"],
      }),
    ).toThrow(/adds 2 journal entries .*fold them into one/);
  });

  it("refuses a branch that is not rebased on main", () => {
    expect(() =>
      planRenumber({
        mainEntryIds: main,
        headEntryIds: ["0001_baseline", "0002_add_tags"],
      }),
    ).toThrow(/lacks main's journal entries \(0002_add_folders\).*rebase/);
  });
});

describe("rewriteMigrationId", () => {
  it("moves the id and every other mention of it", () => {
    const source =
      `export const migration = {\n  id: "0002_add_tags",\n` +
      `  beforeSchemaWrite: () => { throw new Error("TODO(0002_add_tags): x"); },\n};\n`;
    expect(rewriteMigrationId(source, "0002_add_tags", "0003_add_tags")).toBe(
      `export const migration = {\n  id: "0003_add_tags",\n` +
        `  beforeSchemaWrite: () => { throw new Error("TODO(0003_add_tags): x"); },\n};\n`,
    );
  });

  it("refuses a body that does not declare the id exactly once", () => {
    expect(() =>
      rewriteMigrationId(
        `export const migration = { id: ID };\n`,
        "0002_add_tags",
        "0003_add_tags",
      ),
    ).toThrow(/exactly once, found 0/);
  });
});

describe("renumberMigration", () => {
  it("re-mints the branch's entry next, with a fresh snapshot and its own body", async () => {
    const folder = collidingJournal();

    const result = await renumberMigration({
      journalFolder: folder,
      entryId: "0002_add_tags",
      composedSchema: COMPOSED_FOLDERS_AND_TAGS,
      acceptClassificationChange: false,
    });

    expect(result).toEqual({
      action: "renumbered",
      oldId: "0002_add_tags",
      newId: "0003_add_tags",
      classification: { kind: "additive" },
      classificationChanged: false,
    });
    expect(existsSync(join(folder, "0002_add_tags"))).toBe(false);
    expect(
      readFileSync(join(folder, "0003_add_tags", "schema.zed"), "utf8"),
    ).toBe(COMPOSED_FOLDERS_AND_TAGS);
    expect(
      readFileSync(join(folder, "0003_add_tags", "migration.ts"), "utf8"),
    ).toBe(BRANCH_MIGRATION.replace("0002_add_tags", "0003_add_tags"));
    expect(readFileSync(join(folder, "index.ts"), "utf8")).toContain(
      "[m0001_baseline, m0002_add_folders, m0003_add_tags]",
    );
  });

  it("leaves main's entries byte-for-byte untouched", async () => {
    const folder = collidingJournal();
    const before = readFileSync(
      join(folder, "0002_add_folders", "migration.ts"),
      "utf8",
    );

    await renumberMigration({
      journalFolder: folder,
      entryId: "0002_add_tags",
      composedSchema: COMPOSED_FOLDERS_AND_TAGS,
      acceptClassificationChange: false,
    });

    expect(
      readFileSync(join(folder, "0002_add_folders", "migration.ts"), "utf8"),
    ).toBe(before);
    expect(
      readFileSync(join(folder, "0002_add_folders", "schema.zed"), "utf8"),
    ).toBe(MAIN_FOLDERS);
  });

  it("stops without writing when the entry turns destructive against main", async () => {
    const folder = collidingJournal();
    // Main's folders are gone from the recomposed schema: against main that
    // removes a definition, which the branch never reviewed.
    const result = await renumberMigration({
      journalFolder: folder,
      entryId: "0002_add_tags",
      composedSchema: BRANCH_TAGS,
      acceptClassificationChange: false,
    });

    expect(result).toEqual({
      action: "classification-changed",
      before: { kind: "additive" },
      after: { kind: "destructive", removals: ["definition test/folder"] },
    });
    expect(readdirSync(folder).sort()).toEqual([
      "0001_baseline",
      "0002_add_folders",
      "0002_add_tags",
    ]);
  });

  it("proceeds past a changed classification only when told to", async () => {
    const folder = collidingJournal();

    const result = await renumberMigration({
      journalFolder: folder,
      entryId: "0002_add_tags",
      composedSchema: BRANCH_TAGS,
      acceptClassificationChange: true,
    });

    expect(result).toMatchObject({
      action: "renumbered",
      newId: "0003_add_tags",
      classificationChanged: true,
    });
  });

  it("writes nothing when main already ships the branch's schema", async () => {
    const folder = collidingJournal();

    await expect(
      renumberMigration({
        journalFolder: folder,
        entryId: "0002_add_tags",
        composedSchema: MAIN_FOLDERS,
        acceptClassificationChange: false,
      }),
    ).resolves.toEqual({
      action: "subsumed-by-main",
      latestMainId: "0002_add_folders",
    });
    expect(existsSync(join(folder, "0002_add_tags"))).toBe(true);
  });
});
