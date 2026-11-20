# @dads-framework/email-delivery — durable outbound email

An outbound email is a ROW before it is a send: the row carries the template,
its props, the envelope, when it is due and how many attempts it has had, so a
crash loses nothing and a retry is a row update rather than a queue feature.

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
