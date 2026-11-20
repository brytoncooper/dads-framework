# @dads-framework/job-queue — background work

`JobQueue`: register typed definitions, start recurring schedules, enqueue
named work, inspect progress, and close on shutdown. Drivers by env:
`in-process` (tests/dev; non-durable) and `bullmq` (Redis; durable retries).
A job parses its payload and calls one mutation — business logic never lives
here. Each application owns a stable queue name. Set worker concurrency and
Redis history bounds explicitly.

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

The starter creates the in-process queue and closes it when the service scope is disposed. [`apps/kit-workbench/assembly/local-services.ts`](../../../apps/kit-workbench/assembly/local-services.ts)

## Use it

Import `defineJob` and `JobQueue` from `@dads-framework/job-queue/core` in
features that declare jobs or accept a queue. The main entry point also
exports these contracts and provides `createJobQueue` for application wiring.

Install `bullmq@^5.79.3`, choose the `bullmq` driver, and supply `redisUrl`
when jobs must survive a process restart. The driver loads BullMQ on its
first Redis operation.

In tests, import `FakeJobQueue` from `@dads-framework/job-queue/testing`.
Call `runEnqueued()` to run recorded jobs. Custom drivers can use
`JobRegistry` from `@dads-framework/job-queue/core/provider` and verify
their contract with `jobQueueConformance` from
`@dads-framework/job-queue/core/testing`.

## What it refuses to do

The in-process driver keeps jobs and schedules in memory. Persistence and
retries require the BullMQ driver.

## Contract

Register job definitions before `start()`. Job names and schedule IDs
must be unique. Enqueue work by registered name. Queue inspection returns
job and schedule metadata and counts. `createJobQueue` throws for an empty
queue name or a BullMQ configuration without a Redis URL.
