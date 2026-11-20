/**
 * The one read failure that means "this file simply is not here".
 *
 * A receipt that has never been written and a skills directory that does not
 * exist yet are both normal, and both arrive as a thrown `ENOENT`. Every other
 * failure — a permission refusal, a directory where a file was expected — must
 * still reach the caller, so the question is asked in one place rather than
 * re-derived at each `catch`.
 */

/** True when `error` is a filesystem error reporting a missing path. */
export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
