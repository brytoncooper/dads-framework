/**
 * pdf.js #19694 and #19822: a PDF with a malformed structure tree makes
 * `getStructTree()` reject, and pdf.js's viewer does not catch it, so the
 * rejection surfaces as an uncaught error. pdf.js's `StructTreeLayerBuilder`
 * already treats a null tree as "no tree", so the guard turns a rejection
 * into null.
 */

/**
 * A property rather than a method signature: the guard reads the original
 * function off the target and calls it with the target as `this`.
 */
export type StructTreeSource = {
  getStructTree: () => Promise<unknown>;
};

/** Every guard this module has installed, so a second call never wraps twice. */
const installedGuards = new WeakSet<object>();

/** Replaces the target's `getStructTree` so a rejected read resolves to null. */
export function guardStructTree(target: StructTreeSource): void {
  const original = target.getStructTree;
  if (installedGuards.has(original)) return;

  const guarded = function (this: StructTreeSource): Promise<unknown> {
    return original.call(this).catch(() => null);
  };
  installedGuards.add(guarded);
  target.getStructTree = guarded;
}

/** True for anything that carries a callable `getStructTree`, such as pdf.js's page prototype. */
export function isStructTreeSource(value: unknown): value is StructTreeSource {
  return (
    typeof value === "object" && value !== null && "getStructTree" in value && typeof value.getStructTree === "function"
  );
}
