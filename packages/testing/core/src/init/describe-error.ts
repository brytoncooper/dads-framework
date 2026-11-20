/**
 * How a caught failure is named in an init report.
 *
 * Reading a `package.json`, reading a `tsconfig.json` and writing the manifest
 * all catch whatever the platform threw and quote it back to the author. One
 * reading keeps a thrown non-Error from being called "unknown error" in one
 * sentence and something else in the next.
 */

/** `error.message` when there is one, and `unknown error` otherwise. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
