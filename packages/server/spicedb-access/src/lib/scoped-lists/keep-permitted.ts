/**
 * The page re-check behind every scoped list. The scope predicate decides
 * which rows SQL reads and counts; this decides which of the page's rows the
 * caller sees. So a wrong plan or a wrong SQL binding can mis-count a list or
 * leave a page short, but it can never show a row the caller may not view.
 */
import type { PermissionToken } from "@dads-framework/access";

import type { PermissionQuery, SubjectRef } from "@dads-framework/access/runtime";
import { checkAll } from "../access/check-all.js";

/**
 * The checks a page re-check needs. `Authorization` satisfies it; when the
 * adapter offers the optional bulk `checkMany`, the page is asked in batches.
 */
export type PageCheck = {
  check(query: PermissionQuery): Promise<boolean>;
  checkMany?(queries: readonly PermissionQuery[]): Promise<readonly boolean[]>;
};

/** Bulk batches stay within one SpiceDB request each. */
const BULK_CHECK_SIZE = 128;
/** Without bulk checks, a page asks this many single checks at once. */
const SINGLE_CHECK_CONCURRENCY = 16;

/**
 * Keep the rows the subject holds `permission` on, in their SQL order. A row
 * whose decision is missing is dropped, never kept.
 */
export async function keepPermitted<Row extends { readonly id: string }>(
  authorization: PageCheck,
  subject: SubjectRef,
  permission: PermissionToken,
  rows: readonly Row[],
): Promise<readonly Row[]> {
  const kept: Row[] = [];
  const batchSize = authorization.checkMany === undefined ? SINGLE_CHECK_CONCURRENCY : BULK_CHECK_SIZE;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const queries = batch.map((row): PermissionQuery => ({
      subject,
      permission: permission.permissionName,
      resource: { type: permission.entityWireName, id: row.id },
    }));
    const allowed = await checkAll(authorization, queries);
    batch.forEach((row, index) => {
      if (allowed[index] === true) {
        kept.push(row);
      }
    });
  }
  return kept;
}
