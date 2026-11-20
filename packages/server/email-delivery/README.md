# @dads-framework/email-delivery — durable outbound email

Queue outbound mail durably so a business write and the message it creates
can commit together. The outbox row holds the template, properties, envelope,
due time, and attempt count.

The facade enqueues and dispatches, a delivery job renders and sends each
claimed row, a sweep job picks up what is due and fails stale claims, and
operator actions cover the rest. The application supplies an email sender, a
job queue, and a renderer when assembling these operations.

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
