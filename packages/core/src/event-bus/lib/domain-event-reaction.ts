import type { DomainEventHandler } from "./event-bus.js";

/**
 * A domain's declared reaction to a named event. Compose functions return
 * these as data; the composition root calls `EventBus.subscribe`.
 * `name` identifies the reaction in the API catalog and logs.
 */
export type DomainEventReaction = {
  readonly eventName: string;
  readonly name: string;
  readonly handler: DomainEventHandler;
};
