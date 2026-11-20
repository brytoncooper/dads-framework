/**
 * How a migration declares its order, read the way its runner reads it.
 *
 * The cases worth writing down are the ones where a statement of order is
 * present but cannot be trusted: a `dependsOn` the module does not export, a
 * `let`, a list that is not a literal, a name in the wrong shape, and one name
 * twice. Each is `invalid` rather than a guess at what was meant.
 */

import { describe, expect, it } from "vitest";
import {
  isMigrationFile,
  migrationJournal,
  migrationName,
  migrationStamp,
  readPrerequisites,
} from "./migration-files.js";

const PATH = "packages/store/src/migrations/20260701000000_create.migration.ts";
const NAME = "20260601000000_base.migration";

describe("migration files", () => {
  it("reads the stamp, the journal and the name from the path", () => {
    expect(isMigrationFile(PATH)).toBe(true);
    expect(isMigrationFile("packages/store/src/create.ts")).toBe(false);
    expect(migrationStamp(PATH)).toBe("20260701000000");
    expect(migrationJournal(PATH)).toBe("packages/store/src/migrations");
    expect(migrationName(PATH)).toBe("20260701000000_create.migration");
  });

  it("leaves the order to the stamp when nothing states it", () => {
    expect(readPrerequisites(PATH, 'export const up = "x";\n')).toStrictEqual({
      kind: "stamp",
    });
  });

  it("reads an exported literal list of journal names", () => {
    const text = `export const dependsOn = ["${NAME}"];\n`;
    expect(readPrerequisites(PATH, text)).toStrictEqual({
      kind: "graph",
      dependencies: [NAME],
    });
  });

  it("refuses every statement of order the runner cannot read", () => {
    const refused = [
      `const dependsOn = ["${NAME}"];\n`,
      `export let dependsOn = ["${NAME}"];\n`,
      `export const dependsOn = names;\n`,
      `export const dependsOn = ["base"];\n`,
      `export const dependsOn = ["${NAME}", "${NAME}"];\n`,
    ];
    for (const text of refused) {
      expect({ text, read: readPrerequisites(PATH, text) }).toStrictEqual({
        text,
        read: { kind: "invalid" },
      });
    }
  });
});
