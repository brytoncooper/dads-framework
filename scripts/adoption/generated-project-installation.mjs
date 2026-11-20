/**
 * Build npm's nested override form for internal package edges.
 *
 * The generated project's direct dependency itself is intentionally not given
 * a "." override: npm rejects an override that disagrees with a direct
 * dependency (EOVERRIDE). Its internal children are overridden beneath the
 * package selector instead.
 */
export function buildInternalDependencyOverrides(
  requestedPackages,
  workspacePackages,
  tarballs,
) {
  const overrides = {};
  for (const packageName of requestedPackages) {
    const packageOverrides = buildPackageOverrides(
      packageName,
      workspacePackages,
      tarballs,
      new Set(),
    );
    if (Object.keys(packageOverrides).length > 0) {
      overrides[packageName] = packageOverrides;
    }
  }
  return overrides;
}

function buildPackageOverrides(
  packageName,
  workspacePackages,
  tarballs,
  ancestors,
) {
  const workspacePackage = workspacePackages.get(packageName);
  if (!workspacePackage) {
    throw new Error(`Missing workspace package ${packageName}.`);
  }
  if (ancestors.has(packageName)) return {};

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(packageName);
  const overrides = {};
  const dependencyNames = [
    ...Object.keys(workspacePackage.manifest.dependencies ?? {}),
    ...Object.keys(workspacePackage.manifest.optionalDependencies ?? {}),
  ];
  for (const dependencyName of dependencyNames) {
    if (!workspacePackages.has(dependencyName)) continue;
    const tarball = tarballs.get(dependencyName);
    if (typeof tarball !== "string") {
      throw new Error(`Missing packed tarball for ${dependencyName}.`);
    }
    const childOverrides = buildPackageOverrides(
      dependencyName,
      workspacePackages,
      tarballs,
      nextAncestors,
    );
    overrides[dependencyName] = {
      ".": `file:${tarball}`,
      ...childOverrides,
    };
  }
  return overrides;
}
