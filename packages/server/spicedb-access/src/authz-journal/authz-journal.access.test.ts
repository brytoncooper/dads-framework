import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileAccess, emitZed } from "@dads-framework/access";
import { migrationJournal } from "./migration-journal.access.js";
import { migrationVersion } from "./migration-version.access.js";

describe("authz journal access", () => {
  it("keeps the checked-in SpiceDB fragment in sync with the journal model", () => {
    const model = compileAccess([migrationVersion, migrationJournal]);
    const artifact = new URL("../generated/authz-migration.zed", import.meta.url);

    expect(readFileSync(artifact, "utf8")).toBe(emitZed(model));
  });
});
