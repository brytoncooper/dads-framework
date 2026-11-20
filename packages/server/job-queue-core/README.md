# @dads-framework/job-queue-core

Use `defineJob` to declare a job and accept `JobQueue` wherever a feature
submits one. Applications can create a queue with
[`@dads-framework/job-queue`](../job-queue/README.md).

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/job-queue-core zod@4
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { defineJob } from "@dads-framework/job-queue-core";
import { FakeJobQueue } from "@dads-framework/job-queue-core/testing";
import { z } from "zod";

const queue = new FakeJobQueue("reports");
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
  await queue.runEnqueued();
} finally {
  await queue.close();
}
console.log((await queue.inspect()).counts.completed);
```

The script prints `Report daily is ready` and `1` completed job. The fake records enqueues and runs handlers when the test calls `runEnqueued()`.

The starter defines a job that computes the size and SHA-256 digest of a stored note attachment. [`apps/kit-workbench/domains/notes/server/attachments.ts`](../../../apps/kit-workbench/domains/notes/server/attachments.ts)

## Provider contract

Register job definitions before starting the queue. Job names and schedule ids
must be unique. Payload parsing belongs to the job definition. Queue inspection
includes metadata and counts. The testing export includes the in-memory queue
and shared laws for registration, enqueueing, and payload execution.

## From definition to execution

Define the job with its stable name, Zod payload schema, retry policy, and
handler. Register the definition before starting the queue. Use the same
definition and payload contract with the in-memory test queue and the
application's production queue.
