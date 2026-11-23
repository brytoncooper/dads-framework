import type { Authorization } from "@dads-framework/access/runtime";
import type { ResourceLookup } from "@dads-framework/access/runtime";

/**
 * The list-query authorization dance, fail-closed: lookupResources yields
 * the subject's visible set, and an EMPTY set returns an empty page WITHOUT
 * calling `list` — this guard is the reason the helper exists (an empty
 * IN () clause is a classic widening footgun; empty means "sees nothing",
 * never "sees all" — docs/architecture/authorization.md). Filters inside
 * `list` narrow within the visible set, never widen.
 *
 * SUPERSEDED AT THE HTTP EDGE by the kit's `requireVisibility` access
 * declaration, which owns the same fail-closed dance and hands handlers the
 * visible set. This helper remains the pattern for NON-HTTP callers (jobs,
 * subscribers, future edges) that need a visibility-scoped list.
 */
export async function listOnlyVisible<T>(
  authorization: Authorization,
  lookup: ResourceLookup,
  list: (visibleIds: readonly string[]) => Promise<{ rows: readonly T[]; total: number }>,
): Promise<{ rows: readonly T[]; total: number }> {
  const visibleIds = await authorization.lookupResources(lookup);
  if (visibleIds.length === 0) {
    return { rows: [], total: 0 };
  }
  return list(visibleIds);
}
