import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeArchiveTarget, nativeArchiveRustTarget, verifyNativeExecutable } from "./native-executable.mjs";
import { releaseVersion } from "./release-version.mjs";

test("release archives require the exact release version in their name and manifest", (context) => {
  const root = mkdtempSync(join(tmpdir(), "dads-native-release-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const version = "0.3.0-rc.1";
  const packageRoot = join(root, "package");
  const platform = "linux-arm64-gnu";
  const archivePrefix = `dads-framework-testing-native-${platform}-`;
  const archive = `${archivePrefix}${version}.tgz`;
  const binary = "bin/dad-test";

  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(0xb7, 18);
  writeFileSync(join(packageRoot, binary), bytes);
  const manifest = {
    name: `@dads-framework/testing-native-${platform}`,
    version,
    exports: { ".": `./${binary}` },
  };
  const manifestPath = join(packageRoot, "package.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const expectedVersion = releaseVersion(root);
  assert.equal(nativeArchiveTarget(archive, expectedVersion), platform);
  assert.equal(verifyNativeExecutable(packageRoot, archive, expectedVersion), binary);
  for (const wrongVersion of ["0.1.0", "0X2X0-rcX1"]) {
    assert.equal(nativeArchiveTarget(`${archivePrefix}${wrongVersion}.tgz`, expectedVersion), undefined);
  }

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "0.1.0" }));
  assert.throws(() => verifyNativeExecutable(packageRoot, archive, expectedVersion), /manifest does not match/);

  writeFileSync(manifestPath, JSON.stringify({ ...manifest, bin: { "dad-test": `./${binary}` } }));
  assert.throws(() => verifyNativeExecutable(packageRoot, archive, expectedVersion), /must not declare bin/);
});

test("matches each hosted Rust build record to its versioned npm tarball", () => {
  const platforms = [
    ["darwin-arm64", "aarch64-apple-darwin"],
    ["darwin-x64", "x86_64-apple-darwin"],
    ["linux-arm64-gnu", "aarch64-unknown-linux-gnu"],
    ["linux-x64-gnu", "x86_64-unknown-linux-gnu"],
    ["win32-x64", "x86_64-pc-windows-msvc"],
  ];
  for (const [platform, rustTarget] of platforms) {
    const filename = `dads-framework-testing-native-${platform}-0.3.0.tgz`;
    assert.equal(nativeArchiveRustTarget(filename, "0.3.0"), rustTarget);
    assert.equal(nativeArchiveRustTarget(filename, "0.1.0"), undefined);
  }
  assert.equal(nativeArchiveRustTarget("dads-framework-testing-0.3.0.tgz", "0.3.0"), undefined);
});
