/**
 * The async cross-domain seam (docs/architecture/api-domains.md#asynchronous-
 * domain-events): domains publish past-tense facts with contract-shaped Zod
 * payloads; other domains declare reactions. Publishers never know their
 * consumers.
 *
 * In-process delivery is notification only. Guaranteed delivery needs a
 * transactional outbox in the publishing mutation — not a different
 * EventBus adapter.
 */
export type DomainEventHandler = (payload: unknown) => Promise<void>;

/**
 * Abstract class on purpose: it is both the TypeScript interface and the
 * wiring seam. Implemented by InProcessEventBus; constructed by the
 * composition root. Domains return DomainEventReaction data; the root
 * registers them with `subscribe`.
 */
export abstract class EventBus {
  /** Deliver a named fact to every subscriber. Payloads are contract-shaped. */
  abstract publish(eventName: string, payload: unknown): Promise<void>;
  /** Register a handler; subscribers parse the payload with the event's contract schema. */
  abstract subscribe(eventName: string, handler: DomainEventHandler): void;
}
