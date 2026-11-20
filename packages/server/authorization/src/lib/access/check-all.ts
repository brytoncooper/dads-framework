import type {
  Authorization,
  PermissionQuery,
} from "@dads-framework/access/runtime";

/**
 * Answers every query in input order: one `checkMany` where the adapter
 * offers it, else one `check` per query. Item failures follow
 * `Authorization.checkMany`'s own contract.
 */
export function checkAll(
  authorization: Pick<Authorization, "check" | "checkMany">,
  queries: readonly PermissionQuery[],
): Promise<readonly boolean[]> {
  return authorization.checkMany === undefined
    ? Promise.all(queries.map((query) => authorization.check(query)))
    : authorization.checkMany(queries);
}
