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
const plainChar = /^[A-Za-z0-9.-]$/;

/** A readable, stable, collision-free Dads identifier for an arbitrary Nx name. */
export function dadsIdentifier(value: string): string {
  if (plainSafeIdentifier.test(value)) return value;
  let encoded = "_";
  for (const character of value) {
    if (plainChar.test(character)) encoded += character;
    else encoded += `_${character.codePointAt(0)?.toString(16) ?? "0"}_`;
  }
  return encoded;
}

/** Reverses `dadsIdentifier` back to the exact original Nx name. */
export function decodeDadsIdentifier(id: string): string {
  if (!id.startsWith("_")) return id;
  return id.slice(1).replace(/_([0-9a-f]+)_/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}
