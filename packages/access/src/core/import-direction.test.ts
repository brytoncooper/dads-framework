/**
 * What/why: core/ is the generic seam and must not import command/ bindings.
 * A folder walk is the mechanical wall, not a comment.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreDirectory = dirname(fileURLToPath(import.meta.url));

function listTypeScriptFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("core import direction", () => {
  it("does not import command/ from any core module", () => {
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(coreDirectory)) {
      const source = readFileSync(file, "utf8");
      if (
        source.includes('from "../../command') ||
        source.includes('from "../command') ||
        source.includes("from '../../command") ||
        source.includes("from '../command")
      ) {
        offenders.push(relative(coreDirectory, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
