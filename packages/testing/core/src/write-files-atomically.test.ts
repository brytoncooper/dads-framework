import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFilesAtomically } from "./write-files-atomically.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic file writing", () => {
  it("writes every output into place", () => {
    const directory = makeTemporaryDirectory();

    writeFilesAtomically([
      { path: join(directory, "one.json"), contents: "1\n" },
      { path: join(directory, "two.json"), contents: "2\n" },
    ]);

    expect(readFileSync(join(directory, "one.json"), "utf8")).toBe("1\n");
    expect(readFileSync(join(directory, "two.json"), "utf8")).toBe("2\n");
    expect(readdirSync(directory).sort()).toEqual(["one.json", "two.json"]);
  });

  it("removes every temporary file and writes nothing when one output fails", () => {
    const directory = makeTemporaryDirectory();

    expect(() => {
      writeFilesAtomically([
        { path: join(directory, "one.json"), contents: "1\n" },
        {
          path: join(directory, "missing-directory", "two.json"),
          contents: "2\n",
        },
      ]);
    }).toThrow();

    expect(readdirSync(directory)).toEqual([]);
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-atomic-"));
  temporaryDirectories.push(directory);
  return directory;
}
