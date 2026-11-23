import { ApplyAccessChangesAfterCommit } from "@dads-framework/access/runtime";
import type { ApplyAccessChanges } from "./apply.js";
import type { AccessChange } from "./enqueue.js";

export { ApplyAccessChangesAfterCommit } from "@dads-framework/access/runtime";

/**
 * A structural logger, declared here rather than imported so this battery
 * does not acquire an observability dependency for one call.
 */
export type DispatchLog = {
  warn(obj: object, msg?: string): void;
};

/**
 * How long a dispatch waits for its own facts while another worker projects
 * them: up to `checks` re-reads, `intervalMs` apart. `delay` is the pause
 * between them, injected so a test never sleeps.
 */
export type HeldClaimWait = {
  readonly checks: number;
  readonly intervalMs: number;
  readonly delay: (milliseconds: number) => Promise<void>;
};

/** About two seconds: 40 re-reads 50 ms apart. */
export const DEFAULT_HELD_CLAIM_CHECKS = 40;
export const DEFAULT_HELD_CLAIM_INTERVAL_MS = 50;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const DEFAULT_HELD_CLAIM_WAIT: HeldClaimWait = {
  checks: DEFAULT_HELD_CLAIM_CHECKS,
  intervalMs: DEFAULT_HELD_CLAIM_INTERVAL_MS,
  delay: pause,
};

/**
 * Projects the facts it is handed, then waits, briefly and boundedly, for
 * any of them another worker is projecting at that moment.
 *
 * The claim skips a fact another worker holds (a background projector's
 * batch, or a racing retry's own dispatch), so without the wait a request
 * would answer before its own grants reach the graph and read its record
 * back as missing. The wait:
 *
 * - costs nothing when the claim took every fact: no read, no pause;
 * - otherwise reads which facts are still held under a live lease (one
 *   indexed query), and pauses only while one is;
 * - watches only this request's facts, never other rows, and never claims
 *   or steals them: it only re-reads;
 * - stops at the bound (about 2 s), logs, and returns as before, so a stuck
 *   worker can never hang a save. A fact the holder releases unprojected
 *   ends the wait too: nobody is projecting it any more.
 */
class ApplyAccessChangesAfterCommitLive extends ApplyAccessChangesAfterCommit {
  constructor(
    private readonly projector: ApplyAccessChanges,
    private readonly log: DispatchLog,
    private readonly workerId: string,
    private readonly heldClaimWait: HeldClaimWait,
  ) {
    super();
  }

  async dispatch(entries: readonly AccessChange[]): Promise<void> {
    if (entries.length === 0) return;
    const idempotencyKeys = [...new Set(entries.map((entry) => entry.idempotencyKey))];
    try {
      const result = await this.projector.applyKeys({
        idempotencyKeys,
        workerId: this.workerId,
      });
      if (result.ok && result.value.failed > 0) {
        this.log.warn(
          { failed: result.value.failed, claimed: result.value.claimed },
          "authorization facts refused by the graph; left for replay",
        );
      }
      if (result.ok && result.value.claimed < idempotencyKeys.length) {
        await this.waitWhileHeldElsewhere(idempotencyKeys);
      }
    } catch (error) {
      this.log.warn(
        { error: String(error), facts: idempotencyKeys.length },
        "inline projection failed; facts remain PENDING for replay",
      );
    }
  }

  /**
   * Re-reads the facts still held under another worker's live lease until
   * none is, or the bound passes. This dispatch's own claims are settled by
   * now (projected, or released for replay), so a live lease is always
   * someone else's.
   */
  private async waitWhileHeldElsewhere(idempotencyKeys: readonly string[]): Promise<void> {
    let held = await this.projector.keysHeldByLiveClaims(idempotencyKeys);
    const { checks, intervalMs, delay } = this.heldClaimWait;
    for (let check = 1; check <= checks && held.length > 0; check += 1) {
      await delay(intervalMs);
      held = await this.projector.keysHeldByLiveClaims(held);
    }
    if (held.length > 0) {
      this.log.warn(
        {
          event: "authorization.dispatch.held_elsewhere",
          held: held.length,
          waitedMs: checks * intervalMs,
        },
        "another worker still holds this request's authorization facts; answering without them",
      );
    }
  }
}

export function createApplyAccessChangesAfterCommit(
  projector: ApplyAccessChanges,
  log: DispatchLog,
  workerId = "inline-dispatch",
  heldClaimWait: HeldClaimWait = DEFAULT_HELD_CLAIM_WAIT,
): ApplyAccessChangesAfterCommit {
  return new ApplyAccessChangesAfterCommitLive(projector, log, workerId, heldClaimWait);
}
