/**
 * Return whether a package is executable-only for adoption verification.
 *
 * This intentionally recognizes only the unambiguous native-package shape:
 * the root export is a string and exactly matches a declared bin target.
 * Unknown or malformed manifest data is treated as importable (false).
 */
export function isExecutableOnlyAdoptionPackage(manifest) {
  if (!isRecord(manifest)) return false;
  const exportsField = manifest.exports;
  const binTargets = readBinTargets(manifest.bin);
  if (
    !isRecord(exportsField) ||
    typeof exportsField["."] !== "string" ||
    binTargets === undefined
  ) {
    return false;
  }
  return binTargets.includes(exportsField["."]);
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
