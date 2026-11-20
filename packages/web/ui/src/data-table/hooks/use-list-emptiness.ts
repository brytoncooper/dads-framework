import * as React from "react";

import {
  keepTableWhileChecking,
  type ListEmptiness,
  readListEmptiness,
} from "../lib/list-emptiness.js";

/**
 * {@link readListEmptiness} for a list page, remembering whether the page has
 * shown its table so a later narrowed zero keeps it (see
 * {@link keepTableWhileChecking}). Pass `undefined` until the list query has
 * answered: a pending list is not an empty one.
 *
 * `scope` is what the list is of — the business context, organization,
 * facility, or parent record — compared by value. A table shown for one scope
 * proves nothing about another, so a page that stays mounted while its scope
 * changes checks a narrowed zero again instead of showing "no matches" first.
 */
export function useListEmptiness(
  counts: Parameters<typeof readListEmptiness>[0] | undefined,
  scope: readonly unknown[],
): ListEmptiness | undefined {
  const emptiness =
    counts === undefined ? undefined : readListEmptiness(counts);
  const scopeKey = JSON.stringify(scope);
  // The scope the table was last shown for, if any.
  const [tableShownFor, setTableShownFor] = React.useState<string>();
  const tableShown = tableShownFor === scopeKey;

  const showsTable = emptiness === "HAS_ROWS" || emptiness === "NO_MATCHES";
  if (showsTable && !tableShown) setTableShownFor(scopeKey);
  if (emptiness === "ZERO" && tableShownFor !== undefined) {
    setTableShownFor(undefined);
  }

  return keepTableWhileChecking(emptiness, tableShown);
}
