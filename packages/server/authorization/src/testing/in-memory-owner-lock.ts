import { OwnerLock } from "@dads-framework/access/runtime";

/** Deterministic process-local equivalent of the Postgres partition lock. */
export class InMemoryOwnerLock extends OwnerLock {
  private readonly tails = new Map<string, Promise<void>>();

  protected async runLocked<T>(
    ownerPartitionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(ownerPartitionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(ownerPartitionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(ownerPartitionId) === tail) {
        this.tails.delete(ownerPartitionId);
      }
    }
  }
}
