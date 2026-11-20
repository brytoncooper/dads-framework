import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  nativeArchiveTarget,
  verifyNativeExecutable,
} from "./native-executable.mjs";
import { releaseVersion } from "./release-version.mjs";

test("release archives require the exact release version in their name and manifest", (context) => {
  const root = mkdtempSync(join(tmpdir(), "dads-native-release-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const version = "0.2.0-rc.1";
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
    bin: { "dad-test": `./${binary}` },
  };
  const manifestPath = join(packageRoot, "package.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const expectedVersion = releaseVersion(root);
  assert.equal(nativeArchiveTarget(archive, expectedVersion), platform);
  assert.equal(
    verifyNativeExecutable(packageRoot, archive, expectedVersion),
    binary,
  );
  for (const wrongVersion of ["0.1.0", "0X2X0-rcX1"]) {
    assert.equal(
      nativeArchiveTarget(
        `${archivePrefix}${wrongVersion}.tgz`,
        expectedVersion,
      ),
      undefined,
    );
  }

  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, version: "0.1.0" }),
  );
  assert.throws(
    () => verifyNativeExecutable(packageRoot, archive, expectedVersion),
    /manifest does not match/,
  );
});
