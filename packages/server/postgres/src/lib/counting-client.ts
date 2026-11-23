/**
 * Counting the statements a request actually issues.
 *
 * `request_log.duration_ms` has never said whether 900ms was three slow
 * queries or three hundred fast ones. This installs the counter at the one
 * place every statement passes through — the checked-out client — so the
 * answer arrives without a single call site changing.
 *
 * Three things about `pg` make this less obvious than it looks:
 *
 * - **`pool.query` uses the CALLBACK form.** `pg-pool` dispatches a plain
 *   statement as `client.query(text, values, callback)` and hands back its own
 *   promise, so a wrapper that only understood promises would silently stop
 *   counting the single-statement path — which is most of this codebase, since
 *   Drizzle issues its non-transactional queries that way.
 * - **A client outlives its checkout.** `pg` returns the same client object to
 *   the pool and hands it out again, so instrumenting on every checkout would
 *   wrap the wrapper and count one statement twice, then four times. The
 *   `WeakSet` below makes it once per client, for the life of that client.
 * - **`query` is overloaded eight ways** — text, config, values, callback,
 *   submittable. Rather than re-implement pg's overload resolution (and get it
 *   wrong the first time pg adds a shape), the wrapper forwards whatever it
 *   was given, untouched, and only decides how to learn that the statement
 *   finished. `Object.defineProperty` installs it for the same reason: it
 *   replaces the method without having to restate a signature this module has
 *   no business owning.
 *
 * The actor stamp is deliberately NOT counted: it is the pool's own cost, not
 * the request's, and it is issued before this wrapper is installed.
 */

import { chargeDatabaseQuery, countDatabaseQuery } from "@dads-framework/core/runtime/request-work";

/**
 * A function this module is willing to call with whatever it was handed.
 *
 * `pg` declares `query` eight overloaded ways. Rather than restate a signature
 * this module has no business owning — or reach for a cast, which the house
 * forbids — the shape is recovered with a type predicate: the check that it is
 * a function is what earns the right to forward arguments to it.
 */
type ForwardingCall = (...args: readonly unknown[]) => unknown;

function isForwardingCall(value: unknown): value is ForwardingCall {
  return typeof value === "function";
}

/**
 * Clients already carrying the counter. A `WeakSet` rather than a flag on the
 * client: it adds no property to an object `pg` owns, and it forgets the
 * client exactly when the client is collected.
 */
const instrumented = new WeakSet<object>();

/**
 * Installs the statement counter on `client`, once. Safe to call on every
 * checkout — the second call and every one after it do nothing.
 *
 * Takes any object so it can be proved against a hand-written client with no
 * database in sight, and does nothing to one that has no `query` to replace.
 */
export function countStatementsOn(client: object): void {
  if (instrumented.has(client)) return;
  if (!("query" in client)) return;
  const issueStatement: unknown = client.query;
  if (!isForwardingCall(issueStatement)) return;
  instrumented.add(client);
  Object.defineProperty(client, "query", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: countingQuery(issueStatement.bind(client)),
  });
}

function countingQuery(issueStatement: ForwardingCall): ForwardingCall {
  return (...args: readonly unknown[]): unknown => {
    const callback: unknown = args.at(-1);
    if (isForwardingCall(callback)) {
      return issueStatement(...chargedCallbackArgs(args, callback));
    }
    const outcome = issueStatement(...args);
    if (isThenable(outcome)) return chargeThenable(outcome);
    // A submittable (a cursor, a COPY stream) finishes on its own events
    // rather than on a promise or a callback. It is one statement either way,
    // so it is counted as one with no elapsed time attributed to it.
    countDatabaseQuery(0);
    return outcome;
  };
}

/**
 * The same arguments, with the caller's callback wrapped so the statement is
 * charged the moment `pg` reports it done — success or failure alike.
 */
function chargedCallbackArgs(args: readonly unknown[], callback: ForwardingCall): readonly unknown[] {
  const startedAt = performance.now();
  const charged = (...callbackArgs: readonly unknown[]): unknown => {
    countDatabaseQuery(performance.now() - startedAt);
    return callback(...callbackArgs);
  };
  return [...args.slice(0, -1), charged];
}

/** The promise form, charged through the shared wrapper so both agree. */
function chargeThenable(outcome: PromiseLike<unknown>): Promise<unknown> {
  return chargeDatabaseQuery(() => outcome);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
