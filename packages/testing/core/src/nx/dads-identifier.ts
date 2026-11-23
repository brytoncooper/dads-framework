/**
 * One spelling for the Dads identifier an Nx name becomes.
 *
 * Both import paths — the recipe the workspace reader writes and the manifest
 * the native reader builds — name the same project, and a task id minted one
 * way must equal the project id minted the other. Encoding the name in one
 * place is what makes that equality hold for every character Nx allows.
 */

/** A stable, collision-free Dads identifier for an arbitrary Nx name. */
export function dadsIdentifier(value: string): string {
  const encoded = Array.from(value, (character) => character.codePointAt(0)?.toString(16) ?? "0").join("-");
  return `nx-${encoded || "empty"}`;
}
