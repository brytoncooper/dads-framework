/**
 * Return whether a package is executable-only for adoption verification.
 *
 * This intentionally recognizes only two unambiguous native-package shapes:
 * - the root export is a string and exactly matches a declared bin target; or
 * - the package is platform-scoped (`os` and `cpu` string arrays) and its root
 *   export is a non-JavaScript executable under `./bin/` (no duplicate `bin`
 *   field that would clobber the facade CLI symlink on npm install).
 * Unknown or malformed manifest data is treated as importable (false).
 */
export function isExecutableOnlyAdoptionPackage(manifest) {
  if (!isRecord(manifest)) return false;
  const exportsField = manifest.exports;
  if (!isRecord(exportsField) || typeof exportsField["."] !== "string") {
    return false;
  }
  const rootExport = exportsField["."];
  const binTargets = readBinTargets(manifest.bin);
  if (binTargets === undefined) return false;
  if (binTargets.includes(rootExport)) return true;
  return isPlatformNativeBinaryExport(manifest, rootExport);
}

function isPlatformNativeBinaryExport(manifest, rootExport) {
  if (!isNonEmptyStringArray(manifest.os) || !isNonEmptyStringArray(manifest.cpu)) {
    return false;
  }
  if (!rootExport.startsWith("./bin/") || rootExport.includes("..")) return false;
  return !/\.(?:[cm]?js|json|node)$/u.test(rootExport);
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function readBinTargets(bin) {
  if (typeof bin === "string") return [bin];
  if (!isRecord(bin)) return bin === undefined ? [] : undefined;
  const targets = [];
  for (const target of Object.values(bin)) {
    if (typeof target !== "string") return undefined;
    targets.push(target);
  }
  return targets;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
