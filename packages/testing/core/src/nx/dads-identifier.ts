/**
 * One spelling for the Dads identifier an Nx name becomes.
 *
 * Both import paths — the recipe the workspace reader writes and the manifest
 * the native reader builds — name the same project, and a task id minted one
 * way must equal the project id minted the other. Safe ASCII names pass through
 * verbatim so plans and reports stay human-readable; any name containing
 * characters Dads forbids (or leading/trailing/double underscores) uses a
 * reversible `_`-prefixed hex escape that round-trips via `decodeDadsIdentifier`.
 */

const plainSafeIdentifier = /^[A-Za-z0-9.-]+(?:_[A-Za-z0-9.-]+)*$/;
const plainSafeTargetIdentifier = /^[A-Za-z0-9.:-]+(?:_[A-Za-z0-9.:-]+)*$/;
const plainChar = /^[A-Za-z0-9.-]$/;
const plainTargetChar = /^[A-Za-z0-9.:-]$/;

/** A readable, stable, collision-free Dads identifier for an arbitrary Nx project name. */
export function dadsIdentifier(value: string): string {
  return encodeIdentifier(value, plainSafeIdentifier, plainChar);
}

/**
 * A readable, collision-free Dads identifier for an Nx target name.
 * Preserves colons verbatim (e.g. `test:integration`) because project ids never contain `:`.
 */
export function dadsTargetIdentifier(value: string): string {
  return encodeIdentifier(value, plainSafeTargetIdentifier, plainTargetChar);
}

/** Combines an Nx project name and target name into a collision-free readable Dads task id. */
export function dadsTaskIdentifier(project: string, target: string): string {
  return `${dadsIdentifier(project)}:${dadsTargetIdentifier(target)}`;
}

/** Reverses `dadsIdentifier` or `dadsTargetIdentifier` back to the exact original Nx name. */
export function decodeDadsIdentifier(id: string): string {
  if (!id.startsWith("_")) return id;
  return id.slice(1).replace(/_([0-9a-f]+)_/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function encodeIdentifier(value: string, safePattern: RegExp, charPattern: RegExp): string {
  if (safePattern.test(value)) return value;
  let encoded = "_";
  for (const character of value) {
    if (charPattern.test(character)) encoded += character;
    else encoded += `_${character.codePointAt(0)?.toString(16) ?? "0"}_`;
  }
  return encoded;
}
