import type { DomainEventHandler, EventBus } from "./event-bus.js";

/**
 * First adapter: in-process, sequential delivery. A throwing handler is
 * reported and isolated — it never fails the publishing request and never
 * starves later subscribers. Notification only; durability is a producer
 * outbox in the publishing mutation, not a harder in-process bus.
 */
export class InProcessEventBus implements EventBus {
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  constructor(
    private readonly onHandlerError: (
      eventName: string,
      error: unknown,
    ) => void,
  ) {}

  async publish(eventName: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(eventName) ?? []) {
      try {
        await handler(payload);
      } catch (error) {
        this.onHandlerError(eventName, error);
      }
    }
  }

  subscribe(eventName: string, handler: DomainEventHandler): void {
    const existing = this.handlers.get(eventName) ?? [];
    this.handlers.set(eventName, [...existing, handler]);
  }
}
