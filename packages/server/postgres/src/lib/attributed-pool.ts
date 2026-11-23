/**
 * The attributed pool: every connection checkout carries who is writing.
 *
 * ADR-0112 makes attribution a property of the CONNECTION rather than of the
 * call site. The `audit_record` trigger reads `dads.audit_actor` out of the
 * session and refuses any write that reaches it unattributed, so something has
 * to put the actor there before the caller's first statement. That something
 * lives here, because the checkout is the one place every writer passes
 * through: Drizzle's plain statements (`pool.query`), Drizzle's transactions
 * (`pool.connect()` then `begin`), `PostgresOwnerLock`, and the Better Auth
 * adapter all share this single pool object.
 *
 * Three decisions worth keeping:
 *
 * - **A subclass of `pg.Pool`, not a delegating wrapper.** Drizzle decides
 *   whether its client is a pool with `client instanceof Pool`, and only then
 *   runs a transaction on ONE checked-out client; a wrapper object would send
 *   `begin`, the statements, and `commit` down three different connections.
 *   Subclassing also keeps `$client: Pool` on the Drizzle handle honest with
 *   no cast.
 * - **`connect` is the only override.** `pg.Pool.prototype.query` is itself
 *   connect → query → release, so inheriting it stamps the single-statement
 *   path for free and leaves pg's own release-on-error semantics as pg's,
 *   instead of a re-implementation that has to be kept in step with them.
 * - **Session level (`set_config(..., false)`), re-stamped on every
 *   checkout.** Most writes in this codebase are a lone `insert` with no
 *   transaction, so `SET LOCAL` would be gone before the statement ran. The
 *   flip side is that a released client keeps the setting — which is exactly
 *   why the next checkout overwrites it, including with `''` when no actor is
 *   in force, so one request can never inherit the previous one's identity.
 *
 * Cost: one extra round trip per checkout, never per statement.
 */

import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  AUDIT_ACTOR_SETTING,
  serializeAuditActor,
  type AuditActor,
} from "@dads-framework/core/audit-actor";

import { countStatementsOn } from "./counting-client.js";

/**
 * Where the pool reads the actor at checkout time. Production passes
 * `currentAuditActor`; tests pass a source that falls back to a system actor.
 * A source that returns `undefined` stamps the empty string, which is the
 * value the trigger refuses.
 */
export type AuditActorSource = () => AuditActor | undefined;

/**
 * The stamp, spelled once. `false` is `is_local`: the setting outlives the
 * statement so a later single-statement write on the same client still sees
 * it. Parameterised rather than interpolated — the actor JSON carries user
 * input in `reason`.
 */
export const AUDIT_ACTOR_STAMP_SQL = "select set_config($1, $2, false)";

/**
 * The part of any client the stamp touches. Narrow on purpose: it is what lets
 * the stamp be proved without a database, and it is satisfied by both a pooled
 * `PoolClient` and a standalone `pg.Client` — which is how the migrator and the
 * one-shot scripts, which hold no pool, stamp themselves.
 */
export type ActorStampableClient = {
  query(text: string, values: string[]): Promise<unknown>;
};

/**
 * The part of a checked-out client the pool's stamp touches: it also has to be
 * releasable, because a failed stamp destroys the connection rather than
 * returning it.
 */
export type StampableClient = ActorStampableClient & {
  release(error?: Error): void;
};

/**
 * Sets `dads.audit_actor` on `client` to `actor`, or to the empty string —
 * the value the trigger refuses — when there is none. Exactly one statement,
 * so attributing a connection costs one round trip whatever the caller goes on
 * to do.
 *
 * Long-lived one-shot clients (the migration runner, the cutover, the seeds)
 * call this once after connecting; the setting is session level, so every
 * statement that follows on that connection carries it.
 */
export async function stampClientWithActor(
  client: ActorStampableClient,
  actor: AuditActor | undefined,
): Promise<void> {
  await client.query(AUDIT_ACTOR_STAMP_SQL, [
    AUDIT_ACTOR_SETTING,
    actor === undefined ? "" : serializeAuditActor(actor),
  ]);
}

/** The pool's form of the stamp: whoever the source names at checkout time. */
export async function stampAuditActor(
  client: StampableClient,
  actorSource: AuditActorSource,
): Promise<void> {
  await stampClientWithActor(client, actorSource());
}

/**
 * Checks a client out and stamps it before the caller can reach it.
 *
 * A client whose stamp failed is released WITH the error, so pg destroys it
 * instead of returning a connection carrying an unknown actor to the pool.
 * The original failure is what the caller sees.
 */
export async function checkOutStampedClient<TClient extends StampableClient>(
  checkOut: () => Promise<TClient>,
  actorSource: AuditActorSource,
): Promise<TClient> {
  const client = await checkOut();
  try {
    await stampAuditActor(client, actorSource);
  } catch (error) {
    client.release(asError(error));
    throw error;
  }
  // After the stamp, so the pool's own round trip is never charged to the
  // request, and once per client, because pg hands the same object out again.
  countStatementsOn(client);
  return client;
}

/**
 * The callback form of `pool.connect`. Nothing in this repository calls it,
 * but `pg.Pool.prototype.query` does — and that inherited `query` is half the
 * reason this class overrides only `connect`.
 */
type CheckoutCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (releaseError?: Error | boolean) => void,
) => void;

/**
 * A `pg.Pool` whose every checkout is stamped with the current audit actor.
 * Construct it with {@link createAttributedPool}.
 */
class AttributedPool extends Pool {
  readonly #actorSource: AuditActorSource;

  constructor(config: PoolConfig, actorSource: AuditActorSource) {
    super(config);
    this.#actorSource = actorSource;
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: CheckoutCallback): void;
  override connect(callback?: CheckoutCallback): Promise<PoolClient> | void {
    const checkedOut = checkOutStampedClient(
      () => super.connect(),
      this.#actorSource,
    );
    if (callback === undefined) return checkedOut;
    checkedOut.then(
      (client) => {
        // Released through an arrow rather than by handing over
        // `client.release`: the callback owns the release, and an arrow keeps
        // the method attached to the client it releases.
        callback(undefined, client, (releaseError) => {
          client.release(releaseError);
        });
      },
      (error: unknown) => {
        callback(asError(error), undefined, releaseNothing);
      },
    );
    return undefined;
  }
}

/**
 * The one construction point for an attributed pool. Takes the pool's config
 * rather than an existing pool: a subclass cannot adopt another instance's
 * identity, and identity is the point — Drizzle's `instanceof Pool` check and
 * the `$client: Pool` type both need this object to BE a pool.
 */
export function createAttributedPool(
  config: PoolConfig,
  actorSource: AuditActorSource,
): Pool {
  return new AttributedPool(config, actorSource);
}

/** There is no client to release when the checkout itself failed. */
function releaseNothing(): void {
  return undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
