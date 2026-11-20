/**
 * The workspace, packed the way npm would publish it.
 *
 * Both adoption proofs start from the same tarballs, so packing lives here
 * once. Every package is packed on every run — nothing is reused between runs —
 * but the packs are independent of each other, so they run at the same time.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { runAdoptionTasks } from "./adoption-task-runner.mjs";

/**
 * Every publishable package under `packages/`, at whatever depth its domain folder puts
 * it. The walk stops at the first `package.json`: a package never contains
 * another one.
 */
export function loadAdoptionPackages(root) {
  const packages = new Map();
  const visit = (directory) => {
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        visit(join(directory, entry.name));
      }
      return;
    }
    if (manifest.private !== true && typeof manifest.name === "string") {
      packages.set(manifest.name, { directory, manifest });
    }
  };
  visit(join(root, "packages"));
  return packages;
}

export async function packAdoptionPackages({ context, tarballRoot, jobs }) {
  const tasks = [...context.packages].map(([packageName, { directory }]) => ({
    name: `pack ${packageName}`,
    run: (transcript) =>
      context.time("pack", async () => {
        // Pack by directory: the native platform packages are not npm workspaces.
        const entry = await transcript.run(
          "npm",
          [
            "pack",
            directory,
            "--json",
            "--pack-destination",
            tarballRoot,
            "--loglevel=error",
          ],
          { cwd: context.root },
        );
        context.tarballs.set(
          packageName,
          join(tarballRoot, packedFilename(packageName, entry.stdout)),
        );
      }),
  }));
  await runAdoptionTasks({ tasks, jobs, label: "pack" });
  return context.tarballs;
}

export function packedFilename(packageName, output) {
  let packed;
  try {
    packed = JSON.parse(output);
  } catch {
    throw new Error(
      `npm pack did not return JSON for ${packageName}: ${output}`,
    );
  }
  const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`npm pack did not name a tarball for ${packageName}.`);
  }
  return filename;
}

/**
 * The internal packages that must be installed as direct roots before
 * `packageName` can be, dependencies first. Optional dependencies are left
 * out: npm treats a direct root as an explicitly requested install.
 */
export function collectPackageClosure(packageName, packages, collected = []) {
  const declaration = packages.get(packageName);
  if (!declaration)
    throw new Error(`Unknown workspace package ${packageName}.`);
  for (const dependencyName of Object.keys(
    declaration.manifest.dependencies ?? {},
  )) {
    if (packages.has(dependencyName)) {
      collectPackageClosure(dependencyName, packages, collected);
    }
  }
  if (!collected.includes(packageName)) collected.push(packageName);
  return collected;
}

export function tarballFor(tarballs, packageName) {
  const tarball = tarballs.get(packageName);
  if (typeof tarball !== "string") {
    throw new Error(`Missing packed tarball for ${packageName}.`);
  }
  return tarball;
}
