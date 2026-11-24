import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { parsePackPreflightArgs } from "./pack-preflight.mjs";
import { releaseSubjects, repositorySlug } from "./release-subjects.mjs";
import {
  expectedPackageVersion,
  isTestingReleasePackage,
  normalizeReleaseScope,
  releaseVersion,
  testingReleaseVersion,
} from "./release-version.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function createFakeTarball(outputDir, filename, manifest) {
  const stage = mkdtempSync(join(tmpdir(), "dads-release-tar-"));
  try {
    const pkgDir = join(stage, "package");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    execFileSync("tar", ["-czf", join(outputDir, filename), "-C", stage, "package"]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

test("testing release version is decoupled from root framework version", (context) => {
  const root = mkdtempSync(join(tmpdir(), "dads-release-version-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.6.5" }));
  mkdirSync(join(root, "packages", "testing", "core"), { recursive: true });
  writeFileSync(
    join(root, "packages", "testing", "core", "package.json"),
    JSON.stringify({ name: "@dads-framework/testing", version: "0.7.0" }),
  );

  assert.equal(releaseVersion(root), "0.6.5");
  assert.equal(testingReleaseVersion(root), "0.7.0");
  assert.equal(isTestingReleasePackage("@dads-framework/testing"), true);
  assert.equal(isTestingReleasePackage("@dads-framework/testing-native-linux-x64-gnu"), true);
  assert.equal(isTestingReleasePackage("@dads-framework/toolbox"), false);
  assert.equal(expectedPackageVersion(root, "@dads-framework/testing"), "0.7.0");
  assert.equal(expectedPackageVersion(root, "@dads-framework/testing-native-darwin-arm64"), "0.7.0");
  assert.equal(expectedPackageVersion(root, "@dads-framework/toolbox"), "0.6.5");
  assert.equal(normalizeReleaseScope(undefined), "all");
  assert.equal(normalizeReleaseScope("testing"), "testing");
  assert.throws(() => normalizeReleaseScope("framework"), /Unsupported release scope/);
});

test("pack-preflight argument parser supports --scope testing and rejects invalid combinations", () => {
  assert.deepEqual(parsePackPreflightArgs([]), {
    packageName: undefined,
    outputDirectory: undefined,
    scope: "all",
  });
  assert.deepEqual(parsePackPreflightArgs(["--scope", "testing"]), {
    packageName: undefined,
    outputDirectory: undefined,
    scope: "testing",
  });
  const withOutput = parsePackPreflightArgs(["--scope", "testing", "--output", "tmp/out"]);
  assert.equal(withOutput.scope, "testing");
  assert.equal(withOutput.packageName, undefined);
  assert.ok(withOutput.outputDirectory?.endsWith("tmp/out"));

  assert.throws(() => parsePackPreflightArgs(["--scope", "invalid"]), /Unsupported release scope/);
  assert.throws(() => parsePackPreflightArgs(["@dads-framework/testing", "--output", "tmp/out"]), /Cannot combine/);
});

test("releaseSubjects supports testing scope with 6 packages and 2 dependency waves", (context) => {
  const tarDir = mkdtempSync(join(tmpdir(), "dads-release-subjects-"));
  context.after(() => rmSync(tarDir, { recursive: true, force: true }));

  const testingVersion = testingReleaseVersion(repoRoot);
  const repository = `git+https://github.com/${repositorySlug(repoRoot)}.git`;
  const facade = JSON.parse(readFileSync(join(repoRoot, "packages/testing/core/package.json"), "utf8"));
  const nativeNames = Object.keys(facade.optionalDependencies ?? {});
  assert.equal(nativeNames.length, 5);

  for (const name of nativeNames) {
    const suffix = name.replace("@dads-framework/", "");
    createFakeTarball(tarDir, `dads-framework-${suffix}-${testingVersion}.tgz`, {
      name,
      version: testingVersion,
      repository: { type: "git", url: repository },
    });
  }
  createFakeTarball(tarDir, `dads-framework-testing-${testingVersion}.tgz`, {
    name: "@dads-framework/testing",
    version: testingVersion,
    optionalDependencies: Object.fromEntries(nativeNames.map((name) => [name, testingVersion])),
    repository: { type: "git", url: repository },
  });

  const subjects = releaseSubjects(repoRoot, tarDir, "testing");
  assert.equal(subjects.length, 6);
  const wave1 = subjects.filter((entry) => entry.wave === 1);
  const wave2 = subjects.filter((entry) => entry.wave === 2);
  assert.equal(wave1.length, 5);
  assert.equal(wave2.length, 1);
  assert.equal(wave2[0].name, "@dads-framework/testing");
  assert.equal(wave2[0].version, testingVersion);
  assert.deepEqual(wave2[0].dependencies, [...nativeNames].sort());

  // Full scope rejects a testing-only tarball directory.
  assert.throws(() => releaseSubjects(repoRoot, tarDir, "all"), /Expected exactly 24 release tarballs/);
});
