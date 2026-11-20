# @dads-framework/job-queue-core

Use `defineJob` to declare a job and accept `JobQueue` wherever a feature
submits one. Applications can create a queue with
[`@dads-framework/job-queue`](../job-queue/README.md).

## Provider contract

Register job definitions before starting the queue. Job names and schedule ids
must be unique. Payload parsing belongs to the job definition. Queue inspection
includes metadata and counts. The testing export includes the in-memory queue
and shared laws for registration, enqueueing, and payload execution.
