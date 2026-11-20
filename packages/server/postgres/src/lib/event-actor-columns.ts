/**
 * How an event actor is spelled in columns.
 *
 * Five append-only event tables across four domains — organization membership,
 * facility membership, platform staff, support session, platform work
 * assignment — carry the same column trio: `actor_type`, `actor_user_id`,
 * `actor_system`. Splitting the actor rather than storing one
 * `actor_subject_id` is deliberate: SCIM, JIT SSO, and the expiry sweep act
 * without a human, and "the directory sync did this" must never be forced to
 * masquerade as a user id.
 *
 * The mapping from the union to those three columns was written out nine times
 * before 2026-08-17 — the same two ternaries, once per writer, with nothing
 * keeping them honest. It lives here because the trio is a persistence
 * CONVENTION shared across domains, the same kind of thing as
 * `loadPageAndTotal`, and because every one of those writers already depends on
 * this library for `DrizzleHandle` — so nothing gains a project edge by using
 * it.
 *
 * The actor UNION stays domain-owned. Each domain declares its own `EventActor`
 * (drizzle-kit loads schema files standalone, so storage vocabulary cannot be
 * centralized), and this function accepts the shape structurally rather than
 * importing any domain's copy.
 *
 * Deliberately NOT a row builder. Each table's other columns differ — the
 * parent id is named for its own aggregate, and only facility membership
 * carries `event_source` — so each domain keeps its own `eventValues` composer
 * and spreads this into it. And the event `id` is never produced here: ids are
 * minted at the call site, in view of the insert, which is the rule
 * an application can enforce.
 */

/** Exactly one of the two shapes — the union keeps both halves valid.
 * Generic over the user-id type so a domain whose union carries a branded
 * `UserId` keeps the brand through to its column, still without this kit
 * importing any domain's contract. */
export type PersistedEventActor<TUserId extends string = string> =
  | { readonly type: "USER"; readonly userId: TUserId }
  | { readonly type: "SYSTEM"; readonly system: string };

export type EventActorColumns<TUserId extends string = string> = {
  readonly actorType: "USER" | "SYSTEM";
  readonly actorUserId: TUserId | null;
  readonly actorSystem: string | null;
};

export function eventActorColumns<TUserId extends string>(
  actor: PersistedEventActor<TUserId>,
): EventActorColumns<TUserId> {
  return actor.type === "USER"
    ? { actorType: "USER", actorUserId: actor.userId, actorSystem: null }
    : { actorType: "SYSTEM", actorUserId: null, actorSystem: actor.system };
}
