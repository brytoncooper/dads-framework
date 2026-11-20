import type { EventBus } from "./event-bus.js";
import { InProcessEventBus } from "./in-process-event-bus.js";

/**
 * Constructs the in-process EventBus. Handler failures go to the log,
 * never as unhandled rejections.
 */
export function createEventBus(log: {
  error(obj: object, msg?: string): void;
}): EventBus {
  return new InProcessEventBus((eventName, error) => {
    log.error(
      { event: "domain-event.handler-failed", eventName, err: error },
      "domain event handler failed",
    );
  });
}
