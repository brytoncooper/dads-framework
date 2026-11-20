/**
 * The three narrowings every boundary reader in this package begins with.
 *
 * A project file, a recipe manifest and a verification receipt all arrive as
 * `unknown`, and each one asks the same first question: is this an object, an
 * array, or a string? Answering it once is what makes "record" mean the same
 * thing — an object that is not an array — in every reader the toolbox owns.
 */

/** True when `value` is an object rather than `null` or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is an array whose elements have not been checked yet. */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** True when `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}
