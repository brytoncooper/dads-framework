# @dads-framework/event-bus — domain-event bus

Publish a domain fact to other parts of the same process without coupling the
publisher to its subscribers. The composition root creates and registers
`DomainEventReaction` handlers. Subscribers parse payloads against their event
contract.

## Try it

```ts
import { createEventBus } from "@dads-framework/event-bus";

const bus = createEventBus(console);
bus.subscribe("reports.refreshed", (payload) => {
  console.log(payload);
  return Promise.resolve();
});
await bus.publish("reports.refreshed", { reportId: "daily-sales" });
```

## Delivery boundary

Delivery is in process. For events that must survive a restart, write a durable
outbox entry in the publishing transaction.
