import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { parsePackPreflightArgs } from "./pack-preflight.mjs";
import { releaseSubjects, repositorySlug } from "./release-subjects.mjs";
import { testingSourceSteps } from "./verify-testing-source.mjs";
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

test("testingSourceSteps covers all required testing-scope release proofs", () => {
  const steps = testingSourceSteps(repoRoot, { VITEST_MAX_WORKERS: "2" });
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const required of [
    "sync-licenses",
    "build",
    "format",
    "vitest-testing",
    "test-types",
    "eslint-testing",
    "docs",
    "invariants",
    "dependency-boundaries",
    "private-references",
    "api-report",
    "markdown-links",
    "script-tests",
  ]) {
    assert.ok(byId.has(required), `missing testing-source step ${required}`);
  }
  assert.ok(byId.get("vitest-testing").args.includes("--maxWorkers=2"));
  assert.ok(byId.get("vitest-testing").args.includes("packages/testing/core/"));
  const scriptTestArgs = byId.get("script-tests").args;
  assert.ok(scriptTestArgs.includes("scripts/release/release-scope.test.mjs"));
  assert.ok(scriptTestArgs.includes("scripts/testing/verify-testing-release.test.mjs"));
});

test("release workflows split facade build and pin gitleaks SHA-256 without weakening scope=all", () => {
  const nativeWorkflow = readFileSync(join(repoRoot, ".github/workflows/testing-native-release.yml"), "utf8");
  assert.match(nativeWorkflow, /^ {2}facade:/m);
  assert.match(nativeWorkflow, /^ {4}needs: facade$/m);
  assert.match(nativeWorkflow, /dads-testing-facade-\$\{\{ github\.run_attempt \}\}/);
  // Only the single ubuntu facade job runs npm ci; the 5 OS native runners do not.
  assert.equal([...nativeWorkflow.matchAll(/npm ci --ignore-scripts/g)].length, 1);

  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-artifacts.yml"), "utf8");
  assert.match(releaseWorkflow, /node scripts\/release\/verify-testing-source\.mjs/);
  assert.match(releaseWorkflow, /npm run verify -- --no-cache --require-receipt/);
  assert.match(releaseWorkflow, /9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c/);
  assert.doesNotMatch(releaseWorkflow, /actions\/setup-go/);
});
