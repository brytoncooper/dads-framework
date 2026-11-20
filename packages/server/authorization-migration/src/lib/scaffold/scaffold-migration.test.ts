// The scaffolder is how a journal entry is minted: idempotent when nothing
// changed, additive entries get no step, destructive entries get a
// refuse-to-run TODO naming each removal, and the generated index always
// lists every entry in order.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldMigration } from "./scaffold-migration.js";

const JOURNAL_DEFINITIONS =
  "definition authz/migration_journal { relation applied: authz/migration_version }\n" +
  "definition authz/migration_version {}\n";

const SCHEMA_V1 = `${JOURNAL_DEFINITIONS}definition user {}
definition test/document {
  relation owner: user
  relation editor: user
}
`;

const SCHEMA_V2_DESTRUCTIVE = `${JOURNAL_DEFINITIONS}definition user {}
definition test/document {
  relation owner: user
}
`;

const SCHEMA_V2_ADDITIVE = `${SCHEMA_V1}definition test/folder {
  relation owner: user
}
`;

function journalWithBaseline(): string {
  const folder = mkdtempSync(join(tmpdir(), "authz-scaffold-"));
  mkdirSync(join(folder, "0001_baseline"));
  writeFileSync(join(folder, "0001_baseline", "schema.zed"), SCHEMA_V1);
  return folder;
}

describe("scaffoldMigration", () => {
  it("is a no-op when the composed schema matches the latest snapshot", async () => {
    const folder = journalWithBaseline();
    await expect(
      scaffoldMigration({
        journalFolder: folder,
        composedSchema: SCHEMA_V1,
        slug: "unused",
        mode: "new",
      }),
    ).resolves.toEqual({ action: "up-to-date", id: "0001_baseline" });
  });

  it("scaffolds an additive entry with no relationship step", async () => {
    const folder = journalWithBaseline();
    const result = await scaffoldMigration({
      journalFolder: folder,
      composedSchema: SCHEMA_V2_ADDITIVE,
      slug: "add_folders",
      mode: "new",
    });

    expect(result).toEqual({
      action: "created",
      id: "0002_add_folders",
      classification: { kind: "additive" },
    });
    const migrationFile = readFileSync(
      join(folder, "0002_add_folders", "migration.ts"),
      "utf8",
    );
    expect(migrationFile).not.toContain("TODO(");
    expect(
      readFileSync(join(folder, "0002_add_folders", "schema.zed"), "utf8"),
    ).toBe(SCHEMA_V2_ADDITIVE);
  });

  it("scaffolds a destructive entry with a refuse-to-run TODO naming the removals", async () => {
    const folder = journalWithBaseline();
    const result = await scaffoldMigration({
      journalFolder: folder,
      composedSchema: SCHEMA_V2_DESTRUCTIVE,
      slug: "drop_editors",
      mode: "new",
    });

    expect(result).toEqual({
      action: "created",
      id: "0002_drop_editors",
      classification: {
        kind: "destructive",
        removals: ["relation test/document#editor"],
      },
    });
    const migrationFile = readFileSync(
      join(folder, "0002_drop_editors", "migration.ts"),
      "utf8",
    );
    expect(migrationFile).toContain(
      "TODO(0002_drop_editors): write the relationship steps for: relation test/document#editor",
    );
  });

  it("regenerates the journal index with every entry in order", async () => {
    const folder = journalWithBaseline();
    await scaffoldMigration({
      journalFolder: folder,
      composedSchema: SCHEMA_V2_ADDITIVE,
      slug: "add_folders",
      mode: "new",
    });

    const index = readFileSync(join(folder, "index.ts"), "utf8");
    expect(index).toContain(
      'import { migration as m0001_baseline } from "./0001_baseline/migration";',
    );
    expect(index).toContain(
      'import { migration as m0002_add_folders } from "./0002_add_folders/migration";',
    );
    expect(index).toContain("[m0001_baseline, m0002_add_folders]");
  });

  it("rebaseline rewrites the latest snapshot in place", async () => {
    const folder = journalWithBaseline();
    const result = await scaffoldMigration({
      journalFolder: folder,
      composedSchema: SCHEMA_V2_DESTRUCTIVE,
      mode: "rebaseline",
    });

    expect(result).toEqual({ action: "rebaselined", id: "0001_baseline" });
    expect(
      readFileSync(join(folder, "0001_baseline", "schema.zed"), "utf8"),
    ).toBe(SCHEMA_V2_DESTRUCTIVE);
  });

  it("rejects a slug that is not lowercase_words", async () => {
    const folder = journalWithBaseline();
    await expect(
      scaffoldMigration({
        journalFolder: folder,
        composedSchema: SCHEMA_V2_ADDITIVE,
        slug: "Drop-Editors",
        mode: "new",
      }),
    ).rejects.toThrow(/lowercase words joined by underscores/);
  });
});
