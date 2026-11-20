/** Structurally readable JavaScript object values, including arrays. */
export function isObjectValue(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
