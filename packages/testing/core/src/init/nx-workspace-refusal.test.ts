import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initTestingManifest } from "./init-testing-manifest.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("does not present root script discovery as coverage of an Nx workspace", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "dads-nx-init-"));
  directories.push(workspaceRoot);
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "harbor", scripts: { build: "node build.mjs" } }),
  );
  writeFileSync(
    join(workspaceRoot, "nx.json"),
    "{ // inferred tasks live here\n}",
  );
  await expect(
    initTestingManifest({
      workspaceRoot,
      resolveNativeBinary: () => undefined,
    }),
  ).rejects.toThrow("cannot establish Nx target coverage");
  expect(existsSync(join(workspaceRoot, "dads.testing.json"))).toBe(false);
  expect(
    JSON.parse(
      readFileSync(
        join(workspaceRoot, "dads.testing.init-report.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({
    manifestChecksum: null,
    validation: { method: "none", ok: false },
    unsupported: [{ subject: "nx.json" }],
  });
});

it("preserves an existing manifest when Nx discovery is refused with force", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "dads-nx-init-"));
  directories.push(workspaceRoot);
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node test.mjs" } }),
  );
  writeFileSync(join(workspaceRoot, "nx.json"), "{}");
  const manifest = join(workspaceRoot, "dads.testing.json");
  writeFileSync(manifest, "previous manifest\n");
  await expect(
    initTestingManifest({ workspaceRoot, force: true }),
  ).rejects.toThrow("No manifest was written");
  expect(readFileSync(manifest, "utf8")).toBe("previous manifest\n");
});
