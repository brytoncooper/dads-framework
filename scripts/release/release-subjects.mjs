import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TESTING_FACADE_PACKAGE, expectedPackageVersion, normalizeReleaseScope } from "./release-version.mjs";
import { releaseWorkspaces } from "./release-workspaces.mjs";

const ALL_RELEASE_PACKAGE_COUNT = 24;
const TESTING_RELEASE_PACKAGE_COUNT = 6;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function repositorySlug(root) {
  const { repository } = readJson(join(root, "package.json"));
  const match = /^git\+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(repository?.url);
  if (!match) throw new Error("Expected a canonical GitHub repository in package.json.");
  return match[1];
}

export function releaseSubjects(root, directory, scope = "all") {
  const normalizedScope = normalizeReleaseScope(scope);
  const workspaces = releaseWorkspaces(root);
  const facade = readJson(join(root, "packages/testing/core/package.json"));
  const native = Object.keys(facade.optionalDependencies ?? {});
  const selectedWorkspaces =
    normalizedScope === "testing" ? workspaces.filter(({ name }) => name === TESTING_FACADE_PACKAGE) : workspaces;
  const expectedCount = normalizedScope === "testing" ? TESTING_RELEASE_PACKAGE_COUNT : ALL_RELEASE_PACKAGE_COUNT;
  const expectedNames = new Set([...selectedWorkspaces.map(({ name }) => name), ...native]);
  if (native.length !== 5 || expectedNames.size !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} release names for scope "${normalizedScope}", including five native packages.`,
    );
  }
  const archives = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  if (archives.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} release tarballs for scope "${normalizedScope}".`);
  }

  const repository = `git+https://github.com/${repositorySlug(root)}.git`;
  const remainingNames = new Set(expectedNames);
  const packages = archives.map((filename) => {
    const archive = join(directory, filename);
    if (!lstatSync(archive).isFile()) throw new Error(`Expected a release file: ${filename}`);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
        encoding: "utf8",
        maxBuffer: 128 * 1024,
      }),
    );
    const expectedVersion = expectedPackageVersion(root, manifest.name);
    if (
      !remainingNames.delete(manifest.name) ||
      manifest.version !== expectedVersion ||
      manifest.private === true ||
      manifest.repository?.url !== repository
    )
      throw new Error(`Unexpected package manifest in ${filename}.`);
    const dependencies = [
      ...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]),
    ]
      .filter((name) => expectedNames.has(name))
      .sort();
    return {
      name: manifest.name,
      version: manifest.version,
      filename,
      integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`,
      provenance: `${filename}.sigstore.json`,
      dependencies,
    };
  });
  return orderByDependencyWave(packages);
}

function orderByDependencyWave(packages) {
  const approved = new Set();
  let waiting = packages;
  const ordered = [];
  let wave = 1;
  while (waiting.length > 0) {
    const ready = waiting.filter((entry) => entry.dependencies.every((dependency) => approved.has(dependency)));
    if (ready.length === 0) throw new Error("Release package dependencies contain a cycle.");
    for (const entry of ready) {
      approved.add(entry.name);
      ordered.push({ ...entry, wave });
    }
    waiting = waiting.filter(({ name }) => !approved.has(name));
    wave += 1;
  }
  return ordered;
}
