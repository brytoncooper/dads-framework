import type { AccessChange } from "./access-changes.js";

/**
 * Project the facts a state change just enqueued, right after its transaction
 * commits.
 *
 * ## Why this exists at all
 *
 * A create writes its row and its authorization facts in ONE transaction,
 * which is the guarantee the outbox was built for. But a fact that is only
 * durable is not yet enforcement: until it reaches SpiceDB, nobody can reach
 * the resource — not the creator, not a platform admin, because
 * `parent_platform` is itself one of the enqueued tuples. The projector's job
 * definition has no recurring schedule yet, so "eventually" would mean "when
 * a human runs a dangerous operation". The request therefore projects its own
 * facts before it answers.
 *
 * ## What this is NOT
 *
 * It is not a second way to write tuples, and it is not a queue drain. It
 * holds no `Authorization` and no store: it delegates to the real projector,
 * which is the only thing that claims and settles. A producer therefore still
 * cannot mark a fact projected, which is the separation
 * `ClaimAccessChanges` was split out to protect.
 *
 * ## Failure is not the caller's problem
 *
 * `dispatch` never throws. By the time it runs, the row and its facts are
 * committed and the operation has already succeeded; the graph being
 * unreachable makes the grant late, not wrong. The outbox row stays PENDING
 * and the projector heals it on replay — which is exactly the property the
 * wave's demo milestone proves by killing this step and running the projector
 * by hand.
 *
 * Faked in testing/.
 */
export abstract class ApplyAccessChangesAfterCommit {
  abstract dispatch(entries: readonly AccessChange[]): Promise<void>;
}
