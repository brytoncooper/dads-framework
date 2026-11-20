# @dads-framework/job-queue — background work

`JobQueue`: register typed definitions, start recurring schedules, enqueue
named work, inspect progress, and close on shutdown. Drivers by env:
`in-process` (tests/dev; non-durable) and `bullmq` (Redis; durable retries).
A job parses its payload and calls one mutation — business logic never lives
here. Each application owns a stable queue name. Set worker concurrency and
Redis history bounds explicitly.

The package re-exports job definitions and the queue contract from
[`@dads-framework/job-queue-core`](../job-queue-core/README.md). The shared
provider suite runs against the in-memory fake and the Redis-backed driver.

## Start a local queue

```ts
import { createJobQueue } from "@dads-framework/job-queue";

const queue = createJobQueue(
  { driver: "in-process", queueName: "reports" },
  console,
);
try {
  await queue.start();
  console.log(await queue.inspect());
} finally {
  await queue.close();
}
```

In an application, register its job definitions before `start()`, then
enqueue work by registered name. Choose `bullmq` and supply `redisUrl` when
jobs must survive a process restart.
