/**
 * The one sentence a caught error contributes to a verification result.
 *
 * Running a task, executing a graph node, and reporting a graph all catch the
 * same throws and all have to name the failure the same way, including the
 * fallback for something that was thrown but is not an `Error`. Stating that
 * fallback once keeps the three from drifting into three different sentences.
 */

/** `error.message`, or a fixed sentence when a non-`Error` value was thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown verification failure.";
}
