/**
 * pg's unique-violation is SQLSTATE 23505. drizzle-orm ≥0.36 wraps driver
 * errors in DrizzleQueryError with the pg error on `cause` — so the check
 * walks the cause chain (a top-level-only check silently never fires; the
 * domain adapters' integration tests pin the wrapped case). Adapters map a
 * `true` here to a typed outcome; business code never sees pg codes
 * (docs/architecture/type-safety.md).
 */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
