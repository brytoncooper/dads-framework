import type { SpiceDbConsistencyToken } from "@dads-framework/access/runtime";

/**
 * The ZedToken of the newest relationship write this process made, so that
 * enforcement reads can ask SpiceDB for `at_least_as_fresh` than it and be
 * served from SpiceDB's cache instead of walking the datastore every time.
 *
 * ZedTokens are opaque, so two tokens cannot be compared. What this process
 * can know is the order its own writes finished in: a write that started
 * after every earlier write had finished committed after all of them, so its
 * token covers every write before it. A write that overlapped another one
 * gives no such order — the revision is fixed somewhere inside the call — so
 * it leaves no trusted token at all, and enforcement falls back to a fully
 * consistent read until the next write that overlapped nothing. A failed
 * write may still have committed, so it clears the token the same way. An
 * older token therefore never replaces a newer one: it is either provably
 * newest or forgotten.
 *
 * `SpiceDbAuthorization` runs its writes one at a time, so overlap should
 * never happen there; the check stays as the safety net if it ever does.
 *
 * Process-local on purpose (see `docs/architecture/authorization.md#consistency`):
 * the API refuses to boot as more than one instance while this is the only
 * record of the newest write.
 * TODO(second API instance): persist the newest token in Postgres, written
 * where the tuples are written and read once per request, before
 * `API_MAX_INSTANCES` may exceed 1.
 */
export class NewestWrittenToken {
  #finishedWrites = 0;
  #token: SpiceDbConsistencyToken | undefined;

  /** The token every enforcement read may be at least as fresh as; none means read fully consistent. */
  current(): SpiceDbConsistencyToken | undefined {
    return this.#token;
  }

  /** Runs one relationship write and keeps its token only when it is provably the newest. */
  async track<T>(write: () => Promise<T>, tokenOf: (response: T) => SpiceDbConsistencyToken): Promise<T> {
    const finishedBeforeStart = this.#finishedWrites;
    let written: SpiceDbConsistencyToken | undefined;
    try {
      const response = await write();
      const token = tokenOf(response);
      written = token.length > 0 ? token : undefined;
      return response;
    } finally {
      const overlappedAnotherWrite = this.#finishedWrites !== finishedBeforeStart;
      this.#finishedWrites += 1;
      this.#token = overlappedAnotherWrite ? undefined : written;
    }
  }

  /** Forgets the token, for a change the token does not describe (a schema write). */
  forget(): void {
    this.#finishedWrites += 1;
    this.#token = undefined;
  }
}
