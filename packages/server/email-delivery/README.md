# @dads-framework/email-delivery — durable outbound email

Queue outbound mail durably so a business write and the message it creates
can commit together. The outbox row holds the template, properties, envelope,
due time, and attempt count.

The facade enqueues and dispatches, a delivery job renders and sends each
claimed row, a sweep job picks up what is due and fails stale claims, and
operator actions cover the rest. The application supplies an email sender, a
job queue, and a renderer when assembling these operations.

## Try it

This local test uses an in-memory outbox, a manually drained queue, and a capturing sender. It requires no database or email provider.

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/email-delivery @dads-framework/email-sender-core @dads-framework/job-queue-core zod@4
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import {
  composeEmailDelivery,
  createEmailDelivery,
  type EmailTemplate,
  type RenderEmailTemplate,
} from "@dads-framework/email-delivery";
import { FakeOutboundEmailStore } from "@dads-framework/email-delivery/testing";
import { FakeEmailSender } from "@dads-framework/email-sender-core/testing";
import { FakeJobQueue } from "@dads-framework/job-queue-core/testing";
import { z } from "zod";

const notice: EmailTemplate = {
  name: "orders.pickup-ready",
  props: z.object({}),
  samples: { example: {} },
};
const render: RenderEmailTemplate = async () => ({
  subject: "Order ready",
  html: "<p>Your order is ready for pickup.</p>",
  text: "Your order is ready for pickup.",
});
const store = new FakeOutboundEmailStore();
const emailSender = new FakeEmailSender();
const jobQueue = new FakeJobQueue();
const deps = {
  store,
  emailSender,
  clock: { now: () => new Date() },
  render,
  log: console,
};
const emailDelivery = createEmailDelivery({ ...deps, jobQueue });
const catalog = {
  find: (name: string) => (name === notice.name ? notice : undefined),
};
jobQueue.register(
  composeEmailDelivery({ ...deps, emailDelivery, catalog }).jobs,
);

await jobQueue.start();
try {
  const { id } = await emailDelivery.enqueue(
    notice,
    {},
    {
      to: [{ address: "customer@example.com" }],
    },
  );
  console.log(store.find(id)?.status);
  await jobQueue.runEnqueued();
  console.log(store.find(id)?.status, emailSender.sent[0]?.subject);
} finally {
  await jobQueue.close();
}
```

The script prints `queued`, logs the delivery event, and prints
`sent Order ready` after the worker runs. The `sent` status records acceptance
by the fake sender. For durable delivery, use a PostgreSQL outbox and a durable
queue.

The starter binds the PostgreSQL outbox to its local spool sender and assembles the delivery jobs. [`apps/kit-workbench/assembly/local-mail.ts`](../../../apps/kit-workbench/assembly/local-mail.ts)

## Outbox persistence

`DrizzleOutboundEmailStore` binds the Postgres adapter to the outbox tables.
Use the adapter's database handle for ordinary delivery and pass the caller's
transaction when queueing an email must commit with a domain write. The
outbox validates the stored property object and recipient envelope
when it reads them.

## Deliver a message

1. Install the outbox schema with `installEmailDeliverySchemaV1` in a migration.
2. Create the facade with `createEmailDelivery`, supplying the store, sender,
   queue, clock, renderer, and logger. After collecting the domain templates,
   use `composeEmailDelivery` with the facade and template catalog to assemble
   the delivery and sweep jobs.
3. Queue the message in the business transaction when it must commit with a
   change. Register the delivery and sweep jobs with the application's queue.
4. Inspect the outbox record when a send fails. A stale send claim requires
   operator review because the provider may already have accepted the message.
