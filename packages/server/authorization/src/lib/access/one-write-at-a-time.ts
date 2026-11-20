/**
 * Runs writes one after another, in the order they were asked for.
 *
 * Each write starts only once the one before it has settled, whether it
 * succeeded or failed, and a failure reaches only its own caller. This is
 * what lets every successful relationship write leave a token the adapter
 * can trust as the newest: with no two writes in flight together, the order
 * they finish in is the order they committed in.
 */
export class OneWriteAtATime {
  #last: Promise<unknown> = Promise.resolve();

  run<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#last.then(write, write);
    this.#last = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
