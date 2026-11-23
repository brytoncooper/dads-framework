import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadAdoptionPackages, packedFilename, tarballFor } from "./adoption-packing.mjs";

test("packs published libraries and native binaries while leaving private migration history in the repo", (t) => {
  const root = mkdtempSync(join(tmpdir(), "adoption-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [directory, manifest] of [
    ["server/history", { name: "migration-history", private: true }],
    ["server/flags", { name: "flags" }],
    ["testing/native/linux", { name: "linux-binary" }],
  ]) {
    const path = join(root, "packages", directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
  }
  assert.deepEqual([...loadAdoptionPackages(root).keys()].sort(), ["flags", "linux-binary"]);
});

test("reads the tarball name npm reported", () => {
  assert.equal(
    packedFilename(
      "@dads-framework/core",
      '[{"id":"@dads-framework/core@0.1.0","filename":"dads-framework-core-0.1.0.tgz"}]\n',
    ),
    "dads-framework-core-0.1.0.tgz",
  );
});

test("fails loudly when npm pack did not answer in JSON", () => {
  assert.throws(
    () => packedFilename("@dads-framework/core", "npm warn something\n"),
    /did not return JSON for @dads-framework\/core/,
  );
});

test("fails loudly when npm pack named no tarball", () => {
  assert.throws(() => packedFilename("@dads-framework/http", "[]"), /did not name a tarball/);
  assert.throws(() => packedFilename("@dads-framework/http", '[{"id":"x"}]'), /did not name a tarball/);
});

test("fails loudly when a package was never packed", () => {
  assert.throws(
    () => tarballFor(new Map(), "@dads-framework/toolbox"),
    /Missing packed tarball for @dads-framework\/toolbox/,
  );
  assert.equal(
    tarballFor(new Map([["@dads-framework/toolbox", "/tmp/toolbox.tgz"]]), "@dads-framework/toolbox"),
    "/tmp/toolbox.tgz",
  );
});
