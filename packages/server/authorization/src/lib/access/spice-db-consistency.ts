import { v1 } from "@authzed/authzed-node";

import type { AuthorizationReadFreshness } from "@dads-framework/request-work";

import type {
  PermissionQuery,
  SpiceDbConsistencyToken,
} from "@dads-framework/access/runtime";
import type { ReadConsistencyDecision } from "@dads-framework/access/runtime";

/** SpiceDB's consistency requirements, built once for the adapter. */
export const FULLY_CONSISTENT = v1.Consistency.create({
  requirement: {
    oneofKind: "fullyConsistent",
    fullyConsistent: true,
  },
});

export function atLeastAsFresh(token: SpiceDbConsistencyToken): v1.Consistency {
  return v1.Consistency.create({
    requirement: {
      oneofKind: "atLeastAsFresh",
      atLeastAsFresh: v1.ZedToken.create({ token }),
    },
  });
}

/** A display-read decision as SpiceDB's requirement; none means minimize latency. */
export function toSpiceDbConsistency(
  decision: ReadConsistencyDecision,
): v1.Consistency | undefined {
  if (decision.kind === "fully-consistent") return FULLY_CONSISTENT;
  if (decision.kind === "at-least-as-fresh") {
    return atLeastAsFresh(decision.token);
  }
  return undefined;
}

/**
 * What a check or lookup sends: at least as fresh as the newest trusted
 * write, or fully consistent when the adapter is configured so or holds no
 * trusted token.
 */
export function enforcementRead(
  adapterConsistency: "minimize-latency" | "fully-consistent",
  newestToken: SpiceDbConsistencyToken | undefined,
): {
  readonly consistency: v1.Consistency;
  readonly freshness: AuthorizationReadFreshness;
} {
  if (adapterConsistency === "fully-consistent" || newestToken === undefined) {
    return { consistency: FULLY_CONSISTENT, freshness: "fully-consistent" };
  }
  return { consistency: atLeastAsFresh(newestToken), freshness: "cached" };
}

/**
 * A check's requirement: fully consistent when any query asks for it (a
 * batch reads at one requirement), else the adapter's enforcement read.
 */
export function askedConsistency(
  queries: readonly Pick<PermissionQuery, "consistency">[],
  enforcement: () => v1.Consistency,
): v1.Consistency {
  return queries.some((query) => query.consistency === "fully-consistent")
    ? FULLY_CONSISTENT
    : enforcement();
}
