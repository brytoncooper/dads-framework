import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWorkspaceFiles } from "./workspace-git-context.js";

describe("verification workspace copies", () => {
  it("keeps installed workspace packages linked to the snapshot", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dads-workspace-links-"));
    try {
      const source = join(temporaryRoot, "original");
      const snapshot = join(temporaryRoot, "snapshot");
      const dependencyDir = join("node_modules", "@example");
      const packageDir = join("packages", "widget");
      const linkTarget = join("..", "..", packageDir);
      const packageEntry = join(source, packageDir, "index.js");
      const snapshotLink = join(snapshot, dependencyDir, "widget");

      mkdirSync(join(source, dependencyDir), { recursive: true });
      mkdirSync(join(source, packageDir), { recursive: true });
      writeFileSync(packageEntry, "captured module");
      symlinkSync(linkTarget, join(source, dependencyDir, "widget"), "dir");

      copyWorkspaceFiles(source, snapshot);
      writeFileSync(packageEntry, "original checkout changed");

      expect(readlinkSync(snapshotLink)).toBe(linkTarget);
      expect(readFileSync(join(snapshotLink, "index.js"), "utf8")).toBe(
        "captured module",
      );
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
