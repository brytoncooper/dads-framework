# @dads-framework/event-bus — domain-event bus

The `EventBus` seam for asynchronous cross-domain communication: domains
publish typed events; other domains declare `DomainEventReaction`s from
compose (handlers in `subscribers/`). In-process notifications today — not
guaranteed delivery. A durable outbox is a separate architecture change,
not an adapter swap
(docs/architecture/api-domains.md#asynchronous-domain-events).
