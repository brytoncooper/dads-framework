import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { conflict, err, ok, type Result } from "@dads-framework/core/errors";
import type { ApplyAccessChanges, ApplyAccessChangesReport } from "./apply.js";
import type {
  AccessChangeCompletionStatusReader,
  RetryFailedAccessChanges,
  UnfinishedAccessChange,
} from "./completion-status.js";
import type { OwnerLock } from "@dads-framework/access/runtime";

export type CompleteAccessChangesInput = {
  readonly ownerPartitionIds: readonly string[];
  /** Starts another attempt budget only for the previously exhausted facts. */
  readonly retryFailed?: boolean;
  /**
   * Finish only these facts inside the named partitions. A request that must
   * not answer before its own facts land names them, so another caller's
   * backlog in the same partition is neither applied inside the request nor
   * able to fail it. Omitted, every unfinished fact in the partitions counts;
   * an empty list has nothing to finish.
   */
  readonly idempotencyKeys?: readonly string[];
};

/**
 * Returns success only after the named partitions — or, when the caller names
 * facts, those facts within them — have nothing unfinished. Callers must
 * release every lifecycle lease before invoking completion.
 */
export abstract class CompleteAccessChanges {
  abstract complete(input: CompleteAccessChangesInput): Promise<Result<void>>;
}

/**
 * How long completion waits for facts another live worker has claimed. Two
 * requests for one customer overlap routinely — Entra provisions in parallel —
 * and the other worker settles its claim in milliseconds, so refusing at once
 * turned ordinary overlap into a 409. Bounded well inside the request timeout.
 */
const OTHER_WORKER_WAIT_MS = 5_000;
const OTHER_WORKER_POLL_MS = 25;

type CompletionDependencies = {
  readonly statusReader: AccessChangeCompletionStatusReader;
  readonly retry: RetryFailedAccessChanges;
  readonly projector: Pick<ApplyAccessChanges, "applyKeys">;
  readonly ownerLock: OwnerLock;
  readonly createWorkerId?: () => string;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
};

class CompleteAccessChangesLive extends CompleteAccessChanges {
  constructor(private readonly dependencies: CompletionDependencies) {
    super();
  }

  async complete(input: CompleteAccessChangesInput): Promise<Result<void>> {
    const ownerPartitionIds = [...new Set(input.ownerPartitionIds)].sort();
    if (hasNothingToFinish(ownerPartitionIds, input.idempotencyKeys)) {
      return ok(undefined);
    }
    const named = namedFacts(input.idempotencyKeys);
    try {
      const unfinished = await this.readUnfinished(ownerPartitionIds, named);
      if (input.retryFailed === true) {
        await this.retryFailed(ownerPartitionIds, unfinished);
      }
      return await this.finish(ownerPartitionIds, named, unfinished);
    } catch {
      return incomplete();
    }
  }

  /**
   * Project what this worker can claim, then wait out facts another live
   * worker holds. A refused projection or an exhausted fact ends it at once:
   * nobody else is about to settle those.
   */
  private async finish(
    ownerPartitionIds: readonly string[],
    named: ReadonlySet<string> | null,
    firstUnfinished: readonly UnfinishedAccessChange[],
  ): Promise<Result<void>> {
    const now = this.dependencies.now ?? Date.now;
    const delay = this.dependencies.delay ?? sleep;
    const deadline = now() + OTHER_WORKER_WAIT_MS;
    let unfinished = firstUnfinished;
    for (;;) {
      const report = await this.project(unfinished);
      if (report === null) return incomplete();
      const remaining = await this.readUnfinished(ownerPartitionIds, named);
      if (remaining.length === 0) return ok(undefined);
      if (!heldByAnotherWorker(unfinished, report)) return incomplete();
      if (remaining.some((fact) => fact.status === "FAILED")) {
        return incomplete();
      }
      if (now() >= deadline) return incomplete();
      await delay(OTHER_WORKER_POLL_MS);
      unfinished = remaining;
    }
  }

  /** Null only when the projector refused facts it was handed. */
  private async project(
    unfinished: readonly UnfinishedAccessChange[],
  ): Promise<ApplyAccessChangesReport | null> {
    if (unfinished.length === 0) return { claimed: 0, projected: 0, failed: 0 };
    const projected = await this.dependencies.projector.applyKeys({
      idempotencyKeys: unfinished.map((fact) => fact.idempotencyKey),
      workerId: this.dependencies.createWorkerId?.() ?? randomUUID(),
    });
    return projected.ok ? projected.value : null;
  }

  /** The partitions' unfinished facts, narrowed to the named ones when given. */
  private async readUnfinished(
    ownerPartitionIds: readonly string[],
    named: ReadonlySet<string> | null,
  ): Promise<readonly UnfinishedAccessChange[]> {
    const unfinished = await this.dependencies.statusReader.readUnfinished({
      ownerPartitionIds,
    });
    if (named === null) return unfinished;
    return unfinished.filter((fact) => named.has(fact.idempotencyKey));
  }

  private async retryFailed(
    ownerPartitionIds: readonly string[],
    unfinished: readonly UnfinishedAccessChange[],
  ): Promise<void> {
    for (const ownerPartitionId of ownerPartitionIds) {
      const idempotencyKeys = unfinished
        .filter(
          (fact) =>
            fact.ownerPartitionId === ownerPartitionId &&
            fact.status === "FAILED",
        )
        .map((fact) => fact.idempotencyKey);
      if (idempotencyKeys.length === 0) continue;
      await this.dependencies.ownerLock.run(ownerPartitionId, (lease) =>
        this.dependencies.retry.retryFailed({
          ownerPartitionId,
          idempotencyKeys,
          lease,
        }),
      );
    }
  }
}

/** Creates strict completion without changing best-effort inline dispatch. */
export function createCompleteAccessChanges(
  dependencies: CompletionDependencies,
): CompleteAccessChanges {
  return new CompleteAccessChangesLive(dependencies);
}

/** No partitions, or the caller named an empty list of facts. */
function hasNothingToFinish(
  ownerPartitionIds: readonly string[],
  idempotencyKeys: readonly string[] | undefined,
): boolean {
  return ownerPartitionIds.length === 0 || idempotencyKeys?.length === 0;
}

/** The caller's named facts, or null when every unfinished fact counts. */
function namedFacts(
  idempotencyKeys: readonly string[] | undefined,
): ReadonlySet<string> | null {
  return idempotencyKeys === undefined ? null : new Set(idempotencyKeys);
}

/**
 * Some PENDING fact went unclaimed and nothing failed: another live worker
 * holds it. A FAILED fact is never claimable, so it does not count.
 */
function heldByAnotherWorker(
  unfinished: readonly UnfinishedAccessChange[],
  report: ApplyAccessChangesReport,
): boolean {
  const pending = unfinished.filter((fact) => fact.status === "PENDING");
  return report.failed === 0 && report.claimed < pending.length;
}

function incomplete(): Result<void> {
  return err(
    conflict(
      "AUTHORIZATION_ACCESS_CHANGES_INCOMPLETE",
      "Access changes are not yet enforced; retry provisioning",
      { retryable: true },
    ),
  );
}
