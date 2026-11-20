# @dads-framework/event-bus — domain-event bus

Publish a domain fact to other parts of the same process without coupling the
publisher to its subscribers. The composition root creates and registers
`DomainEventReaction` handlers. Subscribers parse payloads against their event
contract.

## Try it

In a Node.js 22+ project, install the package.

```sh
npm install @dads-framework/event-bus
```

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { createEventBus } from "@dads-framework/event-bus";

const bus = createEventBus(console);
bus.subscribe("reports.refreshed", (payload) => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("reportId" in payload) ||
    typeof payload.reportId !== "string"
  ) {
    throw new Error("Invalid reports.refreshed payload");
  }
  console.log(payload.reportId);
  return Promise.resolve();
});
await bus.publish("reports.refreshed", { reportId: "daily-sales" });
```

The subscriber prints `daily-sales` before `publish` resolves.

## Delivery boundary

Delivery is in process. For events that must survive a restart, write a durable
outbox entry in the publishing transaction.
