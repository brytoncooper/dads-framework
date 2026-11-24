import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const RELEASE_SCOPES = new Set(["all", "testing"]);
export const TESTING_FACADE_PACKAGE = "@dads-framework/testing";
const TESTING_NATIVE_PREFIX = "@dads-framework/testing-native-";

function readSemverVersion(filePath, label) {
  const { version } = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Expected a release version in ${label}.`);
  }
  return version;
}

export function releaseVersion(root) {
  return readSemverVersion(join(root, "package.json"), "the root package.json");
}

export function testingReleaseVersion(root) {
  return readSemverVersion(
    join(root, "packages", "testing", "core", "package.json"),
    "packages/testing/core/package.json",
  );
}

export function isTestingReleasePackage(name) {
  return name === TESTING_FACADE_PACKAGE || name.startsWith(TESTING_NATIVE_PREFIX);
}

export function expectedPackageVersion(root, name) {
  return isTestingReleasePackage(name) ? testingReleaseVersion(root) : releaseVersion(root);
}

export function normalizeReleaseScope(scope = "all") {
  if (!RELEASE_SCOPES.has(scope)) {
    throw new Error(`Unsupported release scope "${String(scope)}". Expected "all" or "testing".`);
  }
  return scope;
}
