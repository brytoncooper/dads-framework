# @dads-framework/job-queue — background work

`JobQueue`: register typed definitions, start recurring schedules, enqueue
named work, inspect progress, and close on shutdown. Drivers by env:
`in-process` (tests/dev; non-durable) and `bullmq` (Redis; durable retries).
A job parses its payload and calls one mutation — business logic never lives
here. Each application owns a stable queue name; worker concurrency and Redis
history are bounded explicitly. See
`docs/reference/job-queue.md`.

The package re-exports job definitions and the queue contract from
[`@dads-framework/job-queue-core`](../job-queue-core/README.md). The shared
provider suite runs against the in-memory fake and the Redis-backed driver.
