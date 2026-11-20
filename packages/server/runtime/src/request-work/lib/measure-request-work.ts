/**
 * What did this cost? — the testing form of the tally.
 *
 * Runs `work` in a scope of its own and returns only the tally, because the
 * question a query-budget test asks is about the cost and not the answer. A
 * test that wants both uses `measureWork`.
 */

import { measureWork, type RequestWorkTally } from "./request-work-tally.js";

export async function measureRequestWork(
  work: () => unknown,
): Promise<RequestWorkTally> {
  const { tally } = await measureWork(work);
  return tally;
}
