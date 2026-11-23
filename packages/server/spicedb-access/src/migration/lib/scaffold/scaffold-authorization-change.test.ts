import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { composeAuthorizationChanges, orderAuthorizationChanges } from "../../definition-changes.mjs";
import { loadAuthorizationChanges } from "../journal/load-authorization-changes.js";
import { scaffoldAuthorizationChange } from "./scaffold-authorization-change.js";

const BASELINE = `definition authz/migration_journal {
  relation applied: authz/migration_version
}
definition authz/migration_version {}
definition user {}
`;
const NOW = new Date("2026-10-23T09:00:00Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "authz-authoring-"));
  const journalFolder = join(root, "authz-journal");
  const changesFolder = join(root, "authz-changes");
  mkdirSync(join(journalFolder, "0001_baseline"), { recursive: true });
  writeFileSync(join(journalFolder, "0001_baseline", "schema.zed"), BASELINE);
  writeFileSync(join(journalFolder, "index.ts"), "immutable legacy index\n");
  return {
    journalFolder,
    changesFolder,
    now: NOW,
    nonce: "aaaaaaaa",
    slug: "add_alpha",
    composedSchema: `${BASELINE}\ndefinition test/alpha { relation owner: user }`,
  };
}

describe("scaffoldAuthorizationChange", () => {
  it("authors stable patch metadata without touching any legacy file or shared index", async () => {
    const input = fixture();
    const result = await scaffoldAuthorizationChange(input);
    expect(result).toEqual({
      action: "created",
      id: "20261023090000_aaaaaaaa_add_alpha",
      classification: { kind: "additive" },
    });
    expect(readdirSync(input.journalFolder).sort()).toEqual(["0001_baseline", "index.ts"]);
    expect(readFileSync(join(input.journalFolder, "index.ts"), "utf8")).toBe("immutable legacy index\n");
    await expect(scaffoldAuthorizationChange(input)).resolves.toEqual({
      action: "up-to-date",
      id: "20261023090000_aaaaaaaa_add_alpha",
    });
  });

  it("captures the complete known dependency frontier and supports equal timestamps", async () => {
    const input = fixture();
    const first = await scaffoldAuthorizationChange(input);
    expect(first.action).toBe("created");
    const second = await scaffoldAuthorizationChange({
      ...input,
      nonce: "bbbbbbbb",
      slug: "add_beta",
      composedSchema: `${input.composedSchema}\ndefinition test/beta { relation owner: user }`,
    });
    expect(second.action).toBe("created");
    const changes = await loadAuthorizationChanges(input.changesFolder);
    expect(changes[1]?.dependsOn).toEqual(["20261023090000_aaaaaaaa_add_alpha"]);
    const composed = composeAuthorizationChanges(BASELINE, orderAuthorizationChanges(changes, "0001_baseline"));
    expect(composed).toContain("test/alpha");
    expect(composed).toContain("test/beta");
  });

  it("requires explicit relationship work when a definition or relation retires", async () => {
    const input = fixture();
    const baseline = `${BASELINE}\ndefinition test/document {\n relation owner: user\n relation editor: user\n}\n`;
    writeFileSync(join(input.journalFolder, "0001_baseline", "schema.zed"), baseline);
    const result = await scaffoldAuthorizationChange({
      ...input,
      composedSchema: `${BASELINE}\ndefinition test/document {\n relation owner: user\n}\n`,
    });
    expect(result).toMatchObject({
      action: "created",
      classification: {
        kind: "destructive",
        removals: ["relation test/document#editor"],
      },
    });
    expect(readFileSync(join(input.changesFolder, result.id, "migration.ts"), "utf8")).toContain("TODO(");
  });
});
