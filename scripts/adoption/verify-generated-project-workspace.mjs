/**
 * Installing phase of the generated-project proof.
 *
 * Every package in this workspace is packed to a tarball and installed from
 * that tarball, so the generated project is checked against what an adopter
 * would download rather than against the source tree beside it. Packing itself
 * lives in `adoption-packing.mjs` because both proofs need it;
 * `verify-generated-project.mjs` owns the run, and the recipe and artifact
 * assertions live in `verify-generated-project-recipes.mjs`.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectPackageClosure, tarballFor } from "./adoption-packing.mjs";
import { buildInternalDependencyOverrides } from "./generated-project-installation.mjs";

const INSTALL_FLAGS = ["--no-save", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Install the packed creator into its own host project and return where it
 * landed: `host` is what the creator is run from, `executable` is the packed
 * binary itself.
 */
export async function installCreator(transcript, context) {
  const host = join(context.workRoot, "creator-host");
  mkdirSync(host);
  writeFileSync(join(host, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const packages = collectPackageClosure("create-dads", context.packages);
  await transcript.run(
    "npm",
    ["install", ...INSTALL_FLAGS, ...packages.map((packageName) => tarballFor(context.tarballs, packageName))],
    { cwd: host },
  );
  const executable = join(host, "node_modules", "create-dads", "bin", "create-dads.js");
  assertExecutable(executable);
  return { host, executable };
}

export async function installGeneratedProject(transcript, projectRoot, context) {
  const packageManifestPath = join(projectRoot, "package.json");
  const originalManifest = readFileSync(packageManifestPath, "utf8");
  const manifest = JSON.parse(originalManifest);
  const requestedPackages = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ].filter((packageName) => context.packages.has(packageName));
  const packageNames = [];
  for (const packageName of requestedPackages) {
    collectPackageClosure(packageName, context.packages, packageNames);
  }
  manifest.overrides = buildInternalDependencyOverrides(packageNames, context.packages, context.tarballs);
  writeFileSync(packageManifestPath, JSON.stringify(manifest, null, 2) + "\n");
  try {
    await transcript.run(
      "npm",
      [
        "install",
        "--no-package-lock",
        ...INSTALL_FLAGS,
        ...packageNames.map((packageName) => tarballFor(context.tarballs, packageName)),
      ],
      { cwd: projectRoot },
    );
  } finally {
    writeFileSync(packageManifestPath, originalManifest);
  }
}

export function runCreator(transcript, creator, argumentsAfterExecutable) {
  return transcript.run(creator.executable, argumentsAfterExecutable, {
    cwd: creator.host,
  });
}

export function assertExecutable(path) {
  if ((statSync(path).mode & 0o111) === 0) {
    throw new Error("Packed create-dads executable has no execute bit.");
  }
}
