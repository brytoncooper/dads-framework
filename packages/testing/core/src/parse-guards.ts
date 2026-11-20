/**
 * The two narrowings every reader of an untrusted document starts from.
 *
 * A `package.json`, a `tsconfig.json` and a `dads.testing.json` all arrive as
 * `unknown`, and each reader asks the same first question before it can ask any
 * other. Stating the answer once is what keeps "record" meaning an object that
 * is not an array in every reader this package owns.
 */

/** True when `value` is an object rather than `null` or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isUnknownArray(value);
}

/** True when `value` is an array whose elements have not been checked yet. */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
