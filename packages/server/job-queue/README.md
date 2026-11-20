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

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/job-queue zod@4
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { createJobQueue, defineJob } from "@dads-framework/job-queue";
import { z } from "zod";

const queue = createJobQueue(
  { driver: "in-process", queueName: "reports" },
  {
    info: () => undefined,
    error: console.error,
  },
);
queue.register([
  defineJob({
    name: "report-ready",
    payload: z.object({ reportId: z.string() }),
    retry: { attempts: 1, backoffMs: 1 },
    schedules: [],
    run: async ({ reportId }) => {
      console.log(`Report ${reportId} is ready`);
    },
  }),
]);
await queue.start();
try {
  await queue.enqueue("report-ready", { reportId: "daily" });
} finally {
  await queue.close();
}
console.log((await queue.inspect()).counts.completed);
```

The script prints `Report daily is ready` and `1` completed job. The in-process driver finishes accepted work on close and runs without Redis.

## Use it

In an application, register its job definitions before `start()`, then
enqueue work by registered name. Choose `bullmq` and supply `redisUrl` when
jobs must survive a process restart.
