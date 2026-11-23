import { tarballFor } from "./adoption-packing.mjs";

/**
 * Dads packs one tarball per package name. Resolve each transitive Dads name
 * once so npm can share it across requests from different parents. Roots are
 * supplied as tarballs directly by the caller.
 */
export function buildInternalDependencyOverrides(requestedPackages, workspacePackages, tarballs) {
  const visited = new Set(requestedPackages);
  const pending = [...requestedPackages];
  const overrides = {};
  for (const packageName of pending) {
    const workspacePackage = workspacePackages.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Missing workspace package ${packageName}.`);
    }
    const dependencyNames = [
      ...Object.keys(workspacePackage.manifest.dependencies ?? {}),
      ...Object.keys(workspacePackage.manifest.optionalDependencies ?? {}),
    ];
    for (const dependencyName of dependencyNames) {
      if (visited.has(dependencyName) || !workspacePackages.has(dependencyName)) continue;
      visited.add(dependencyName);
      pending.push(dependencyName);
      overrides[dependencyName] = `file:${tarballFor(tarballs, dependencyName)}`;
    }
  }
  return overrides;
}
