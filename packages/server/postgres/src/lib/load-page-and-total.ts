/**
 * The list-endpoint pair every reader repeats: the page of rows and the
 * total count run concurrently against the same WHERE, and a missing count
 * row (empty table) is zero, not undefined. The caller builds both queries —
 * this helper only owns the concurrency and the unwrap, so it can never
 * drift from what the adapter actually selects.
 */
export async function loadPageAndTotal<T>(
  rowsQuery: PromiseLike<T[]>,
  totalQuery: PromiseLike<{ total: number }[]>,
): Promise<{ rows: readonly T[]; total: number }> {
  const [rows, totals] = await Promise.all([rowsQuery, totalQuery]);
  return { rows, total: totals[0]?.total ?? 0 };
}

/** Zero-based SQL OFFSET from the API's one-based page convention. */
export function sqlOffsetForPage(page: number, perPage: number): number {
  return (page - 1) * perPage;
}
